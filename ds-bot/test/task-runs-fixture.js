import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, LlmError, createUserMessage } from '@deepseek-ai/dsh-llm'
import Policy from '@deepseek-ai/dsh-sandbox-policy'
import SandboxedFs from '@deepseek-ai/dsh-fs-sandbox'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import Approval from '@deepseek-ai/dsh-user-approval'
import * as Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Query from '@deepseek-ai/dsh-session-query-sqlite'
import { SessionId } from '@deepseek-ai/dsh-session'
import Subagents from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { createRuntime, inject } from '../index.js'

export const blocks = text => [{ type: 'text', text }]
export const userMessage = text => createUserMessage({ source: { kind: 'user' }, content: blocks(text) })
export const flattened = value => JSON.stringify(value)
export function gate() { let open; const promise = new Promise(resolve => { open = resolve }); return { promise, open } }
export async function until(read, label, timeout = 8000) {
  const start = Date.now()
  for (;;) {
    const value = await read()
    if (value) return value
    if (Date.now() - start > timeout) throw new Error(`Timed out: ${label}`)
    await delay(5)
  }
}
class ScriptedAdapter extends LlmAdapter {
  calls = []
  holds = new Map()
  outputs = new Map()
  models = ['chat', 'A', 'B', 'long', 'failure', 'truncated', 'coordinator', 'nested']
  async listModels(provider) { return this.models.map(id => ({ provider, id, name: id })) }
  async resolveModel(provider, model) { return { provider, id: model, name: model, reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } } }
  hold(model) { const held = gate(); this.holds.set(model, held); return held }
  started(model) { return until(() => this.calls.find(call => call.model === model), `${model} model request`) }
  async *stream(options) {
    this.calls.push({ sessionId: options.sessionId, model: options.model, provider: options.provider, reasoningEffort: options.reasoningEffort, messages: options.messages, tools: options.tools })
    const held = this.holds.get(options.model)
    if (held) await new Promise((resolve, reject) => {
      const abort = () => reject(options.signal.reason)
      if (options.signal.aborted) return abort()
      options.signal.addEventListener('abort', abort, { once: true })
      held.promise.then(() => { options.signal.removeEventListener('abort', abort); resolve() })
    })
    if (options.model === 'failure') throw new LlmError('Scripted integration failure', 'TASK_INTEGRATION_FAILURE')
    const output = options.purpose === 'compaction'
      ? ['Goals', 'Constraints and preferences', 'Progress', 'Decisions', 'Facts to keep', 'Open threads', 'Next step', 'Where to look'].map(name => `## ${name}\nSynthetic integration handoff.`).join('\n\n')
      : this.outputs.get(options.model) ?? `INTEGRATION_OUTPUT:${options.model}`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: output }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: output } }
    yield { type: 'finish', reason: { kind: options.model === 'truncated' ? 'max-tokens' : 'stop' } }
  }
}

// Session/Agent/loop, prompt/tools, sandboxed FS, policies, events, query and JSONL
// persistence are production services. Only the Web route transport, workspace
// registry, title display and Controller facade are shims; they delegate all
// Session creation, driving, model selection and reads to those real services.
export async function taskRunsFixture(t, { subagents = {}, prepare, config = {} } = {}) {
  const tempBase = await realpath(tmpdir())
  const root = await realpath(await mkdtemp(join(tempBase, 'ds-bot-task-runs-integration-')))
  const project = join(root, 'project'), home = join(root, 'data', 'bot')
  await mkdir(project, { recursive: true }); await mkdir(home, { recursive: true })
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = join(root, 'data')
  const ids = { chief: randomUUID(), other: randomUUID() }
  const seed = {
    version: 1, mainBotIds: [ids.chief], workspaceId: 'integration-project',
    bots: Object.fromEntries(Object.entries(ids).map(([name, id]) => [id, { id, sessionId: id, name: name === 'chief' ? 'Chief' : 'Other', role: 'Integration owner', model: 'integration/chat', instructions: name === 'chief' ? 'BOT_PRIVATE_INSTRUCTION_MARKER' : 'OTHER_BOT_INSTRUCTION_MARKER', workDir: project, createdAt: 1 }])),
    rooms: {}, agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, revision: 0,
  }
  await writeFile(join(home, 'state.json'), JSON.stringify(seed))
  const ctx = new Context(), adapter = new ScriptedAdapter(), handles = new Map(), pending = new Map(), routes = [], archived = new Set(), titles = new Map()
  let rt, runtimeFiber
  const stopRuntime = async () => { if (runtimeFiber) { const held = runtimeFiber; runtimeFiber = undefined; await held.dispose() } }
  t.after(async () => {
    try {
      await stopRuntime()
      for (const held of adapter.holds.values()) held.open()
    } finally {
      await ctx.fiber.dispose()
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      assert.ok(resolve(root).startsWith(resolve(join(tempBase, 'ds-bot-task-runs-integration-'))))
      await rm(root, { recursive: true, force: true })
    }
  })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Policy, { mode: 'workspace-write', workspaceRoot: project }).await()
  await ctx.plugin(SandboxedFs, { cwd: project }).await()
  await ctx.plugin(WorkingDirectory, { defaultDirectory: project }).await()
  await ctx.plugin(Approval, { policy: 'never' }).await()
  await ctx.plugin(Persistence, { root: join(root, 'sessions'), compression: 'none' }).await()
  await ctx.plugin(Query, { path: ':memory:', openAt: 'never' }).await()
  ctx.llm.registerAdapter(['integration', 'integration-other'], adapter)
  await mountAgentLoopTestHarness(ctx)
  await ctx.plugin(Subagents, { maxDepth: 3, maxActiveSubagents: 16, ...subagents }).await()
  await ctx.plugin(Spawn, { providerName: 'spawn' }).await()
  const preparedConfig = await prepare?.({ ctx, root, project, home, ids, adapter }) ?? {}
  const ensureAgent = async sessionId => {
    const live = ctx.agents.get(sessionId)
    if (live) return live
    if (pending.has(sessionId)) return pending.get(sessionId)
    const work = ctx.agents.create({ sessionId: SessionId(sessionId), meta: { cwd: project }, agentOptions: { provider: 'integration', model: 'chat' } }).then(handle => { handles.set(sessionId, handle); return handle.agent })
    pending.set(sessionId, work)
    try { return await work } finally { pending.delete(sessionId) }
  }
  ctx.provide('connection', { fetch: { register(route) { routes.push(route); return () => { const at = routes.indexOf(route); if (at !== -1) routes.splice(at, 1) } } } })
  const workspaces = new Map([['integration-project', { id: 'integration-project', path: project, title: 'Integration project' }]])
  ctx.provide('workspaceRegistry', {
    get: id => workspaces.get(id), list: () => [...workspaces.values()],
    resolveByPath: async path => [...workspaces.values()].find(workspace => workspace.path === path),
    create: async path => { const workspace = { id: randomUUID(), path }; workspaces.set(workspace.id, workspace); return workspace },
    async archiveSession(sessionId, options) {
      archived.add(sessionId)
      const agent = ctx.agents.get(sessionId)
      if (agent && options?.stopActivity) { await ctx.subagents.drainDescendants([agent]); agent.cancel('user'); await agent.whenIdle() }
    },
    unarchiveSession: async sessionId => { archived.delete(sessionId) },
  })
  ctx.provide('sessionTitle', { rename: async (session, title) => { titles.set(session.id, title) } })
  ctx.provide('sessionController', {
    create: async options => {
      const sessionId = randomUUID(), cwd = options.cwd ?? workspaces.get(options.workspaceId)?.path ?? project
      const handle = await ctx.agents.create({ sessionId: SessionId(sessionId), meta: { cwd }, agentOptions: { provider: 'integration', model: 'chat' } })
      handles.set(sessionId, handle)
      return { sessionId }
    },
    resolveAgent: async sessionId => ({ agent: await ensureAgent(sessionId) }),
    selectModel: async ({ sessionId, provider, model, reasoningEffort }) => { const agent = await ensureAgent(sessionId); agent.model.select({ provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) }); return agent.model.current() },
    page: async request => {
      const { events } = await ctx.sessionQuery.readSession(request.address.sessionId)
      const selected = events.filter(event => (request.throughSeq === undefined || event.seq <= request.throughSeq) && (request.beforeSeq === undefined || event.seq < request.beforeSeq))
      const max = request.maxMessages ?? selected.length
      return { records: selected.slice(-max).map(event => ({ event })), hasMore: selected.length > max }
    },
    projections: async () => ({ values: {} }),
    list: async () => ({ items: [...ctx.agents.list()].map(agent => ({ id: agent.id })) }),
    prompt: async ({ sessionId, content, prompt, requestId }) => {
      const message = createUserMessage({ source: { kind: 'user', ...(requestId ? { rpcId: requestId } : {}) }, content: content ?? blocks(typeof prompt === 'string' ? prompt : flattened(prompt)) })
      const agent = await ensureAgent(sessionId)
      agent.followup(message)
      return { accepted: true }
    },
  })
  const startRuntime = async () => {
    runtimeFiber = ctx.plugin({ name: `actual-ds-bot-task-run-integration-${randomUUID()}`, inject, apply(pluginCtx) { rt = createRuntime(pluginCtx, { home, taskRuns: true, ...config, ...preparedConfig }) } })
    await runtimeFiber.await()
    await rt.load()
    await rt.reconcileTaskRuns()
    return rt
  }
  await startRuntime()
  const chief = await ensureAgent(ids.chief), other = await ensureAgent(ids.other)
  const invoke = async (name, args, agent = chief) => {
    const tool = ctx.tools.get(name, agent)
    assert.ok(tool, `actual scoped ${name} tool is registered`)
    return tool.execute(args, { agent, name, callId: randomUUID(), signal: new AbortController().signal })
  }
  const execute = async (...args) => JSON.parse(await invoke(...args))
  const settled = id => until(() => {
    const record = rt.state.taskRuns[id]
    return record && !['starting', 'running'].includes(record.status) && record.notification?.status !== 'pending' && record.notification?.status !== 'delivering' ? record : undefined
  }, `terminal TaskRun ${id}`)
  const call = async (endpoint, payload) => {
    const route = routes.find(item => item.path === '/api/bot')
    assert.ok(route, 'actual api/bot channel is registered')
    return (await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  }
  const savedState = async () => JSON.parse(await readFile(join(home, 'state.json'), 'utf8'))
  return { ctx, adapter, ids, root, project, home, chief, other, ensureAgent, invoke, execute, settled, call, archived, titles, savedState, stopRuntime, startRuntime, get rt() { return rt } }
}
