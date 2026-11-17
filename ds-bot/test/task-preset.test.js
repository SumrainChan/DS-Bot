import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Presets from '@deepseek-ai/dsh-agent-preset-registry'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import Policy from '@deepseek-ai/dsh-sandbox-policy'
import SandboxedFs from '@deepseek-ai/dsh-fs-sandbox'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import Approval from '@deepseek-ai/dsh-user-approval'
import { SessionId } from '@deepseek-ai/dsh-session'
import Subagents from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { createTaskExecutor } from '../src/host/task-executor.js'

const gate = () => { let open; const promise = new Promise(resolve => { open = resolve }); return { promise, open } }
const blocks = text => [{ type: 'text', text }]
class Adapter extends LlmAdapter {
  calls = []
  started = gate()
  release = gate()
  async resolveModel(provider, model) { return { provider, id: model, name: model } }
  async *stream(request) {
    this.calls.push(request)
    this.started.open()
    await new Promise((resolve, reject) => {
      const abort = () => reject(request.signal.reason)
      if (request.signal.aborted) return abort()
      request.signal.addEventListener('abort', abort, { once: true })
      this.release.promise.then(() => { request.signal.removeEventListener('abort', abort); resolve() })
    })
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'PRESET_WORKER_COMPLETE' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'PRESET_WORKER_COMPLETE' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ds-bot-task-preset-')))
  const projectRoot = join(root, 'project')
  await mkdir(projectRoot)
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = join(root, 'isolated-home')
  const ctx = new Context(), adapter = new Adapter(), completion = gate(), handles = []
  let executor
  t.after(async () => {
    try {
      await executor?.dispose()
      await Promise.all(handles.map(handle => handle.dispose()))
      await ctx.fiber.dispose()
    } finally {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      assert.ok(resolve(root).startsWith(resolve(join(tmpdir(), 'ds-bot-task-preset-'))))
      await rm(root, { recursive: true, force: true })
    }
  })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Policy, { mode: 'read-only', workspaceRoot: projectRoot }).await()
  await ctx.plugin(SandboxedFs, { cwd: projectRoot }).await()
  await ctx.plugin(WorkingDirectory, { defaultDirectory: projectRoot }).await()
  await ctx.plugin(Approval, { policy: 'never' }).await()
  ctx.llm.registerAdapter(['preset-test'], adapter)
  await mountAgentLoopTestHarness(ctx)
  await ctx.plugin(Loader, { baseUrl: import.meta.url }).await()
  await ctx.plugin(Presets, { default: 'engineering-fixture' }).await()
  await ctx.plugin(Subagents, { maxDepth: 3 }).await()
  await ctx.plugin(Spawn, { providerName: 'spawn' }).await()
  await ctx.plugin({ name: 'preset-task-executor-test', apply(pluginCtx) {
    executor = createTaskExecutor(pluginCtx, { onResult: (_record, result) => { completion.open(result) } })
  } }).await()
  const definition = write => ({
    id: 'engineering-fixture',
    plugins: [{ name: import.meta.resolve('@deepseek-ai/dsh-tool-fs'), config: { read: true, write, edit: write, readImage: false } }],
  })
  const declare = write => ctx.agentPresets.register(definition(write))
  const caller = async ({ composed = true } = {}) => {
    const handle = await ctx.agents.create({
      sessionId: SessionId(randomUUID()), meta: { cwd: projectRoot },
      agentOptions: { provider: 'preset-test', model: 'caller' },
      ...(composed ? { setup: async c => { await ctx.agentPresets.mount(c, 'engineering-fixture') } } : {}),
    })
    handles.push(handle)
    return handle
  }
  const record = callerSessionId => ({
    id: randomUUID(), callerSessionId, ownerBotId: 'fixture-owner', hostSessionId: randomUUID(), sessionId: randomUUID(),
    provider: 'preset-test', model: 'worker', cwd: projectRoot, projectRoot, sandboxMode: 'workspace-write', approvalPolicy: 'never',
    brief: 'Use only this isolated project.', instructions: 'A synthetic task.',
  })
  const execute = async (agent, name, args) => {
    const batch = await ctx.tools.execute({ agent, calls: [{ type: 'tool-call', id: ToolCallId(randomUUID()), name, arguments: JSON.stringify(args) }], signal: new AbortController().signal })
    return batch.results[0].result
  }
  return { ctx, adapter, executor, projectRoot, declare, caller, record, execute, completion }
}

const options = { timeout: 20000 }

test('stable host retains the actual caller preset revision and engineering tools after the caller part is disposed', options, async t => {
  const r = await fixture(t)
  const removeFirst = await r.declare(true)
  const caller = await r.caller()
  const originalWrite = r.ctx.tools.get('write', caller.agent)
  assert.ok(originalWrite)
  assert.equal(r.ctx.tools.get('write'), undefined, 'engineering tools exist only in the preset')
  await removeFirst()
  await r.declare(false)
  const newer = await r.caller()
  assert.equal(r.ctx.tools.get('write', newer.agent), undefined, 'the currently registered revision removed write')
  const record = r.record(caller.agent.id)
  await r.executor.start(record)
  await r.adapter.started.promise
  const host = r.ctx.agents.get(record.hostSessionId), worker = r.ctx.agents.get(record.sessionId)
  for (const agent of [host, worker]) {
    assert.equal(r.ctx.agentPresets.composedPreset(agent.ctx), 'engineering-fixture')
    assert.equal(r.ctx.tools.get('write', agent), originalWrite, 'joins the retained caller revision rather than current default')
    assert.equal(r.ctx.sandboxPolicy.resolve({ session: agent.session }).mode, 'workspace-write')
    assert.equal(r.ctx.approval.overrideOf(agent.session), 'never')
  }
  assert.ok(r.ctx.agents.roots().includes(host), 'stable host is a runtime root')
  assert.equal(worker.session.header.parentSession, host.id)
  assert.ok(r.adapter.calls[0].tools.some(tool => tool.name === 'read'))
  assert.ok(r.adapter.calls[0].tools.some(tool => tool.name === 'edit'))
  assert.ok(r.adapter.calls[0].tools.some(tool => tool.name === 'write'))
  await caller.dispose()
  assert.equal(r.ctx.agents.get(caller.agent.id), undefined)
  assert.equal(r.ctx.tools.get('write', worker), originalWrite)
  const target = join(r.projectRoot, 'task-result.txt')
  const written = await r.execute(worker, 'write', { file_path: target, content: 'Original task text.' })
  assert.equal(written.isError, false, JSON.stringify(written))
  const edited = await r.execute(worker, 'edit', { file_path: target, old_string: 'Original', new_string: 'Updated' })
  assert.equal(edited.isError, false, JSON.stringify(edited))
  const read = await r.execute(worker, 'read', { file_path: target })
  assert.equal(read.isError, false, JSON.stringify(read))
  assert.match(JSON.stringify(read), /Updated task text/)
  assert.equal(await readFile(target, 'utf8'), 'Updated task text.')
  const hostWrite = await r.execute(host, 'write', { file_path: join(r.projectRoot, 'host-must-not-write.txt'), content: 'Not allowed.' })
  assert.equal(hostWrite.isError, true)
  assert.match(JSON.stringify(hostWrite), /hosts do not execute tools/)
  host.followup(createUserMessage({ source: { kind: 'user' }, content: blocks('The host must not reason.') }))
  await host.whenIdle()
  assert.equal(r.adapter.calls.length, 1)
  r.adapter.release.open()
  assert.equal((await r.completion.promise).stopReason, 'completed')
  await r.executor.dispose()
  assert.equal(r.ctx.agents.get(host.id), undefined)
  assert.equal(r.ctx.agentPresets.composedPreset(host.ctx), undefined)
  assert.equal(r.ctx.tools.get('write', worker), undefined)
})

test('a preset deployment rejects a missing or preset-free actual caller before creating a host or worker', options, async t => {
  const r = await fixture(t)
  await r.declare(true)
  for (const callerSessionId of [undefined, randomUUID()]) {
    const record = r.record(callerSessionId)
    await assert.rejects(r.executor.start(record), /exact live calling Agent/)
    assert.equal(r.ctx.agents.get(record.hostSessionId), undefined)
    assert.equal(r.ctx.agents.get(record.sessionId), undefined)
  }
  const raw = await r.caller({ composed: false })
  const record = r.record(raw.agent.id)
  await assert.rejects(r.executor.start(record), /no retained preset composition/)
  assert.equal(r.ctx.agents.get(record.hostSessionId), undefined)
  assert.equal(r.adapter.calls.length, 0)
})
