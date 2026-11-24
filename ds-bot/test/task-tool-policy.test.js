import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { taskRunsFixture } from './task-runs-fixture.js'

const options = { timeout: 20000 }
const signal = () => new AbortController().signal
const startArgs = model => ({ label: 'Tool boundary fixture', brief: 'Use only admitted synthetic counter capabilities.', model: `integration/${model}` })

function counter(ctx, counts, name, when) {
  return ctx.tools.register(defineTool({
    name, description: 'Original harmless counter for tool-policy tests.', parameters: {},
    output: { schema: { type: 'integer' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute() {
      const value = (counts.get(name) ?? 0) + 1
      counts.set(name, value)
      return value
    },
  }), when === undefined ? undefined : { when })
}

const resolveTools = (r, agent) => r.ctx.tools.resolve({ agent, modelSelection: agent.model.current(), signal: signal() })
async function dispatch(r, agent, name, args = {}, admitted) {
  const toolSet = admitted ?? await resolveTools(r, agent)
  try {
    const batch = await r.ctx.tools.execute({
      agent, toolSet, signal: signal(),
      calls: [{ type: 'tool-call', id: ToolCallId(randomUUID()), name, arguments: JSON.stringify(args) }],
    })
    return batch.results[0].result
  } finally { if (admitted === undefined) toolSet.dispose() }
}
async function start(r, agent, args, admitted) {
  const result = await dispatch(r, agent, 'start_task', args, admitted)
  assert.equal(result.isError, false, JSON.stringify(result))
  return JSON.parse(result.value)
}
async function assertBinding(r, run) {
  const record = r.rt.state.taskRuns[run.id]
  const view = await r.rt.taskRunRead(run.id, { user: true })
  const saved = (await r.savedState()).taskRuns[run.id]
  assert.ok(Array.isArray(record.inheritedTools))
  assert.deepEqual(run.inheritedTools, record.inheritedTools)
  assert.deepEqual(view.inheritedTools, record.inheritedTools)
  assert.deepEqual(saved.inheritedTools, record.inheritedTools)
  return record.inheritedTools
}

async function assertWorkerAuthority(r, worker, counts) {
  const names = r.ctx.tools.schemas(worker).map(tool => tool.name)
  for (const name of ['create_bot', 'delete_group', 'subagent', 'workflow', 'send_message', 'ask_user_question']) assert.ok(!names.includes(name), `${name} must not be exposed to a task worker`)
  const botCount = Object.keys(r.rt.state.bots).length
  const create = await dispatch(r, worker, 'create_bot', { name: 'Must not exist' })
  assert.equal(create.isError, true)
  assert.equal(Object.keys(r.rt.state.bots).length, botCount)
  const native = await dispatch(r, worker, 'subagent')
  assert.equal(native.isError, true)
  assert.equal(counts.get('subagent') ?? 0, 0)
  assert.equal(r.rt.isBotSession(worker.id), false)
}

test('caller conditional admission stays absent when the worker model would enable the tool', options, async t => {
  const counts = new Map(), evaluations = []
  const r = await taskRunsFixture(t, { prepare: async ({ ctx }) => {
    counter(ctx, counts, 'policy_conditional', context => {
      const enabled = context.modelSelection.model === 'A'
      evaluations.push({ id: context.agent.id, model: context.modelSelection.model, enabled })
      return enabled
    })
    counter(ctx, counts, 'subagent')
  } })
  const control = await r.ensureAgent(randomUUID())
  control.model.select({ provider: 'integration', model: 'A' })
  const positive = await dispatch(r, control, 'policy_conditional')
  assert.equal(positive.isError, false, JSON.stringify(positive))
  assert.equal(counts.get('policy_conditional'), 1, 'a real resolved A-model scope can execute the conditional tool')
  const callerSet = await resolveTools(r, r.chief)
  try {
    assert.equal(callerSet.view(r.chief).has('policy_conditional'), false)
    assert.ok(evaluations.some(item => item.id === r.chief.id && item.enabled === false))
    const held = r.adapter.hold('A')
    const run = await start(r, r.chief, startArgs('A'), callerSet)
    await r.adapter.started('A')
    const worker = r.ctx.agents.get(run.sessionId)
    assert.equal(worker.model.current().model, 'A')
    assert.ok(!(await assertBinding(r, run)).includes('policy_conditional'))
    const workerSet = await resolveTools(r, worker)
    try {
      assert.equal(workerSet.view(worker).has('policy_conditional'), false)
      const refused = await dispatch(r, worker, 'policy_conditional', {}, workerSet)
      assert.equal(refused.isError, true)
      assert.equal(counts.get('policy_conditional'), 1)
    } finally { workerSet.dispose() }
    await assertWorkerAuthority(r, worker, counts)
    held.open()
    assert.equal((await r.settled(run.id)).status, 'completed')
  } finally { callerSet.dispose() }
})

test('caller-hidden global tools remain unavailable and cannot execute in the worker pipeline', options, async t => {
  const counts = new Map()
  const r = await taskRunsFixture(t, { prepare: async ({ ctx }) => {
    counter(ctx, counts, 'policy_hidden')
    counter(ctx, counts, 'subagent')
  } })
  assert.ok(r.ctx.tools.get('policy_hidden'))
  r.chief.ctx.tools.restrict({ deny: ['policy_hidden'] })
  assert.equal(r.ctx.tools.get('policy_hidden', r.chief), undefined)
  const held = r.adapter.hold('A')
  const run = await start(r, r.chief, startArgs('A'))
  await r.adapter.started('A')
  const worker = r.ctx.agents.get(run.sessionId)
  assert.ok(!(await assertBinding(r, run)).includes('policy_hidden'))
  const admitted = await resolveTools(r, worker)
  try {
    assert.equal(admitted.view(worker).has('policy_hidden'), false)
    assert.equal(r.ctx.tools.get('policy_hidden', worker), undefined)
    assert.equal((await dispatch(r, worker, 'policy_hidden', {}, admitted)).isError, true)
    assert.equal(counts.get('policy_hidden') ?? 0, 0)
  } finally { admitted.dispose() }
  await assertWorkerAuthority(r, worker, counts)
  held.open()
  assert.equal((await r.settled(run.id)).status, 'completed')
})

test('nested admission intersects the parent frozen names even when a late global tool resolves visibly', options, async t => {
  const counts = new Map()
  const r = await taskRunsFixture(t, { prepare: async ({ ctx }) => {
    counter(ctx, counts, 'policy_original')
    counter(ctx, counts, 'subagent')
  } })
  const parentHeld = r.adapter.hold('A'), childHeld = r.adapter.hold('B')
  const parent = await start(r, r.chief, startArgs('A'))
  await r.adapter.started('A')
  const parentAgent = r.ctx.agents.get(parent.sessionId)
  const originalNames = await assertBinding(r, parent)
  assert.ok(originalNames.includes('policy_original'))
  counter(r.ctx, counts, 'policy_late')
  const parentSet = await resolveTools(r, parentAgent)
  try {
    assert.equal(parentSet.view(parentAgent).has('policy_late'), true, 'the live schema changed after the parent snapshot')
    const blockedParent = await dispatch(r, parentAgent, 'policy_late', {}, parentSet)
    assert.equal(blockedParent.isError, true)
    assert.match(JSON.stringify(blockedParent), /not admitted by the calling Agent/)
    assert.equal(counts.get('policy_late') ?? 0, 0)
    const child = await start(r, parentAgent, startArgs('B'), parentSet)
    await r.adapter.started('B')
    const childAgent = r.ctx.agents.get(child.sessionId)
    const childNames = await assertBinding(r, child)
    assert.ok(childNames.includes('policy_original'))
    assert.ok(!childNames.includes('policy_late'))
    assert.ok(childNames.every(name => originalNames.includes(name) || ['start_task', 'list_task_runs', 'read_task_run', 'steer_task', 'cancel_task'].includes(name)))
    assert.equal((await dispatch(r, childAgent, 'policy_late')).isError, true)
    assert.equal(counts.get('policy_late') ?? 0, 0)
    const allowed = await dispatch(r, childAgent, 'policy_original')
    assert.equal(allowed.isError, false, JSON.stringify(allowed))
    assert.equal(counts.get('policy_original'), 1)
    await assertWorkerAuthority(r, childAgent, counts)
    childHeld.open()
    assert.equal((await r.settled(child.id)).status, 'completed')
    parentHeld.open()
    assert.equal((await r.settled(parent.id)).status, 'completed')
  } finally { parentSet.dispose() }
})

test('request_id retry returns the original names without resolving a new boundary or starting another worker', options, async t => {
  const counts = new Map()
  let enabled = false, evaluations = 0
  const r = await taskRunsFixture(t, { prepare: async ({ ctx }) => {
    counter(ctx, counts, 'policy_original')
    counter(ctx, counts, 'policy_retry_conditional', () => { evaluations += 1; return enabled })
  } })
  const held = r.adapter.hold('A')
  const args = { ...startArgs('A'), request_id: 'original-tool-boundary' }
  const original = await start(r, r.chief, args)
  await r.adapter.started('A')
  const worker = r.ctx.agents.get(original.sessionId)
  const originalNames = [...await assertBinding(r, original)]
  assert.ok(originalNames.includes('policy_original'))
  assert.ok(!originalNames.includes('policy_retry_conditional'))
  enabled = true
  counter(r.ctx, counts, 'policy_retry_late')
  r.chief.ctx.tools.restrict({ deny: ['policy_original'] })
  const retrySet = await resolveTools(r, r.chief)
  try {
    assert.equal(retrySet.view(r.chief).has('policy_retry_conditional'), true)
    assert.equal(retrySet.view(r.chief).has('policy_retry_late'), true)
    assert.equal(retrySet.view(r.chief).has('policy_original'), false)
    const evaluated = evaluations
    const repeated = await start(r, r.chief, args, retrySet)
    assert.equal(evaluations, evaluated, 'the receipt path must not resolve tool conditions again')
    assert.equal(repeated.id, original.id)
    assert.equal(repeated.sessionId, original.sessionId)
    assert.deepEqual(await assertBinding(r, repeated), originalNames)
    assert.equal(r.ctx.agents.get(repeated.sessionId), worker)
    assert.equal(r.adapter.calls.filter(call => call.sessionId === worker.id).length, 1)
    assert.equal(Object.values(r.rt.state.taskRuns).length, 1)
    assert.equal(counts.size, 0)
  } finally { retrySet.dispose() }
  held.open()
  assert.equal((await r.settled(original.id)).status, 'completed')
  assert.deepEqual((await r.savedState()).taskRuns[original.id].inheritedTools, originalNames)
})

test('read-only tasks drop MCP tools while workspace-write keeps them', options, async t => {
  const counts = new Map()
  const r = await taskRunsFixture(t, { prepare: async ({ ctx }) => {
    counter(ctx, counts, 'mcp__echo__ping')
    counter(ctx, counts, 'policy_local')
  } })
  const readOnly = await start(r, r.chief, { ...startArgs('A'), permission: 'read-only' })
  const readOnlyNames = await assertBinding(r, readOnly)
  assert.ok(readOnlyNames.includes('policy_local'))
  assert.ok(!readOnlyNames.includes('mcp__echo__ping'), 'a read-only task must not inherit MCP tools')
  const write = await start(r, r.chief, { ...startArgs('A') })
  const writeNames = await assertBinding(r, write)
  assert.ok(writeNames.includes('mcp__echo__ping'), 'workspace-write keeps the caller MCP tools')
})

