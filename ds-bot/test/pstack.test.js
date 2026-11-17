import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents, assembleContextFor } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import Skills from '@deepseek-ai/dsh-skill'
import * as NativeSkill from '@deepseek-ai/dsh-tool-skill'
import * as FileTools from '@deepseek-ai/dsh-tool-fs'
import Policy from '@deepseek-ai/dsh-sandbox-policy'
import { install } from '../src/host/pstack.js'

const blocks = text => [{ type: 'text', text }]
class NoInference extends LlmAdapter {
  async resolveModel(provider, model) { return { provider, id: model, name: model } }
  async *stream() { yield await Promise.reject(new Error('This fixture must never make an inference request.')) }
}

async function fixture(t, options = {}) {
  const base = await realpath(tmpdir())
  const root = await realpath(await mkdtemp(join(base, 'ds-bot-pstack-')))
  const projectRoot = join(root, 'project'), sourceRoot = join(root, 'source')
  await mkdir(projectRoot)
  const names = ['setup-pstack', 'how', 'arena', 'architect', 'poteto-mode', ...Array.from({ length: 53 }, (_, n) => `fixture-${n}`)]
  const bodies = new Map()
  for (const name of names) {
    const directory = join(sourceRoot, 'skills', name)
    await mkdir(join(directory, 'references'), { recursive: true })
    const body = name === 'setup-pstack'
      ? '# Synthetic setup\n\n### 5. Fixture defaults\n\n```text\n# budget: fixture\nhow explorer: fixture/main\narena runners: fixture/main, fixture/main\narena cross-judge pool: other/judge, fixture/main\n```\n'
      : `# Synthetic ${name}\n\nRead references/detail.md and ../how/SKILL.md. Preserve {{literal}}.\n`
    const raw = `---\nname: ${name}\ndescription: Synthetic ${name} contract for scope testing.\n${name === 'setup-pstack' ? '' : 'disable-model-invocation: true\n'}---\n\n${body}`
    await writeFile(join(directory, 'SKILL.md'), raw)
    await writeFile(join(directory, 'references', 'detail.md'), `Synthetic resource for ${name}.`)
    bodies.set(name, { raw, body })
  }
  const ctx = new Context(), bots = new Map(), handles = [], reasoningQueries = []
  let runtimeFiber, rt
  t.after(async () => {
    try { await runtimeFiber?.dispose(); await ctx.fiber.dispose() } finally {
      assert.ok(resolve(root).startsWith(resolve(join(base, 'ds-bot-pstack-'))))
      await rm(root, { recursive: true, force: true })
    }
  })
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(Policy, { mode: 'read-only', workspaceRoot: projectRoot }).await()
  await ctx.plugin(Skills).await()
  ctx.llm.registerAdapter(['fixture'], new NoInference())
  await mountAgentLoopTestHarness(ctx)
  if (options.nativeLoader !== false) await ctx.plugin(NativeSkill).await()
  if (options.readTools === true) await ctx.plugin(FileTools, { write: false, edit: false, readImage: false }).await()
  const configuration = { enabled: true, sourceRoot, ...options.config }
  runtimeFiber = ctx.plugin({ name: 'pstack-test-runtime', apply(c) {
    rt = {
      ctx: c, config: { pstack: options.disabled ? undefined : configuration }, load: async () => { assert.fail('Scope creation must not re-enter the store load promise') },
      isBotSession: id => bots.has(id), selfOf: id => id, botOf: id => bots.get(id),
      isPrivate: id => bots.get(id)?.private === true,
      catalog: async () => [{ ref: 'fixture/main', provider: 'fixture', id: 'main' }, { ref: 'other/judge', provider: 'other', id: 'judge', needsKey: true }],
      reasoningOf: async ref => { reasoningQueries.push(ref); return ref === 'fixture/main' ? { efforts: [{ id: 'low', name: 'Low' }] } : undefined },
      taskRunsAvailable: () => false,
    }
    install(rt)
  } })
  await runtimeFiber.await()
  async function agent({ bot = false, private: privateBot = false, setup, cwd = projectRoot } = {}) {
    const id = randomUUID()
    if (bot) bots.set(id, { id, private: privateBot })
    const handle = await ctx.agents.create({ sessionId: SessionId(id), meta: { cwd }, agentOptions: { provider: 'fixture', model: 'main' }, ...(setup ? { setup } : {}) })
    handles.push(handle)
    return handle.agent
  }
  const skills = agent => ctx.skills.snapshot({ scope: agent, cwd: projectRoot })
  const prompt = agent => ctx.systemPrompt.assemble(assembleContextFor(agent))
  const preflight = async (agent, args = {}, caller = agent) => {
    const tool = ctx.tools.get('pstack_preflight', agent)
    return JSON.parse(await tool.execute(args, { agent: caller, name: tool.name, signal: new AbortController().signal }))
  }
  const step = (agent, text, source = { kind: 'user' }) => {
    const messages = [createUserMessage({ source, content: blocks(text) })]
    return agentEvents(ctx, agent).waterfall('agent/pre-step', { messages, turn: 1, step: 1, signal: new AbortController().signal, modelSelection: agent.model.current() }, async () => ({ kind: 'enter', messages }))
  }
  return { ctx, rt, root, projectRoot, sourceRoot, bodies, bots, handles, reasoningQueries, agent, skills, prompt, preflight, step, stop: () => runtimeFiber.dispose() }
}

test('default off installs no hooks or scoped registrations', async () => {
  const rt = { config: {}, ctx: { on() { assert.fail('off must not register hooks') }, effect() { assert.fail('off must not register effects') } } }
  install(rt)
  assert.equal(rt.pstackTaskBinding({}), undefined)
  await rt.preparePstackBot({})
  await rt.preparePstackTask({}, { pstack: { arbitrary: true } })
})

test('real native provider preserves 58 original bundles, policy and relative resources only in an eligible Bot scope', async t => {
  const r = await fixture(t)
  const bot = await r.agent({ bot: true }), other = await r.agent(), privateBot = await r.agent({ bot: true, private: true })
  const observed = await r.skills(bot)
  assert.equal(observed.complete, true)
  assert.equal(observed.skills.length, 58)
  assert.equal(observed.skills.filter(skill => !skill.invocation.modelInvocable).length, 57)
  assert.equal(observed.skills.filter(skill => skill.invocation.userInvocable).length, 58)
  assert.deepEqual((await r.skills(other)).skills, [])
  assert.deepEqual((await r.skills(privateBot)).skills, [])
  assert.equal(r.ctx.tools.get('pstack_preflight'), undefined)
  assert.equal(r.ctx.tools.get('pstack_preflight', other), undefined)
  for (const name of ['how', 'arena', 'architect']) {
    const loaded = await r.ctx.skills.get(name, { scope: bot, cwd: r.projectRoot })
    assert.equal(loaded.content, r.bodies.get(name).body.trim())
    assert.equal(loaded.resourceBase.kind, 'directory')
    assert.equal(await realpath(loaded.resourceBase.path), await realpath(join(r.sourceRoot, 'skills', name)))
    assert.equal(await readFile(join(loaded.resourceBase.path, 'references', 'detail.md'), 'utf8'), `Synthetic resource for ${name}.`)
    assert.equal(await readFile(join(r.sourceRoot, 'skills', name, 'SKILL.md'), 'utf8'), r.bodies.get(name).raw)
  }
  const binding = r.rt.pstackTaskBinding(bot)
  assert.equal(binding.settingsFile, join(r.projectRoot, '.agents', 'pstack-models.md'))
  assert.equal(binding.projectRoot, r.projectRoot)
  assert.equal(binding.fingerprints.settingsStatus, 'missing')
  assert.match(binding.fingerprints.sourceHash, /^[a-f0-9]{64}$/)
  binding.projectRoot = 'mutated'
  assert.equal(r.rt.pstackTaskBinding(bot).projectRoot, r.projectRoot)
  assert.equal(r.rt.pstackTaskBinding({ ...bot }), undefined)
  const assembled = await r.prompt(bot)
  assert.match(assembled.sections.find(section => section.name === 'ds-bot:pstack-harness').text, /fresh start_task/)
  assert.equal((await r.prompt(other)).sections.some(section => section.name === 'ds-bot:pstack-harness'), false)
})

test('native loader rejects disabled model loads and injects independent user entries beside the same mapping', async t => {
  const r = await fixture(t), bot = await r.agent({ bot: true })
  const loader = r.ctx.tools.get('skill', bot)
  for (const name of ['how', 'arena', 'architect']) {
    await assert.rejects(loader.execute({ name }, { agent: bot, name: 'skill', signal: new AbortController().signal }), /not available for model invocation/)
    const decision = await r.step(bot, `/${name} synthetic question`)
    const invocation = decision.messages.find(message => message.source.kind === 'skill-invocation')
    assert.equal(invocation.source.name, name)
    assert.match(invocation.content[0].text, new RegExp(`skill_content name="${name}"`))
    assert.match(invocation.content[0].text, /Synthetic/)
    const catalog = decision.messages.find(message => message.source.kind === 'skill-catalog')
    assert.deepEqual(catalog.source.entries.map(entry => entry.name), ['setup-pstack'])
    assert.match((await r.prompt(bot)).sections.find(section => section.name === 'ds-bot:pstack-harness').text, /source-contract loading/)
  }
})

test('preflight is bound to the actual caller and reports catalog/effort facts without fallback or model calls', async t => {
  const r = await fixture(t), bot = await r.agent({ bot: true }), other = await r.agent()
  const facts = await r.preflight(bot, { role: 'arena runners' })
  assert.deepEqual(facts.settings.rows[0].values, ['fixture/main', 'fixture/main'])
  assert.equal(facts.settings.rows[0].origin, 'skill-default')
  assert.equal(facts.settings.settingsStatus, 'missing')
  assert.equal(facts.selection.provider, 'fixture')
  assert.equal(facts.catalog.models[1].needsKey, true)
  assert.equal(facts.catalog.models[1].reasoningStatus, 'not-queried')
  assert.deepEqual(facts.catalog.models[0].reasoning.efforts.map(item => item.id), ['low'])
  assert.equal(facts.execution.separateSpeedControl, false)
  assert.equal(facts.execution.capacity, 'not-probed')
  assert.equal(facts.execution.tools.start_task, false)
  assert.deepEqual(r.reasoningQueries, ['fixture/main'])
  await assert.rejects(r.preflight(bot, {}, other), /does not own/)
  const unknown = await r.preflight(bot, { role: 'retired role' })
  assert.equal(unknown.knownRole, false)
  assert.deepEqual(unknown.settings.rows, [])
})

test('explicit external settings remain read only, preserve aliases, and never silently fall back after an invalid edit', async t => {
  const r = await fixture(t)
  const settingsFile = join(r.root, 'profile-settings.md')
  const original = '# budget: custom\narena runners: auto, inherit-parent, auto\n'
  await writeFile(settingsFile, original)
  r.rt.config.pstack.settingsFile = settingsFile
  const bot = await r.agent({ bot: true })
  const facts = await r.preflight(bot, { role: 'arena runners' })
  assert.equal(facts.binding.settingsFile, settingsFile)
  assert.equal(facts.binding.fingerprints.settingsStatus, 'loaded')
  assert.deepEqual(facts.settings.rows[0].values, ['auto', 'inherit-parent', 'auto'])
  assert.equal(facts.settings.budget, 'custom')
  assert.deepEqual(r.reasoningQueries, ['fixture/main'])
  assert.equal(await readFile(settingsFile, 'utf8'), original)
  await writeFile(settingsFile, 'arena runners: bad,,entry\n')
  await assert.rejects(r.preflight(bot), /invalid role value/)
})

test('worker and nested task binding is explicit, root-bound and disposed with the owning scope or plugin', async t => {
  const r = await fixture(t), bot = await r.agent({ bot: true }), host = await r.agent(), unbound = await r.agent()
  await r.rt.preparePstackTask(unbound, { ownerBotId: bot.id, projectRoot: r.projectRoot })
  assert.equal(r.rt.pstackTaskBinding(unbound), undefined)
  const worker = await r.agent({ setup: async (_c, agent) => {
    await r.rt.preparePstackTask(agent, { pstack: r.rt.pstackTaskBinding(bot), projectRoot: r.projectRoot })
  } })
  assert.equal((await r.skills(worker)).skills.length, 58)
  assert.equal(r.rt.pstackTaskBinding(host), undefined)
  assert.match((await r.prompt(worker)).sections.find(section => section.name === 'ds-bot:pstack-harness').text, /workers return missing/)
  const nested = await r.agent()
  await r.rt.preparePstackTask(nested, { pstack: r.rt.pstackTaskBinding(worker), projectRoot: r.projectRoot })
  assert.deepEqual(r.rt.pstackTaskBinding(nested), r.rt.pstackTaskBinding(worker))
  await assert.rejects(r.rt.preparePstackTask(unbound, { pstack: r.rt.pstackTaskBinding(worker), projectRoot: r.sourceRoot }), /cannot change/)
  await r.handles.find(handle => handle.agent === worker).dispose()
  assert.equal(r.rt.pstackTaskBinding(worker), undefined)
  await r.stop()
  assert.equal(r.rt.pstackTaskBinding(bot), undefined)
  assert.equal(r.ctx.tools.get('pstack_preflight', bot), undefined)
  assert.deepEqual((await r.skills(bot)).skills, [])
  assert.equal((await r.prompt(bot)).sections.some(section => section.name === 'ds-bot:pstack-harness'), false)
})

async function checkTaskSourceAccess(r, worker) {
  const observed = await r.skills(worker)
  assert.equal(observed.complete, true)
  assert.equal(observed.skills.length, 58)
  assert.equal(observed.skills.filter(skill => !skill.invocation.modelInvocable).length, 57)
  const definition = await r.ctx.skills.get('how', { scope: worker, cwd: r.projectRoot })
  assert.equal(definition.content, r.bodies.get('how').body.trim())
  assert.equal(await realpath(definition.resourceBase.path), await realpath(join(r.sourceRoot, 'skills', 'how')))
  const reader = r.ctx.tools.get('read', worker)
  const context = { agent: worker, name: 'read', signal: new AbortController().signal }
  const instructions = await reader.execute({ file_path: join(definition.resourceBase.path, 'SKILL.md') }, context)
  const resource = await reader.execute({ file_path: join(definition.resourceBase.path, 'references', 'detail.md') }, context)
  assert.match(JSON.stringify(instructions), /Synthetic how/)
  assert.match(JSON.stringify(resource), /Synthetic resource for how/)
  const facts = await r.preflight(worker)
  assert.equal(facts.execution.tools.skill, false)
  assert.equal(facts.execution.tools.read, true)
  assert.equal(facts.skills.entries.length, 58)
  const text = (await r.prompt(worker)).sections.find(section => section.name === 'ds-bot:pstack-harness').text
  assert.match(text, /Native skill tool in this scope: unavailable/)
  assert.match(text, /Task and relay briefs are not direct user Skill gestures/)
}

test('worker with no global native loader keeps source contracts readable without fabricating a loader', async t => {
  const r = await fixture(t, { nativeLoader: false, readTools: true })
  const bot = await r.agent({ bot: true, setup: async c => { await c.plugin(NativeSkill).await() } })
  const botLoader = r.ctx.tools.get('skill', bot)
  assert.ok(botLoader)
  assert.equal(r.ctx.tools.get('skill'), undefined)
  const host = await r.agent()
  const worker = await r.agent({ setup: async (_c, agent) => {
    await r.rt.preparePstackTask(agent, { pstack: r.rt.pstackTaskBinding(bot), projectRoot: r.projectRoot })
  } })
  await checkTaskSourceAccess(r, worker)
  assert.equal(r.ctx.tools.get('skill', worker), undefined)
  assert.equal(r.ctx.tools.get('skill', host), undefined)
  assert.equal(r.ctx.tools.get('skill', bot), botLoader)
  const decision = await r.step(worker, '/how is part of a delegated brief', { kind: 'subagent' })
  assert.equal(decision.messages.some(message => message.source.kind === 'skill-invocation'), false)
})

test('worker source loading preserves explicit native tool restrictions and guards', async t => {
  const r = await fixture(t, { readTools: true }), bot = await r.agent({ bot: true })
  const native = r.ctx.tools.get('skill', bot)
  const worker = await r.agent({ setup: async (c, agent) => {
    c.tools.restrict({ deny: ['skill'] })
    c.tools.guard(exec => exec.name === 'skill' ? 'Keep native skill denied.' : undefined)
    await r.rt.preparePstackTask(agent, { pstack: r.rt.pstackTaskBinding(bot), projectRoot: r.projectRoot })
  } })
  await checkTaskSourceAccess(r, worker)
  assert.equal(r.ctx.tools.get('skill', worker), undefined)
  assert.equal(r.ctx.tools.get('skill', bot), native)
  assert.equal(r.ctx.tools.checkGuards({ agent: worker, name: 'skill', arguments: { name: 'setup-pstack' } }), 'Keep native skill denied.')
  await assert.rejects(r.agent({ bot: true, setup: c => { c.tools.restrict({ deny: ['skill'] }) } }), /native skill loader/)
})

test('task without a source read tool reports that limit rather than claiming file loading', async t => {
  const r = await fixture(t, { nativeLoader: false })
  const bot = await r.agent({ bot: true, setup: async c => { await c.plugin(NativeSkill).await() } })
  const worker = await r.agent({ setup: async (_c, agent) => {
    await r.rt.preparePstackTask(agent, { pstack: r.rt.pstackTaskBinding(bot), projectRoot: r.projectRoot })
  } })
  const facts = await r.preflight(worker)
  assert.equal(facts.execution.tools.skill, false)
  assert.equal(facts.execution.tools.read, false)
  assert.match(facts.execution.sourceContractLoading, /owner assistance/)
  assert.match((await r.prompt(worker)).sections.find(section => section.name === 'ds-bot:pstack-harness').text, /do not claim to load referenced source contracts/)
})

test('preparation leaves an already visible native loader registration unchanged', async t => {
  const r = await fixture(t), native = r.ctx.tools.get('skill')
  const bot = await r.agent({ bot: true })
  const worker = await r.agent({ setup: async (_c, agent) => {
    await r.rt.preparePstackTask(agent, { pstack: r.rt.pstackTaskBinding(bot), projectRoot: r.projectRoot })
  } })
  assert.equal(r.ctx.tools.get('skill', bot), native)
  assert.equal(r.ctx.tools.get('skill', worker), native)
  assert.equal((await r.preflight(worker)).execution.tools.skill, true)
})

test('plugin reconciliation prepares existing Bot scopes and removes scopes that become private', async t => {
  const r = await fixture(t), existing = await r.agent()
  r.bots.set(existing.id, { id: existing.id })
  await r.rt.preparePstackBot(existing)
  assert.equal((await r.skills(existing)).skills.length, 58)
  r.bots.get(existing.id).private = true
  assert.equal(r.rt.pstackTaskBinding(existing), undefined)
  await r.rt.preparePstackBot(existing)
  assert.deepEqual((await r.skills(existing)).skills, [])
  assert.equal(r.ctx.tools.get('pstack_preflight', existing), undefined)
})

test('a fresh Agent project root selects its own default settings without rebinding the old scope', async t => {
  const r = await fixture(t), previous = await r.agent({ bot: true })
  const nextRoot = join(r.root, 'next-project')
  await mkdir(nextRoot)
  const next = await r.agent({ bot: true, cwd: nextRoot })
  const binding = r.rt.pstackTaskBinding(next)
  assert.equal(binding.projectRoot, nextRoot)
  assert.equal(binding.settingsFile, join(nextRoot, '.agents', 'pstack-models.md'))
  assert.equal(r.rt.pstackTaskBinding(previous).projectRoot, r.projectRoot)
  assert.equal(r.rt.pstackTaskBinding(previous).settingsFile, join(r.projectRoot, '.agents', 'pstack-models.md'))
  const worker = await r.agent({ cwd: nextRoot, setup: async (_c, agent) => {
    await r.rt.preparePstackTask(agent, { pstack: binding, projectRoot: nextRoot })
  } })
  assert.deepEqual(r.rt.pstackTaskBinding(worker), binding)
})

test('missing sources, native loader and malformed settings fail preparation before an enabled Bot can reason', async t => {
  const absent = await fixture(t, { config: { sourceRoot: join(await realpath(tmpdir()), `absent-pstack-${randomUUID()}`) } })
  await assert.rejects(absent.agent({ bot: true }), /Cannot read sourceRoot/)
  const noLoader = await fixture(t, { nativeLoader: false })
  await assert.rejects(noLoader.agent({ bot: true }), /native skill loader/)
  const malformed = await fixture(t)
  await mkdir(join(malformed.projectRoot, '.agents'))
  await writeFile(join(malformed.projectRoot, '.agents', 'pstack-models.md'), 'how explorer: one\nhow explorer: two\n')
  await assert.rejects(malformed.agent({ bot: true }), /duplicate known role/)
})
