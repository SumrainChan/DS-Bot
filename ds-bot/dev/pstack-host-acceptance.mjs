import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, createConnection } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readPstackModelSettings } from '../src/host/pstack-models.js'

const plugin = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const root = resolve(plugin, '..')
const name = process.argv.includes('--off') ? 'pstack-harness-off' : 'pstack-harness'
const home = join(root, `.dsh-test-${name}`)
assert.equal(resolve(home), resolve(root, `.dsh-test-${name}`))
const profile = join(home, 'profiles', name), workspace = join(home, 'bot', 'workspace')
const sourceRoot = 'D:\\workspace-agent\\coding-trail\\pstack'
const settingsFile = join(workspace, '.agents', 'pstack-models.md')
const deniedWritePath = join(workspace, 'pstack-readonly-denied.txt')
const hash = value => createHash('sha256').update(value).digest('hex')
const sha256 = path => hash(readFileSync(path))
const evidence = value => writeFileSync(join(home, 'evidence', value.name), JSON.stringify(value.data, null, 2))
const portsOf = () => JSON.parse(readFileSync(join(home, 'ports.json'), 'utf8'))
const bytesText = path => {
  const bytes = readFileSync(path)
  return bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.subarray(2).toString('utf16le') : bytes.toString('utf8')
}
const redact = value => value.replace(/([?&]token=)[^\s"'<>]+/gi, '$1[REDACTED]')
const calls = () => {
  const path = join(home, 'pstack-model.jsonl')
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(read, label, timeout = 45000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await read()
    if (value) return value
    await wait(100)
  }
  throw new Error(`Timed out: ${label}`)
}

if (process.argv[2] === 'prepare') {
  const runtimeFile = join(plugin, 'dev', 'harness', 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  const runtime = JSON.parse(readFileSync(runtimeFile, 'utf8'))
  assert.equal(runtime.version, '0.2.2-rc.1')
  const manifest = join(profile, 'package.json')
  assert.ok(!existsSync(manifest), 'Use a fresh isolated profile; this script never resets existing data')
  for (const path of [profile, join(profile, 'node_modules'), join(workspace, '.agents'), join(home, 'agents'), join(home, 'evidence')]) mkdirSync(path, { recursive: true })
  writeFileSync(manifest, JSON.stringify({ name: `dsh-profile-${name}`, private: true, dependencies: { 'ds-bot': `link:${plugin.replaceAll('\\', '/')}` }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'ds-bot'] } } }, null, 2))
  symlinkSync(plugin, join(profile, 'node_modules', 'ds-bot'), 'junction')
  writeFileSync(settingsFile, '# budget: host-protocol (high)\nhow explorer: deepseek-official/deepseek-flash\nhow explainer: auto\narena runners: deepseek-official/deepseek-v4-pro, deepseek-official/deepseek-flash, deepseek-official/deepseek-v4-pro\narena cross-judge pool: deepseek-official/deepseek-flash, inherit-parent\narchitect runners: deepseek-official/deepseek-flash, deepseek-official/deepseek-v4-pro\n')
  writeFileSync(join(workspace, 'pstack-probe.txt'), 'Synthetic public host acceptance workspace.\n')
  writeFileSync(join(profile, 'cordis.patch.yml'), JSON.stringify([
    { id: 'directory-picker', name: '@deepseek-ai/dsh-host-directory-picker-browse' },
    { id: 'bot', config: { checkRatio: 0.45, pstack: { enabled: name === 'pstack-harness', sourceRoot, settingsFile } } },
    { id: 'llm-deepseek', config: { models: [{ id: 'deepseek-flash', contextWindow: 100000, maxTokens: 8000, inputModalities: ['text', 'image'] }, { id: 'deepseek-v4-pro', contextWindow: 100000, maxTokens: 8000 }] } },
  ], null, 2))
  const used = new Set([58705, 3080])
  const unused = () => new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)) })
  })
  const next = async () => { let port; do { port = await unused() } while (used.has(port)); used.add(port); return port }
  const ports = { web: await next(), proxy: await next(), mock: await next() }
  writeFileSync(join(home, 'ports.json'), JSON.stringify(ports, null, 2))
  const settings = await readPstackModelSettings({ sourceRoot, settingsFile })
  const sourceHashes = Object.fromEntries(['plugin.js', 'index.js', 'package.json', 'src/host/pstack.js', 'src/host/pstack-models.js', 'src/host/task-runs.js', 'src/host/task-executor.js', 'src/host/capabilities.js'].map(path => [path, sha256(join(plugin, path))]))
  evidence({ name: 'build.json', data: { recordedAt: new Date().toISOString(), publicRuntimeVersion: runtime.version, cli: join(dirname(runtimeFile), runtime.bin.dsh), home, workspace, agentsHome: join(home, 'agents'), sourceRoot, settingsFile, sourceHash: settings.sourceHash, defaultsHash: settings.defaultsHash, sourceHashes, rows: settings.rows.length, ...ports, realInference: false, resolverHook: false } })
  console.log(JSON.stringify({ prepared: true, name, home, workspace, sourceRoot, sourceHash: settings.sourceHash, sourceHashes, ...ports }))
} else if (process.argv[2] === 'closed') {
  const ports = portsOf()
  const listening = port => new Promise(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port })
    socket.setTimeout(1500)
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('error', () => { socket.destroy(); resolve(false) })
    socket.once('timeout', () => { socket.destroy(); resolve(false) })
  })
  const open = Object.fromEntries(await Promise.all(Object.entries(ports).map(async ([key, port]) => [key, await listening(port)])))
  evidence({ name: 'closed.json', data: { recordedAt: new Date().toISOString(), ports, listening: open } })
  console.log(JSON.stringify({ ports, listening: open }))
  assert.ok(Object.values(open).every(value => !value), 'All servers started for this bench must stop')
} else {
  const ports = portsOf(), base = `http://127.0.0.1:${ports.web}`
  const logPath = join(home, 'web.log')
  await until(async () => {
    if (!existsSync(logPath) || !bytesText(logPath).includes(`http://127.0.0.1:${ports.web}/?token=`)) return false
    try { return (await fetch(base, { redirect: 'manual', signal: AbortSignal.timeout(1500) })).status < 500 } catch { return false }
  }, 'published CLI login readiness')
  const log = bytesText(logPath)
  writeFileSync(join(home, 'evidence', 'boot.redacted.log'), redact(log))
  assert.ok(!/entry did not activate|failed to activate|deadlock/i.test(log), 'Public profile must activate without deadlock or inactive entries')
  const login = log.match(new RegExp(`http://127\\.0\\.0\\.1:${ports.web}/\\?token=[^\\s]+`))?.[0]
  assert.ok(login, 'The isolated public host issued its own login URL')
  const response = await fetch(login, { redirect: 'manual' })
  const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  assert.ok(cookie, 'The isolated host accepts its own login token')
  const api = async (endpoint, payload = {}) => {
    const res = await fetch(`${base}/api/bot`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ endpoint, payload }) })
    const value = await res.json()
    assert.equal(value.ok, true, `${endpoint}: ${value.error?.message ?? res.status}`)
    return value.value
  }
  const quiet = async () => {
    let seen = calls().length, since = Date.now()
    await until(async () => {
      const state = await api('state'), count = calls().length
      if (Object.keys(state.activity ?? {}).length > 0 || count !== seen) { since = Date.now(); seen = count; return false }
      return Date.now() - since > 700
    }, 'isolated Bot quiet')
  }
  const state = await api('state')
  assert.equal(state.bots.length, 1)
  assert.equal(state.taskRunsAvailable, true)
  if (process.argv[2] === 'status') {
    console.log(JSON.stringify({ ready: true, name, url: base, bots: state.bots.map(bot => ({ name: bot.name, waiting: bot.waiting === true })), modelRefs: state.models.map(model => model.ref), taskRunsAvailable: state.taskRunsAvailable }))
  } else {
    assert.equal(process.argv[2], 'verify')
    assert.equal(existsSync(deniedWritePath), false, 'The negative mutation probe must start absent')
    const checks = []
    const check = (label, run) => { run(); checks.push(label); console.log(`ok ${label}`) }
    const model = state.models.find(entry => entry.ref === 'deepseek-official/deepseek-v4-pro')?.ref
    assert.ok(model, 'Only the explicit loopback DeepSeek route is selected')
    const chief = state.bots[0]
    await api('update-bot', { id: chief.id, model })
    await quiet()
    check('public host bootstrap first Bot request has its enabled source binding without inactive entry', () => {
      const first = calls().find(call => call.kind === 'request' && call.tools.length > 0)
      assert.ok(first)
      assert.equal(first.mappingCount, 1)
      assert.equal(first.sourceSeen, true)
      assert.equal(first.settingsSeen, true)
      assert.ok(first.tools.includes('pstack_preflight'))
    })
    const send = async text => { const before = calls().length; await api('send', { sessionId: chief.sessionId ?? chief.id, text }); await quiet(); return calls().slice(before) }
    for (const name of ['how', 'arena', 'architect']) {
      const observed = await send(`/${name} PSTACK_HOST_ENTRY_${name}`)
      const first = observed.find(call => call.kind === 'request' && call.phase === `ENTRY_${name}`)
      check(`native direct /${name} first prompt has original body, resource base and same mapping`, () => {
        assert.ok(first)
        assert.equal(first.mappingCount, 1)
        assert.equal(first.sourceSeen, true)
        assert.equal(first.settingsSeen, true)
        assert.equal(first.skills.find(skill => skill.name === name)?.originalBody, true)
        assert.equal(first.skills.find(skill => skill.name === name)?.resourceBaseSeen, true)
      })
    }
    const observed = await send('PSTACK_HOST_PREFLIGHT')
    const facts = observed.find(call => call.kind === 'preflight-result' && !call.worker)
    check('real model preflight returns 17 role facts, 58 source Skills and 57 disabled flags', () => {
      assert.ok(facts)
      assert.equal(facts.rows.length, 17)
      assert.equal(facts.skillCount, 58)
      assert.equal(facts.disabledCount, 57)
      assert.equal(facts.binding.sourceRoot, sourceRoot)
      assert.equal(facts.binding.settingsFile, settingsFile)
      assert.equal(facts.catalogAvailable, true)
      assert.ok(facts.modelRefs.includes(model))
      assert.equal(facts.selection.provider + '/' + facts.selection.model, model)
      assert.equal(facts.execution.separateSpeedControl, false)
      assert.deepEqual(facts.rows.find(row => row.role === 'arena runners').values, ['deepseek-official/deepseek-v4-pro', 'deepseek-official/deepseek-flash', 'deepseek-official/deepseek-v4-pro'])
      assert.equal(facts.rows.find(row => row.role === 'arena cross-judge pool').kind, 'pool')
      assert.ok(facts.rows.some(row => row.origin === 'skill-default'))
    })
    await send('PSTACK_HOST_MODEL_SKILL')
    check('actual model skill call preserves source model-invocation refusal', () => assert.ok(calls().some(call => call.kind === 'skill-refusal' && call.refused)))
    await send('PSTACK_HOST_START_TASK')
    const run = await until(async () => (await api('state')).taskRuns.find(run => run.label === 'pstack host worker' && !['starting', 'running'].includes(run.status)), 'real public host TaskRun completion')
    const rows = calls()
    const workerFirst = rows.find(call => call.kind === 'request' && call.worker)
    const workerFacts = rows.find(call => call.kind === 'preflight-result' && call.worker)
    check('real TaskRun first prompt and scoped preflight inherit source and settings without Bot powers', () => {
      assert.equal(run.status, 'completed')
      assert.ok(workerFirst)
      assert.equal(workerFirst.mappingCount, 1)
      assert.equal(workerFirst.sourceSeen, true)
      assert.equal(workerFirst.settingsSeen, true)
      assert.ok(workerFirst.tools.includes('pstack_preflight'))
      for (const tool of ['create_bot', 'message_bot', 'stop_bot', 'subagent', 'workflow', 'ask_user_question']) assert.ok(!workerFirst.tools.includes(tool), `${tool} absent from worker`)
      assert.ok(workerFacts)
      assert.equal(workerFacts.rows.length, 17)
      assert.equal(workerFacts.skillCount, 58)
      assert.equal(workerFacts.disabledCount, 57)
      assert.equal(workerFacts.execution.tools.ask_user, false)
      assert.equal(workerFacts.execution.tools.start_task, true)
      assert.equal(workerFacts.execution.tools.skill, workerFirst.tools.includes('skill'))
      assert.equal(workerFacts.execution.tools.read, workerFirst.tools.includes('read'))
      assert.equal(workerFacts.execution.tools.read, true)
      assert.equal(run.sandboxMode, 'read-only')
      assert.equal(run.pstack.sourceRoot, sourceRoot)
      assert.equal(run.pstack.settingsFile, settingsFile)
      assert.deepEqual(run.pstack.fingerprints, facts.binding.fingerprints)
    })
    const read = rows.find(call => call.kind === 'source-read-result' && call.worker)
    check('read-only worker reads the complete original source contract with its native reader schema', () => {
      assert.ok(read, 'The worker actually issued a native read tool call and received its result')
      assert.equal(read.path, join(sourceRoot, 'skills', 'how', 'SKILL.md'))
      assert.equal(read.sourceHash, sha256(read.path))
      assert.equal(read.isError, false)
      assert.equal(read.orderedLinesComplete, true)
      assert.ok(read.originalNonemptyLines > 10)
      assert.ok(read.schemaRequired.every(name => Object.hasOwn(read.input, name)))
    })
    const deniedWrite = rows.find(call => call.kind === 'readonly-write-result' && call.worker)
    check('the inherited native write tool is actually denied in readonly mode without a filesystem effect', () => {
      assert.ok(deniedWrite, 'The real native write tool returned a result')
      assert.equal(deniedWrite.path, deniedWritePath)
      assert.equal(deniedWrite.isError, true)
      assert.equal(deniedWrite.sandboxDenied, true)
      assert.equal(deniedWrite.fileExists, false)
      assert.equal(existsSync(deniedWritePath), false)
      assert.ok(deniedWrite.schemaRequired.every(name => deniedWrite.inputFields.includes(name)))
    })
    check('worker native tool names stay within the caller admitted inheritedTools upper bound', () => {
      assert.ok(Array.isArray(run.inheritedTools))
      assert.ok(run.inheritedTools.includes('read'))
      assert.ok(run.inheritedTools.includes('write'))
      const own = new Set(['start_task', 'list_task_runs', 'read_task_run', 'steer_task', 'cancel_task', 'pstack_preflight'])
      for (const name of workerFirst.tools) assert.ok(own.has(name) || run.inheritedTools.includes(name), `${name} must be admitted by the caller`)
    })
    const saved = JSON.parse(readFileSync(join(home, 'bot', 'state.json'), 'utf8'))
    check('worker identity stays outside Bot indices and retains durable result', () => {
      assert.equal(saved.bots[run.sessionId], undefined)
      assert.equal(saved.agents[run.sessionId], undefined)
      assert.ok(!saved.mainBotIds.includes(run.sessionId))
      assert.equal(saved.taskRuns[run.id].resultSaved, true)
      assert.ok(!rows.some(call => call.session === saved.taskRuns[run.id].hostSessionId))
    })
    const build = JSON.parse(readFileSync(join(home, 'evidence', 'build.json'), 'utf8'))
    check('frozen product and source hashes match the prepared public profile', () => {
      for (const [path, expected] of Object.entries(build.sourceHashes)) assert.equal(sha256(join(plugin, path)), expected, `source changed while host ran: ${path}`)
      assert.equal(sha256(join(sourceRoot, 'skills', 'setup-pstack', 'SKILL.md')), build.sourceHash)
    })
    evidence({ name: 'acceptance.json', data: { capturedAt: new Date().toISOString(), passed: true, publicRuntimeVersion: '0.2.2-rc.1', url: base, realInference: false, scope: 'published CLI assembly and scripted protocol only', checks, roles: facts.rows.length, skills: facts.skillCount, disabledSkills: facts.disabledCount, sourceHash: build.sourceHash, sourceHashes: build.sourceHashes, sourceRead: read, readonlyWrite: deniedWrite, workerToolNames: workerFirst.tools, inheritedTools: run.inheritedTools, workerExecution: workerFacts.execution, task: { id: run.id, sessionId: run.sessionId, status: run.status, pstack: run.pstack }, requestCount: calls().filter(call => call.kind === 'request').length } })
    console.log(JSON.stringify({ passed: true, checks: checks.length, evidence: join(home, 'evidence', 'acceptance.json'), realInference: false }))
  }
}
