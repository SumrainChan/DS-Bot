import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, LlmError, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import * as Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Query from '@deepseek-ai/dsh-session-query-sqlite'
import Policy from '@deepseek-ai/dsh-sandbox-policy'
import { SessionId } from '@deepseek-ai/dsh-session'
import Subagents from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import Approval from '@deepseek-ai/dsh-user-approval'
import { createTaskExecutor } from '../src/host/task-executor.js'

const id = () => randomUUID()
const text = value => [{ type: 'text', text: value }]
const message = value => createUserMessage({ source: { kind: 'user' }, content: text(value) })
const flatten = value => JSON.stringify(value)
const gate = () => {
  let open
  const promise = new Promise(resolve => { open = resolve })
  return { promise, open }
}
const tool = name => ({
  name, description: 'Task scope test tool', parameters: { type: 'object', properties: {}, additionalProperties: false },
  output: { schema: { type: 'boolean' }, render: () => text('ok') }, execute: async () => true,
})

class ScriptedAdapter extends LlmAdapter {
  calls = []
  holds = new Map()
  starts = new Map()
  script
  async resolveModel(provider, model) {
    return { provider, id: model, name: model, reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } }
  }
  hold(model) {
    const held = gate()
    this.holds.set(model, held)
    return held
  }
  started(model) {
    if (this.calls.some(call => call.model === model)) return Promise.resolve()
    if (!this.starts.has(model)) this.starts.set(model, gate())
    return this.starts.get(model).promise
  }
  async *stream(options) {
    this.calls.push({ model: options.model, provider: options.provider, reasoningEffort: options.reasoningEffort, messages: options.messages, tools: options.tools })
    this.starts.get(options.model)?.open()
    const scripted = this.script?.(options, this.calls.filter(call => call.model === options.model).length)
    if (scripted !== undefined) { yield* scripted; return }
    const held = this.holds.get(options.model)
    if (held !== undefined) {
      await new Promise((resolve, reject) => {
        const abort = () => reject(options.signal.reason)
        if (options.signal.aborted) return abort()
        options.signal.addEventListener('abort', abort, { once: true })
        held.promise.then(() => { options.signal.removeEventListener('abort', abort); resolve() })
      })
    }
    if (options.model === 'failure') throw new LlmError('Scripted task failure', 'TASK_TEST_FAILURE')
    const output = `OUTPUT:${options.model}`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: output }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: output } }
    yield { type: 'finish', reason: { kind: options.model === 'truncated' ? 'max-tokens' : 'stop' } }
  }
}

async function setup(t, callbacks = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ds-bot-task-executor-'))
  const projectRoot = join(root, 'project')
  await mkdir(projectRoot)
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = join(root, '.dsh-test-task-executor')
  const ctx = new Context()
  const adapter = new ScriptedAdapter()
  const results = [], changes = [], waiting = new Map()
  let executor
  t.after(async () => {
    try {
      await executor?.dispose()
    } finally {
      await ctx.fiber.dispose()
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      assert.ok(resolve(root).startsWith(resolve(join(tmpdir(), 'ds-bot-task-executor-'))))
      await rm(root, { recursive: true, force: true })
    }
  })
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(Policy, { mode: 'read-only', workspaceRoot: projectRoot }).await()
  await ctx.plugin(Approval, { policy: 'never' }).await()
  await ctx.plugin(Persistence, { root: join(root, 'sessions'), compression: 'none' }).await()
  await ctx.plugin(Query, { path: ':memory:', openAt: 'never' }).await()
  ctx.llm.registerAdapter(['task-test', 'task-other'], adapter)
  await mountAgentLoopTestHarness(ctx)
  await ctx.plugin(Subagents, { maxDepth: 3, maxActiveSubagents: 12 }).await()
  await ctx.plugin(Spawn, { providerName: 'spawn' }).await()
  assert.ok(ctx.subagents?.getProvider('spawn'))
  await ctx.plugin({ name: 'task-executor-test', apply(pluginCtx) {
    executor = createTaskExecutor(pluginCtx, {
      configureAgent: callbacks.configureAgent,
      onChange(record, patch) { changes.push({ record, patch }); return callbacks.onChange?.(record, patch) },
      async onResult(record, result) {
        results.push({ record, result })
        await callbacks.onResult?.(record, result)
        waiting.get(record.id)?.open(result)
      },
    })
  } }).await()
  const record = async (overrides = {}) => {
    const runId = id(), cwd = join(projectRoot, runId)
    await mkdir(cwd)
    const entry = { id: runId, ownerBotId: 'chief', hostSessionId: id(), sessionId: id(), provider: 'task-test', model: runId, cwd, projectRoot, sandboxMode: 'read-only', approvalPolicy: 'never', instructions: `ROLE:${runId}`, brief: `BRIEF:${runId}`, ...overrides }
    waiting.set(entry.id, gate())
    return entry
  }
  const resultOf = entry => {
    const previous = results.find(item => item.record.id === entry.id)
    return previous === undefined ? waiting.get(entry.id).promise : Promise.resolve(previous.result)
  }
  return { ctx, adapter, executor, record, resultOf, results, changes, projectRoot, root }
}

const options = { timeout: 10000 }

function* textResponse(value) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text: value }
  yield { type: 'block-end', index: 0, block: { type: 'text', text: value } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

test('start accepts before completion, awaits configuration, and uses a non-reasoning stable host', options, async t => {
  const configuring = gate(), configured = gate()
  const r = await setup(t, { async configureAgent(agent) { configuring.open(); await configured.promise; agent.ctx.tools.register(tool('configured_task_tool')) } })
  const record = await r.record({ model: 'configured' })
  const held = r.adapter.hold(record.model)
  const pending = r.executor.start(record)
  assert.equal(r.executor.ownsSession(record.sessionId), true)
  await configuring.promise
  assert.equal(r.executor.isHostSession(record.hostSessionId), true)
  assert.equal(r.adapter.calls.length, 0)
  configured.open()
  const metadata = await pending
  await r.adapter.started(record.model)
  assert.equal(metadata.childId, record.sessionId)
  assert.equal(metadata.hostSessionId, record.hostSessionId)
  assert.equal(typeof metadata.runId, 'string')
  assert.ok(metadata.runId.length > 0)
  assert.equal(typeof metadata.messageId, 'string')
  assert.equal(r.results.length, 0)
  assert.ok(r.adapter.calls[0].tools.some(item => item.name === 'configured_task_tool'))
  assert.ok(flatten(r.adapter.calls[0]).includes(record.instructions))
  assert.ok(flatten(r.adapter.calls[0]).includes(record.brief))
  const host = r.ctx.agents.get(record.hostSessionId)
  host.followup(message('AUTOMATIC_DRIVER_MUST_NOT_START_MODEL'))
  await host.whenIdle()
  assert.equal(r.adapter.calls.length, 1)
  held.open()
  assert.equal((await r.resultOf(record)).stopReason, 'completed')
})

test('fresh native workers omit caller and sibling history while preserving explicit role and brief', options, async t => {
  const r = await setup(t)
  const caller = await r.ctx.agents.create({ sessionId: SessionId(id()), meta: { cwd: r.projectRoot }, agentOptions: { provider: 'task-test', model: 'chat-model' } })
  caller.agent.followup(message('PRIVATE_CALLER_MARKER'))
  await caller.agent.whenIdle()
  const first = await r.record({ model: 'first', brief: 'FIRST_PRIVATE_BRIEF' })
  await r.executor.start(first)
  await r.resultOf(first)
  const second = await r.record({ model: 'second', hostSessionId: first.hostSessionId })
  await r.executor.start(second)
  await r.resultOf(second)
  const input = flatten(r.adapter.calls.find(call => call.model === 'second'))
  assert.ok(input.includes(second.instructions))
  assert.ok(input.includes(second.brief))
  assert.ok(!input.includes('PRIVATE_CALLER_MARKER'))
  assert.ok(!input.includes('FIRST_PRIVATE_BRIEF'))
  assert.ok(!input.includes('OUTPUT:first'))
  await caller.dispose()
})

test('parallel workers retain local model, effort, effective cwd, project header and policies', options, async t => {
  const configured = new Map()
  let r
  r = await setup(t, { configureAgent(agent, record) {
    configured.set(record.id, { mode: r.ctx.sandboxPolicy.resolve({ session: agent.session }).mode, approval: r.ctx.approval.overrideOf(agent.session) })
  } })
  const a = await r.record({ model: 'model-A', effort: 'high' })
  const b = await r.record({ model: 'model-B', provider: 'task-other', effort: 'low', hostSessionId: a.hostSessionId, sandboxMode: 'workspace-write', approvalPolicy: 'ask' })
  const heldA = r.adapter.hold(a.model), heldB = r.adapter.hold(b.model)
  await Promise.all([r.executor.start(a), r.executor.start(b)])
  await Promise.all([r.adapter.started(a.model), r.adapter.started(b.model)])
  for (const record of [a, b]) {
    const agent = r.ctx.agents.get(record.sessionId)
    assert.equal(agent.session.header.cwd, record.projectRoot)
    assert.equal(r.ctx.workingDirectory.get(agent.session), record.cwd)
    assert.deepEqual(configured.get(record.id), { mode: record.sandboxMode, approval: record.approvalPolicy })
    assert.equal(agent.model.current().reasoningEffort, record.effort)
  }
  heldA.open(); heldB.open()
  await Promise.all([r.resultOf(a), r.resultOf(b)])
  for (const record of [a, b]) {
    const actual = r.changes.find(item => item.record.id === record.id && item.patch.actualModel)?.patch.actualModel
    assert.deepEqual(actual, { provider: record.provider, model: record.model, reasoningEffort: record.effort })
  }
  assert.equal(r.ctx.agents.get(a.hostSessionId).model.current().model, a.model)
})

test('cancel stops the exact running activation and leaves its sibling running', options, async t => {
  const r = await setup(t)
  const a = await r.record({ model: 'cancel-me' })
  const b = await r.record({ model: 'keep-me', hostSessionId: a.hostSessionId })
  r.adapter.hold(a.model)
  const heldB = r.adapter.hold(b.model)
  await Promise.all([r.executor.start(a), r.executor.start(b)])
  await Promise.all([r.adapter.started(a.model), r.adapter.started(b.model)])
  assert.equal((await r.executor.cancel(a)).requested, true)
  assert.equal((await r.resultOf(a)).stopReason, 'aborted')
  assert.equal(r.ctx.agents.get(b.sessionId).status, 'running')
  assert.ok(!r.results.some(item => item.record.id === b.id))
  heldB.open()
  assert.equal((await r.resultOf(b)).stopReason, 'completed')
})

test('configuration failure rejects startup before any worker request', options, async t => {
  const r = await setup(t, { configureAgent() { throw new Error('SCRIPTED_CONFIGURATION_FAILURE') } })
  const record = await r.record({ model: 'never-starts' })
  await assert.rejects(r.executor.start(record), /SCRIPTED_CONFIGURATION_FAILURE/)
  assert.equal(r.adapter.calls.length, 0)
  assert.equal(r.ctx.agents.get(record.sessionId), undefined)
  assert.equal(r.results.length, 0)
})

test('stable host and native child survive unrelated caller destruction and accept steer', options, async t => {
  const r = await setup(t)
  const caller = await r.ctx.agents.create({ sessionId: SessionId(id()), meta: { cwd: r.projectRoot }, agentOptions: { provider: 'task-test', model: 'caller-model' } })
  const record = await r.record({ model: 'long-worker' }), held = r.adapter.hold('long-worker')
  await r.executor.start(record)
  await r.adapter.started(record.model)
  await caller.dispose()
  const receipt = await r.executor.steer(record, 'AFTER_CALLER_PART_SWITCH')
  assert.equal(receipt.childId, record.sessionId)
  assert.equal(typeof receipt.messageId, 'string')
  held.open()
  assert.equal((await r.resultOf(record)).stopReason, 'completed')
  assert.ok(r.adapter.calls.some(call => flatten(call).includes('AFTER_CALLER_PART_SWITCH')))
  assert.ok(r.ctx.agents.get(record.hostSessionId))
  await assert.rejects(r.executor.steer(record, 'NO_IMPLICIT_RESUME'), /terminal|no longer live/)
})

test('original execution failure and token truncation remain distinct from completion', options, async t => {
  const r = await setup(t)
  const a = await r.record({ model: 'failure' }), b = await r.record({ model: 'truncated' })
  await Promise.all([r.executor.start(a), r.executor.start(b)])
  assert.equal((await r.resultOf(a)).stopReason, 'error')
  assert.equal((await r.resultOf(b)).stopReason, 'max-tokens')
  assert.ok(flatten((await r.resultOf(b)).output).includes('OUTPUT:truncated'))
})

test('nested runs use the live parent worker and reject unrelated or incompatible parents', options, async t => {
  const r = await setup(t)
  const parent = await r.record({ model: 'coordinator', effort: 'high' }), held = r.adapter.hold('coordinator')
  await r.executor.start(parent)
  await r.adapter.started(parent.model)
  const child = await r.record({ model: 'leaf', parentRunId: parent.id, hostSessionId: parent.hostSessionId })
  const leafHeld = r.adapter.hold('leaf')
  await r.executor.start(child, parent)
  await r.adapter.started(child.model)
  const agent = r.ctx.agents.get(child.sessionId)
  assert.equal(agent.session.header.parentSession, parent.sessionId)
  assert.equal(agent.session.header.delegationDepth, 2)
  assert.equal(agent.model.current().reasoningEffort, undefined)
  const incompatible = await r.record({ parentRunId: parent.id, hostSessionId: parent.hostSessionId, projectRoot: join(r.root, 'different-root') })
  await assert.rejects(r.executor.start(incompatible, parent), /share its parent project root/)
  const missing = await r.record({ parentRunId: parent.id, hostSessionId: parent.hostSessionId })
  await assert.rejects(r.executor.start(missing), /exact parent record/)
  leafHeld.open(); await r.resultOf(child)
  held.open(); await r.resultOf(parent)
})

test('nested native notification resumes an idle coordinator and returns only its final synthesis', options, async t => {
  let r, parent, child
  r = await setup(t, { configureAgent(agent, record) {
    if (record.model !== 'coordinator-flow') return
    agent.ctx.tools.register({
      ...tool('start_nested_task'),
      output: { schema: { type: 'object' }, render: (_args, value) => text(JSON.stringify(value)) },
      execute: () => r.executor.start(child, parent),
    })
  } })
  parent = await r.record({ model: 'coordinator-flow' })
  child = await r.record({ model: 'delayed-leaf', parentRunId: parent.id, hostSessionId: parent.hostSessionId })
  const held = r.adapter.hold(child.model), acknowledged = gate()
  r.ctx.on('session/event', (session, event) => {
    if (session.id === parent.sessionId && event.type === 'turn/end') acknowledged.open()
  })
  r.adapter.script = (request, count) => {
    if (request.model !== parent.model) return undefined
    return (function* () {
      if (count === 1) {
        const callId = ToolCallId('task-executor-nested-start')
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id: callId, name: 'start_nested_task', argumentsDelta: '{}' }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name: 'start_nested_task', arguments: '{}' } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else if (request.messages.some(item => item.source?.kind === 'subagent-settled' && item.source.senderSessionId === child.sessionId)) {
        yield* textResponse('FINAL_SYNTHESIS_FROM_LEAF')
      } else {
        yield* textResponse('DISPATCH_ACK_ONLY')
      }
    })()
  }
  assert.equal((await r.executor.start(parent)).notification, 'caller')
  await r.adapter.started(child.model)
  await acknowledged.promise
  assert.equal(r.results.filter(item => item.record.id === parent.id).length, 0)
  assert.ok(r.ctx.agents.get(parent.sessionId))
  held.open()
  assert.equal((await r.resultOf(child)).stopReason, 'completed')
  const result = await r.resultOf(parent)
  assert.equal(result.stopReason, 'completed')
  assert.ok(flatten(result.output).includes('FINAL_SYNTHESIS_FROM_LEAF'))
  assert.ok(!flatten(result.output).includes('DISPATCH_ACK_ONLY'))
  assert.equal(r.results.filter(item => item.record.id === parent.id).length, 1)
  assert.equal(r.adapter.calls.filter(call => call.model === parent.model).length, 3)
})

test('cancellation during awaited initialization prevents any model request', options, async t => {
  const configuring = gate(), configured = gate()
  const r = await setup(t, { async configureAgent() { configuring.open(); await configured.promise } })
  const record = await r.record({ model: 'cancel-before-request' })
  const pending = r.executor.start(record)
  const rejected = assert.rejects(pending, /cancelled|cancel/i)
  await configuring.promise
  assert.equal((await r.executor.cancel(record)).requested, true)
  configured.open()
  await rejected
  assert.equal(r.adapter.calls.length, 0)
  assert.equal(r.results.length, 0)
  assert.equal(r.ctx.agents.get(record.sessionId), undefined)
})

test('an unavailable execution topology does not break constructing or disposing the optional executor', options, async () => {
  const ctx = new Context()
  const executor = createTaskExecutor(ctx)
  try {
    await assert.rejects(executor.start({ id: id(), sessionId: id(), hostSessionId: id() }), /needs the sandboxPolicy service/)
    await executor.dispose()
  } finally {
    await ctx.fiber.dispose()
  }
})

test('duplicate starts share one activation and disposal drains workers before stable hosts', options, async t => {
  const r = await setup(t)
  const record = await r.record({ model: 'held-until-disposal' })
  r.adapter.hold(record.model)
  const [a, b] = await Promise.all([r.executor.start(record), r.executor.start(record)])
  assert.equal(a.childId, b.childId)
  await r.adapter.started(record.model)
  assert.equal(r.adapter.calls.length, 1)
  const disposal = r.executor.dispose()
  assert.equal(r.executor.dispose(), disposal)
  await assert.rejects(r.executor.start(await r.record()), /disposed/)
  await disposal
  assert.equal((await r.resultOf(record)).stopReason, 'aborted')
  assert.equal(r.ctx.agents.get(record.sessionId), undefined)
  assert.equal(r.ctx.agents.get(record.hostSessionId), undefined)
  assert.equal(r.executor.ownsSession(record.sessionId), false)
})
