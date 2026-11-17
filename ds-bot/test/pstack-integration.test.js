import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import Skills from '@deepseek-ai/dsh-skill'
import * as NativeSkill from '@deepseek-ai/dsh-tool-skill'
import { taskRunsFixture, flattened, until, userMessage } from './task-runs-fixture.js'

const options = { timeout: 20000 }
const provider = 'ds-bot-pstack'
const marker = 'pstack Harness mapping'
const bodies = name => name === 'setup-pstack'
  ? '# Integration setup\n\n### 5. Rule shape\n\n```text\n# budget: fixture (high)\nhow explorer: integration/A\nhow explainer: integration/B\narena runners: integration/A, integration/B\narena cross-judge pool: integration-other/B, integration/A\narchitect runners: integration/B, integration/A\n```\n'
  : `# Integration ${name}\n\nORIGINAL_${name}_BODY {{literal}}\nRead references/detail.md relative to this Skill and ../how/SKILL.md.\n`

async function fixture(t, { enabled = true, script } = {}) {
  let sourceRoot, settingsFile
  const r = await taskRunsFixture(t, { prepare: async ({ ctx, root, project, adapter }) => {
    sourceRoot = join(root, 'pstack-source')
    settingsFile = join(project, '.agents', 'pstack-models.md')
    const names = ['setup-pstack', 'how', 'arena', 'architect', 'poteto-mode', ...Array.from({ length: 53 }, (_, index) => `integration-${index}`)]
    for (const name of names) {
      const directory = join(sourceRoot, 'skills', name)
      await mkdir(join(directory, 'references'), { recursive: true })
      await writeFile(join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: Original integration fixture ${name}.\n${name === 'setup-pstack' ? '' : 'disable-model-invocation: true\n'}---\n\n${bodies(name)}`)
      await writeFile(join(directory, 'references', 'detail.md'), `RESOURCE_${name}`)
    }
    await mkdir(join(project, '.agents'), { recursive: true })
    await writeFile(settingsFile, '# budget: fixture (high)\nhow explorer: auto\narena runners: integration/A, integration/B, integration/A\n')
    await ctx.plugin(Skills).await()
    await ctx.plugin(NativeSkill).await()
    if (script) {
      const original = adapter.stream.bind(adapter), counts = new Map()
      adapter.stream = async function* (request) {
        const count = (counts.get(request.sessionId) ?? 0) + 1
        counts.set(request.sessionId, count)
        const call = script(request, count)
        if (call) {
          adapter.calls.push({ sessionId: request.sessionId, model: request.model, provider: request.provider, reasoningEffort: request.reasoningEffort, messages: request.messages, tools: request.tools })
          const id = `pstack-integration-${randomUUID()}`, args = JSON.stringify(call.args)
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }
          yield { type: 'tool-call-delta', index: 0, id, name: call.name, argumentsDelta: args }
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: call.name, arguments: args } }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
        } else yield* original(request)
      }
    }
    return { pstack: { enabled, sourceRoot, settingsFile } }
  } })
  return Object.assign(r, { sourceRoot, settingsFile })
}

const sourceSkills = async (r, agent) => (await r.ctx.skills.snapshot({ scope: agent, cwd: r.project })).skills.filter(skill => skill.provider === provider)
const start = (r, args = {}, agent = r.chief) => r.execute('start_task', { label: 'pstack integration task', brief: 'ONLY_AUTHORIZED_PSTACK_HANDOFF', model: 'integration/A', ...args }, agent)
const firstCall = (r, agent) => r.adapter.calls.find(call => call.sessionId === agent.id)

function assertMapping(call, r) {
  assert.ok(call, 'a production model request reached the scripted adapter')
  const text = flattened(call.messages)
  assert.ok(text.includes(marker), 'the first request contains the Harness mapping')
  assert.ok(text.includes(r.sourceRoot.replaceAll('\\', '\\\\')) || text.includes(r.sourceRoot.replaceAll('\\', '/')))
  assert.ok(text.includes(r.settingsFile.replaceAll('\\', '\\\\')) || text.includes(r.settingsFile.replaceAll('\\', '/')))
  assert.ok(call.tools.some(tool => tool.name === 'pstack_preflight'))
}

test('enabled real Bot first request carries one mapping and preserves original invocation metadata', options, async t => {
  const r = await fixture(t)
  r.chief.followup(userMessage('Inspect the authorized source settings.'))
  await r.chief.whenIdle()
  const first = firstCall(r, r.chief)
  assertMapping(first, r)
  assert.equal(flattened(first.messages).split(marker).length - 1, 1)
  const skills = await sourceSkills(r, r.chief)
  assert.equal(skills.length, 58)
  assert.equal(skills.filter(skill => skill.invocation.modelInvocable === false).length, 57)
  assert.ok(skills.every(skill => skill.invocation.userInvocable))
  for (const name of ['subagent', 'workflow', 'send_message', 'ask_user_question']) assert.ok(!first.tools.some(tool => tool.name === name))
  const facts = await r.execute('pstack_preflight', {})
  assert.equal(facts.settings.settingsStatus, 'loaded')
  assert.deepEqual(facts.settings.rows.find(row => row.role === 'how explorer').values, ['auto'])
  assert.deepEqual(facts.settings.rows.find(row => row.role === 'arena runners').values, ['integration/A', 'integration/B', 'integration/A'])
  assert.equal(facts.settings.rows.find(row => row.role === 'arena cross-judge pool').kind, 'pool')
  assert.equal(facts.selection.model, 'chat')
  assert.equal(facts.execution.separateSpeedControl, false)
  assert.equal(facts.execution.inference, 'not-probed')
  assert.equal(facts.catalog.models.find(model => model.ref === 'integration/A').reasoningStatus, 'not-queried')
  const roleFacts = await r.execute('pstack_preflight', { role: 'arena runners' })
  for (const ref of ['integration/A', 'integration/B']) {
    const entry = roleFacts.catalog.models.find(model => model.ref === ref)
    assert.equal(entry.reasoningStatus, 'available')
    assert.deepEqual(entry.reasoning.efforts.map(effort => effort.id), ['low', 'high'])
  }
})

test('fresh Bot creation prepares pstack at the awaited send boundary after Agent creation precedes owner registration', options, async t => {
  const r = await fixture(t), created = [], boundaries = [], deliveries = []
  const deliver = r.rt.deliver
  r.rt.deliver = (...args) => { const delivery = deliver(...args); deliveries.push(delivery); return delivery }
  const offCreated = r.ctx.on('agent/created', async ({ agent }) => {
    created.push({ id: agent.id, owned: r.rt.isBotSession(agent.id), binding: r.rt.pstackTaskBinding(agent), skillCount: (await sourceSkills(r, agent)).length })
  })
  const ensure = r.rt.ensureCapabilities
  r.rt.ensureCapabilities = async sessionId => {
    const agent = r.ctx.agents.get(sessionId)
    const before = agent && { binding: r.rt.pstackTaskBinding(agent), skillCount: (await sourceSkills(r, agent)).length }
    const value = await ensure(sessionId)
    if (agent) boundaries.push({ id: sessionId, owned: r.rt.isBotSession(sessionId), before, after: r.rt.pstackTaskBinding(agent) })
    return value
  }
  t.after(() => { offCreated(); r.rt.ensureCapabilities = ensure; r.rt.deliver = deliver })
  const bot = await r.rt.createBot({ name: 'Fresh pstack owner', model: 'integration/chat', workDir: r.project })
  assert.deepEqual(bot.capabilities, [], 'preparation also runs before the empty-capability fast path')
  const first = await until(() => r.adapter.calls.find(call => call.sessionId === bot.id), 'fresh Bot greeting first production request')
  const entry = created.find(item => item.id === bot.id)
  assert.ok(entry, 'the real Controller create path published the Agent')
  assert.equal(entry.owned, false, 'owner indices do not exist at agent/created')
  assert.equal(entry.binding, undefined)
  assert.equal(entry.skillCount, 0)
  const boundary = boundaries.find(item => item.id === bot.id)
  assert.ok(boundary, 'the actual kickoff delivery awaited ensureCapabilities')
  assert.equal(boundary.owned, true)
  assert.equal(boundary.before.binding, undefined)
  assert.equal(boundary.before.skillCount, 0)
  assert.ok(boundary.after)
  assertMapping(first, r)
  assert.equal(flattened(first.messages).split(marker).length - 1, 1)
  const agent = r.ctx.agents.get(bot.id)
  await agent.whenIdle()
  await Promise.all(deliveries)
  assert.equal((await sourceSkills(r, agent)).length, 58)
  await r.rt.sendUser({ sessionId: bot.id, content: [{ type: 'text', text: '/how inspect the fresh Bot source' }] })
  await agent.whenIdle()
  const last = r.adapter.calls.filter(call => call.sessionId === bot.id).at(-1)
  assertMapping(last, r)
  assert.ok(flattened(last.messages).includes('ORIGINAL_how_BODY {{literal}}'))
})

for (const name of ['how', 'arena', 'architect']) {
  test(`direct user /${name} reaches the production native loader with original body and resource base`, options, async t => {
    const r = await fixture(t)
    r.chief.followup(userMessage(`/${name} inspect the integration fixture`))
    await r.chief.whenIdle()
    const first = firstCall(r, r.chief)
    assertMapping(first, r)
    const text = flattened(first.messages)
    assert.ok(text.includes(`skill_content name=\\"${name}\\"`), 'the native user invocation injected its canonical skill_content wrapper')
    assert.ok(text.includes(`ORIGINAL_${name}_BODY {{literal}}`))
    assert.ok(text.includes('Base directory for this skill:'))
    const loaded = await r.ctx.skills.get(name, { scope: r.chief, cwd: r.project })
    assert.equal(loaded.content, bodies(name).trim())
    assert.equal(loaded.invocation.modelInvocable, false)
    assert.equal(loaded.resourceBase.kind, 'directory')
    assert.equal(await realpath(loaded.resourceBase.path), await realpath(join(r.sourceRoot, 'skills', name)))
    assert.equal(await readFile(join(loaded.resourceBase.path, 'references', 'detail.md'), 'utf8'), `RESOURCE_${name}`)
  })
}

test('a real model skill call cannot invoke a source Skill disabled for model invocation', options, async t => {
  const r = await fixture(t, { script: (request, count) => request.model === 'chat' && count === 1 ? { name: 'skill', args: { name: 'how' } } : undefined })
  r.chief.followup(userMessage('Check the model invocation boundary.'))
  await r.chief.whenIdle()
  const calls = r.adapter.calls.filter(call => call.sessionId === r.chief.id)
  assert.equal(calls.length, 2)
  assertMapping(calls[0], r)
  assert.match(flattened(calls[1].messages), /not available for model invocation/)
  assert.ok(!flattened(calls[1].messages).includes('ORIGINAL_how_BODY'))
  assert.equal((await sourceSkills(r, r.chief)).find(skill => skill.name === 'how').invocation.modelInvocable, false)
})

test('worker first request has inherited source binding and executes real preflight without Main authority', options, async t => {
  const r = await fixture(t, { script: (request, count) => request.model === 'A' && count === 1 ? { name: 'pstack_preflight', args: { role: 'arena runners' } } : undefined })
  const held = r.adapter.hold('A')
  const original = r.rt.pstackTaskBinding(r.chief)
  const task = await start(r)
  const second = await until(() => r.adapter.calls.filter(call => call.sessionId === task.sessionId)[1], 'worker request after actual preflight tool execution')
  const worker = r.ctx.agents.get(task.sessionId)
  assertMapping(firstCall(r, worker), r)
  assert.match(flattened(second.messages), /settingsHash/)
  assert.match(flattened(second.messages), /arena runners/)
  assert.ok(!flattened(second.messages).includes('does not own this pstack binding'))
  assert.deepEqual(task.pstack, original)
  assert.deepEqual(r.rt.pstackTaskBinding(worker), original)
  assert.deepEqual((await r.savedState()).taskRuns[task.id].pstack, original)
  assert.equal((await sourceSkills(r, worker)).length, 58)
  const facts = await r.execute('pstack_preflight', { role: 'arena runners' }, worker)
  assert.deepEqual(facts.settings.rows[0].values, ['integration/A', 'integration/B', 'integration/A'])
  assert.equal(facts.execution.tools.start_task, true)
  assert.equal(facts.execution.tools.ask_user, false)
  assert.equal(r.rt.isBotSession(worker.id), false)
  assert.equal(r.rt.selfOf(worker.id), undefined)
  assert.ok(!r.rt.isMain(worker.id))
  assert.equal(r.rt.state.agents[worker.id], undefined)
  for (const name of ['create_bot', 'message_bot', 'stop_bot', 'subagent', 'workflow', 'send_message', 'ask_user_question']) {
    assert.ok(!firstCall(r, worker).tools.some(tool => tool.name === name), `${name} remains absent`)
    assert.ok(r.ctx.tools.checkGuards({ agent: worker, name }), `${name} remains guarded`)
  }
  const host = r.ctx.agents.get(r.rt.state.taskRuns[task.id].hostSessionId)
  assert.ok(host)
  assert.deepEqual(await sourceSkills(r, host), [])
  assert.equal(r.rt.pstackTaskBinding(host), undefined)
  assert.equal(r.ctx.tools.get('pstack_preflight', host), undefined)
  assert.ok(!r.adapter.calls.some(call => call.sessionId === host.id))
  const unbound = await r.ensureAgent(randomUUID())
  unbound.followup(userMessage('Ordinary unbound Agent.'))
  await unbound.whenIdle()
  assert.deepEqual(await sourceSkills(r, unbound), [])
  assert.equal(r.rt.pstackTaskBinding(unbound), undefined)
  assert.equal(r.ctx.tools.get('pstack_preflight', unbound), undefined)
  assert.ok(!flattened(firstCall(r, unbound).messages).includes(marker))
  await assert.rejects(r.rt.taskRunStart({ label: 'unauthorized', brief: 'no owner', model: 'integration/B' }, { agent: unbound }), /Only an active Bot or task run/)
  held.open()
  assert.equal((await r.settled(task.id)).status, 'completed')
})

test('nested TaskRun binding comes from the live parent caller and keeps its root and narrowed permission', options, async t => {
  const r = await fixture(t)
  const held = r.adapter.hold('A'), nestedHeld = r.adapter.hold('nested')
  const parent = await start(r)
  await r.adapter.started('A')
  const parentAgent = r.ctx.agents.get(parent.sessionId)
  const observed = [], originalBinding = r.rt.pstackTaskBinding
  r.rt.pstackTaskBinding = agent => { observed.push(agent); return originalBinding(agent) }
  const child = await start(r, { model: 'integration/nested', permission: 'read-only' }, parentAgent)
  await r.adapter.started('nested')
  assert.equal(observed[0], parentAgent)
  assert.notEqual(observed[0], r.chief)
  assert.equal(child.parentRunId, parent.id)
  assert.deepEqual(child.pstack, parent.pstack)
  const nested = r.ctx.agents.get(child.sessionId)
  assertMapping(firstCall(r, nested), r)
  assert.equal(r.ctx.sandboxPolicy.resolve({ session: nested.session }).mode, 'read-only')
  assert.equal(child.projectRoot, r.project)
  await assert.rejects(start(r, { model: 'integration/B', permission: 'workspace-write' }, nested), error => error.code === 'bot/task-permission')
  nestedHeld.open()
  await r.settled(child.id)
  held.open()
  await r.settled(parent.id)
})

test('changing a Session current directory preserves its original authorized root and TaskRun binding', options, async t => {
  const r = await fixture(t), original = r.rt.pstackTaskBinding(r.chief)
  const nestedDirectory = join(r.project, 'nested-working-folder')
  await mkdir(nestedDirectory)
  await r.ctx.workingDirectory.set(r.chief, nestedDirectory)
  await r.rt.ensureCapabilities(r.chief.id)
  assert.equal(r.ctx.workingDirectory.get(r.chief.session), nestedDirectory)
  assert.equal(r.chief.session.header.cwd, r.project)
  assert.equal(r.ctx.sandboxPolicy.resolve({ session: r.chief.session }).workspaceRoot, r.project)
  assert.deepEqual(r.rt.pstackTaskBinding(r.chief), original)
  const task = await start(r, { model: 'integration/B' })
  assert.equal(task.cwd, nestedDirectory)
  assert.equal(task.projectRoot, original.projectRoot)
  assert.deepEqual(task.pstack, original)
  assert.equal((await r.settled(task.id)).status, 'completed')
})

test('an authorized Bot folder move creates a fresh project-root binding rather than reusing the old Agent cache', options, async t => {
  const r = await fixture(t), original = r.rt.pstackTaskBinding(r.chief)
  const nextProject = join(r.root, 'next-authorized-project')
  await mkdir(nextProject)
  await r.rt.updateBot(r.ids.chief, { workDir: nextProject })
  const fresh = await until(() => {
    const id = r.rt.chatOf(r.ids.chief)
    const agent = r.ctx.agents.get(id)
    return id !== r.chief.id && agent && r.rt.pstackTaskBinding(agent) ? agent : undefined
  }, 'fresh Bot conversation and pstack binding after authorized folder move')
  await r.rt.sendUser({ sessionId: fresh.id, content: [{ type: 'text', text: 'Inspect the new project root.' }] })
  await fresh.whenIdle()
  assert.notEqual(fresh, r.chief)
  assert.equal(fresh.session.header.cwd, nextProject)
  const binding = r.rt.pstackTaskBinding(fresh)
  assert.equal(binding.projectRoot, nextProject)
  assert.equal(binding.settingsFile, r.settingsFile, 'explicit external settings remain the configured file')
  const previous = r.rt.pstackTaskBinding(r.chief)
  assert.ok(previous === undefined || previous.projectRoot === original.projectRoot, 'the old scope is retired or retains its original root')
  assert.equal((await sourceSkills(r, fresh)).length, 58)
  assertMapping(firstCall(r, fresh), r)
  const task = await start(r, { model: 'integration/B' }, fresh)
  assert.equal(task.projectRoot, nextProject)
  assert.equal(task.pstack.projectRoot, nextProject)
  assert.equal((await r.settled(task.id)).status, 'completed')
})

test('a missing caller binding cannot fall back to the owner Bot binding', options, async t => {
  const r = await fixture(t)
  const held = r.adapter.hold('A'), nestedHeld = r.adapter.hold('nested')
  const parent = await start(r)
  await r.adapter.started('A')
  const parentAgent = r.ctx.agents.get(parent.sessionId), originalBinding = r.rt.pstackTaskBinding
  assert.ok(originalBinding(r.chief))
  // Fault-inject the missing scope snapshot at the caller boundary, keeping real execution and ownership.
  r.rt.pstackTaskBinding = agent => agent === parentAgent ? undefined : originalBinding(agent)
  const child = await start(r, { model: 'integration/nested' }, parentAgent)
  await r.adapter.started('nested')
  const nested = r.ctx.agents.get(child.sessionId)
  assert.equal(child.pstack, undefined)
  assert.equal(originalBinding(nested), undefined)
  assert.deepEqual(await sourceSkills(r, nested), [])
  assert.equal(r.ctx.tools.get('pstack_preflight', nested), undefined)
  assert.ok(!flattened(firstCall(r, nested).messages).includes(marker))
  assert.ok(originalBinding(r.chief), 'the owner remains enabled throughout the missing-caller test')
  nestedHeld.open()
  await r.settled(child.id)
  held.open()
  await r.settled(parent.id)
})

test('request_id retries retain the original binding and receipt after settings become malformed', options, async t => {
  const r = await fixture(t), held = r.adapter.hold('A')
  const args = { request_id: 'pstack-stable-receipt' }
  const original = await start(r, args)
  await r.adapter.started('A')
  const binding = structuredClone(original.pstack)
  await writeFile(r.settingsFile, 'how explorer: first\nhow explorer: second\n')
  const retry = await start(r, args)
  assert.equal(retry.id, original.id)
  assert.deepEqual(retry.pstack, binding)
  assert.equal(r.adapter.calls.filter(call => call.model === 'A').length, 1)
  assert.equal(Object.keys(r.rt.state.taskRuns).length, 1)
  assert.deepEqual((await r.savedState()).taskRuns[original.id].pstack, binding)
  await assert.rejects(r.execute('pstack_preflight', {}, r.ctx.agents.get(original.sessionId)), /duplicate known role/)
  held.open()
  await r.settled(original.id)
  const terminal = await start(r, args)
  assert.equal(terminal.id, original.id)
  assert.deepEqual(terminal.pstack, binding)
  assert.equal(r.adapter.calls.filter(call => call.model === 'A').length, 1)
})

test('disabled profile retains ordinary Bot and TaskRun behavior without any pstack scope', options, async t => {
  const r = await fixture(t, { enabled: false })
  r.chief.followup(userMessage('An ordinary disabled-profile request.'))
  await r.chief.whenIdle()
  assert.ok(!flattened(firstCall(r, r.chief).messages).includes(marker))
  assert.deepEqual(await sourceSkills(r, r.chief), [])
  assert.equal(r.ctx.tools.get('pstack_preflight', r.chief), undefined)
  const task = await start(r)
  assert.equal(task.pstack, undefined)
  const first = await r.adapter.started('A')
  assert.ok(!flattened(first.messages).includes(marker))
  assert.ok(!first.tools.some(tool => tool.name === 'pstack_preflight'))
  assert.equal((await r.settled(task.id)).status, 'completed')
  assert.equal((await r.rt.taskRunRead(task.id, { user: true })).result.output, 'INTEGRATION_OUTPUT:A')
})
