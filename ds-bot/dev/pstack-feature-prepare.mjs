import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readPstackModelSettings } from '../src/host/pstack-models.js'

export const plugin = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const home = resolve(plugin, '..', '.dsh-test-pstack-feature-phase2')
const sourceRoot = resolve(plugin, '..', '..', 'pstack')
const phase2 = 'C:/Users/Sumrain/Documents/deepseek-harness/default-workspace/pstack-dsbot-research/phase2'
const project = resolve(phase2, 'feature-project')
const caseFile = resolve(phase2, 'FEATURE-CASE.md')
const requestFile = resolve(phase2, 'FEATURE-REQUEST.md')
const acceptanceFile = resolve(phase2, 'FEATURE-ACCEPTANCE.md')
const baselineFile = resolve(phase2, 'feature-baseline.json')
const settingsFile = join(project, '.agents', 'pstack-models.md')
const profile = 'pstack-feature-phase2'
const provider = 'feature-gateway'
const primaryId = 'codex/gpt-6-luna'
const baseURL = 'http://127.0.0.1:3425/v1'
const credentialEnv = 'PSTACK_FEATURE_GATEWAY_SYNTHETIC_KEY'
const require = createRequire(join(plugin, 'dev', 'harness', 'package.json'))
const packageFile = name => require.resolve(`${name}/package.json`)
export const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const git = (cwd, ...args) => execFileSync('git', ['--no-optional-locks', '-C', cwd, ...args], { encoding: 'utf8', windowsHide: true }).trim()
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2))
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const manifestFile = join(home, 'evidence', 'g0-prepared.json')
const levels = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

async function freePort() {
  const server = createServer()
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept) })
  const port = server.address().port
  await new Promise(accept => server.close(accept))
  assert.notEqual(port, 58705)
  assert.notEqual(port, 3425)
  return port
}

async function discover() {
  const response = await fetch(`${baseURL}/models`, { redirect: 'error', signal: AbortSignal.timeout(10000) })
  assert.equal(response.status, 200, 'Unauthenticated public model discovery must succeed')
  const { data } = await response.json()
  assert.ok(Array.isArray(data) && data.length === 11, 'Review directory drift before preparing this frozen run')
  const models = data.map(model => {
    assert.match(model.id, /^[a-z0-9][a-z0-9./_-]+$/i)
    assert.ok(Number.isInteger(model.context_window) && model.context_window > 0)
    assert.ok(Number.isInteger(model.max_output_tokens) && model.max_output_tokens > 0)
    const declared = model.reasoning_levels ?? []
    const exposed = declared.map(level => [level === 'none' ? 'off' : level, level]).filter(([level]) => levels.has(level))
    return {
      id: model.id,
      name: model.display_name ?? model.id,
      contextWindow: model.context_window,
      maxTokens: model.max_output_tokens,
      input: (model.modalities?.input ?? ['text']).filter(value => ['text', 'image'].includes(value)),
      reasoning: model.reasoning === true,
      reasoningEfforts: Object.fromEntries(exposed),
      declaredReasoningLevels: declared,
      unexposedReasoningLevels: declared.filter(level => !levels.has(level === 'none' ? 'off' : level)),
      toolsDeclared: model.tool_call === true,
      nativeRef: `${provider}/${model.id}`,
    }
  })
  assert.equal(new Set(models.map(model => model.id)).size, models.length)
  assert.ok(models.some(model => model.id === primaryId))
  return models
}

export async function prepare() {
  assert.equal(existsSync(home), false, 'Preserve existing run homes; choose a new run rather than overwrite')
  const baseline = readJson(baselineFile)
  assert.equal(git(project, 'rev-parse', 'HEAD'), '5a12fdcac36000a1d8b40e8f1ef792dda8ddb37f')
  assert.equal(git(project, 'branch', '--show-current'), 'main')
  assert.equal(git(project, 'status', '--porcelain'), '')
  assert.equal(git(sourceRoot, 'rev-parse', 'HEAD'), 'f905b88ebdd877e6b36fcc791970d47f44d15a15')
  assert.equal(git(sourceRoot, 'status', '--porcelain'), '')
  assert.equal(existsSync(settingsFile), false, 'Keep original missing-settings fallback; do not create inherit settings')
  for (const [path, expected] of Object.entries(baseline.files)) assert.equal(hash(join(project, path)), expected)
  const caseText = readFileSync(caseFile, 'utf8')
  const acIds = [...new Set(caseText.match(/F0[1-6]/g))].sort()
  assert.deepEqual(acIds, ['F01', 'F02', 'F03', 'F04', 'F05', 'F06'])
  const models = await discover()
  const providerConfig = {
    providers: {
      [provider]: {
        displayName: 'Phase2 real loopback gateway',
        apiKeyEnv: credentialEnv,
        api: 'openai-completions',
        baseURL,
        models: models.map(({ id, name, contextWindow, maxTokens, input, reasoningEfforts }) => ({ id, name, contextWindow, maxTokens, input, reasoningEfforts })),
      },
    },
  }
  const { Config } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm-pi-ai')).href)
  Config(providerConfig)
  const sourcePaths = ['plugin.js', 'index.js', 'package.json', ...readdirSync(join(plugin, 'src', 'host'), { recursive: true }).filter(path => /\.(?:js|mjs|md|json)$/.test(path)).map(path => `src/host/${path.replaceAll('\\', '/')}`)]
  const productHashes = Object.fromEntries(sourcePaths.map(path => [path, hash(join(plugin, path))]))
  const roleSettings = await readPstackModelSettings({ sourceRoot, settingsFile })
  const port = await freePort()
  mkdirSync(home)
  for (const folder of ['agents', 'private', 'evidence', `profiles/${profile}/node_modules`]) mkdirSync(join(home, folder), { recursive: true })
  symlinkSync(join(plugin, 'dev', 'harness', 'node_modules'), join(home, 'node_modules'), 'junction')
  symlinkSync(plugin, join(home, 'profiles', profile, 'node_modules', 'ds-bot'), 'junction')
  save(join(home, '.config.yml'), { defaultProfile: profile, profiles: { [profile]: { name: 'Phase2 real Feature', createdAt: new Date().toISOString() } } })
  const profileManifestFile = join(home, 'profiles', profile, 'package.json')
  save(profileManifestFile, { name: 'isolated-pstack-feature-phase2', private: true, dependencies: { 'ds-bot': `link:${plugin.replaceAll('\\', '/')}` }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'ds-bot'] } } })
  const cordis = [
    { id: 'directory-picker', name: '@deepseek-ai/dsh-host-directory-picker-browse' },
    { id: 'sandbox-policy', config: { mode: 'workspace-write', workspaceRoot: project, additionalWritableRoots: [] } },
    { id: 'approval', config: { policy: 'never' } },
    { id: 'permission', config: { defaultPreset: 'workspace-write', presets: { 'read-only': { sandbox: 'read-only', approval: 'never' }, 'workspace-write': { sandbox: 'workspace-write', approval: 'never' } } } },
    { id: 'llm-deepseek', disabled: true },
    { id: 'llm-deepseek-account', disabled: true },
    { id: 'llm-pi-ai', config: providerConfig },
    { id: 'agent-default-model', config: { provider, model: primaryId } },
    { id: 'bot', config: { workspace: project, pstack: { enabled: true, sourceRoot, settingsFile } } },
  ]
  for (const [moduleName, serviceName, id] of [['@deepseek-ai/dsh-sandbox-policy', 'SandboxPolicyService', 'sandbox-policy'], ['@deepseek-ai/dsh-user-approval', 'ApprovalService', 'approval'], ['@deepseek-ai/dsh-permission-presets', 'PermissionPresetService', 'permission']]) {
    const module = await import(pathToFileURL(require.resolve(moduleName)).href)
    module[serviceName].Config(cordis.find(row => row.id === id).config)
  }
  const patchFile = join(home, 'profiles', profile, 'cordis.patch.yml')
  save(patchFile, cordis)
  const chiefInstructions = `You are Chief, the Main Bot coordinating this isolated Feature team. The existing persistent Feature Lead owns the original pstack Feature in its current chat. Hand the user's business demand to that Lead through message_bot, preserving its original thread and scope. Your project is ${project}. The fixed original source is ${sourceRoot}. Business acceptance is ${caseFile}; the local delivery contract is ${acceptanceFile}. No push, PR, merge, deployment, real user application, credential or real DSH configuration access is authorized. Do not treat setup greetings as the business demand.`
  const leadInstructions = `You are the persistent Feature Lead. Work in ${project}. After Chief's real handoff, first completely read ${join(sourceRoot, 'skills', 'poteto-mode', 'SKILL.md')}, including its Principles and Subagents methods, then read ${join(sourceRoot, 'skills', 'poteto-mode', 'playbooks', 'feature.md')} and own the original Feature in this current chat; read the original applicable Skills and resources yourself. The business AC are external at ${caseFile}, and the delivery contract is ${acceptanceFile}. The project and permitted local outputs/worktrees are confined to the project root. Model/effort/fallback decisions remain yours under the fixed source and real available catalog; settings remain missing. Local project edits and commits require the frozen G0 authorization. No push, PR, merge, deployment, real user application, credential or real DSH configuration access is authorized. Treat greetings as setup only and wait for Chief's handoff.`
  const demand = readFileSync(requestFile, 'utf8')
  writeFileSync(join(home, 'private', 'chief-instructions.txt'), chiefInstructions)
  writeFileSync(join(home, 'private', 'lead-instructions.txt'), leadInstructions)
  writeFileSync(join(home, 'private', 'chief-demand.txt'), demand)
  const cli = resolve(dirname(packageFile('@deepseek-ai/dsh')), readJson(packageFile('@deepseek-ai/dsh')).bin.dsh)
  const packages = Object.fromEntries(['@deepseek-ai/dsh', '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-llm-pi-ai'].map(name => [name, readJson(packageFile(name)).version]))
  assert.ok(Object.values(packages).every(version => version === '0.2.2-rc.1'))
  const launchFile = join(home, 'private', 'launch.ps1')
  writeFileSync(launchFile, `Get-ChildItem Env: | Where-Object { $_.Name -match 'API_KEY|TOKEN|SECRET|PASSWORD|BASE_URL|^NODE_OPTIONS$|^DSH_HARNESS$|^DSH_HOME$|^DSH_AGENTS_HOME$' } | ForEach-Object { Remove-Item -LiteralPath ('Env:' + $_.Name) }\nif ((Get-Location).Path -ne '${project}') { throw 'Launch requires the frozen project as process working directory' }\nnode '${join(plugin, 'dev', 'pstack-feature-prepare.mjs')}' check-freeze $env:PSTACK_FEATURE_G0_SHA256\nif ($LASTEXITCODE -ne 0) { throw 'The exact parent-frozen G0 did not validate' }\n$env:DSH_HOME = '${home}'\n$env:DSH_AGENTS_HOME = '${join(home, 'agents')}'\n$env:${credentialEnv} = 'pstack-feature-explicitly-nonsecret-placeholder'\nnode '${cli}' --profile ${profile} --no-open --port ${port} 2>&1 | Out-File -Encoding utf8 -Width 4096 '${join(home, 'private', 'web.log')}'\n`)
  const inputs = Object.fromEntries([requestFile, caseFile, acceptanceFile, baselineFile, profileManifestFile, patchFile, launchFile, ...['chief-instructions.txt', 'lead-instructions.txt', 'chief-demand.txt'].map(name => join(home, 'private', name))].map(path => [path, hash(path)]))
  const manifest = {
    schemaVersion: 1, preparedAt: new Date().toISOString(), status: 'PREPARED_AWAITING_PARENT_G0_FREEZE', inferenceStarted: false, featureVerdict: 'NOT_RUN',
    home, agentsHome: join(home, 'agents'), profile, port, url: `http://127.0.0.1:${port}`, project, sourceRoot,
    baseline: { ...baseline, currentBranch: 'main', cleanAtPrepare: true },
    business: { requestFile, caseFile, acceptanceFile, acIds, verdicts: Object.fromEntries(acIds.map(id => [id, 'NOT_RUN'])) },
    source: { pstackCommit: 'f905b88ebdd877e6b36fcc791970d47f44d15a15', productRoot: plugin, productHashes, productHead: git(plugin, 'rev-parse', 'HEAD'), packages },
    provider: { route: provider, api: 'openai-completions', baseURL, primaryWireId: primaryId, primaryRef: `${provider}/${primaryId}`, credentialEnv, credentialPolicy: 'env reference only; launch assigns an explicitly nonsecret synthetic placeholder; no user header is read or retained', catalogSource: `${baseURL}/models`, catalogAuthenticationSent: false, models, declaredCapabilitiesNotInferenceProof: true, separateSpeedControl: false },
    pstack: { settingsFile, settingsStatus: roleSettings.settingsStatus, defaultsHash: roleSettings.defaultsHash, sourceHash: roleSettings.sourceHash, rows: roleSettings.rows, budget: roleSettings.budget, setupBudgetExecuted: false },
    runtime: { cli, workdir: project, launchFile, hostLog: join(home, 'private', 'web.log'), sandbox: 'workspace-write', approvalPolicy: 'never', sourceReadOnly: true, noReplacementGui: true },
    delivery: { localProjectEditsAndCommits: 'PENDING_PARENT_G0_FREEZE', candidateWorktrees: 'within project root; Lead decides decomposition', push: false, pullRequest: false, merge: false, deploy: false, maximumClaimWithoutRemoteExit: 'PASS_LOCAL' },
    requiredChecks: { baseline: 'npm test: 7/7 recorded', projectScripts: readJson(join(project, 'package.json')).scripts, businessAc: 'real browser and real API on actual final revision; not run by preparer', decisionTrail: 'as applicable under original source; Lead owns it', watchDoesNotProveAcceptance: true },
    parentFreezeMustResolve: ['Link the successful real probe evidence and final regression result', 'Authorize the recorded local edit/commit/worktree boundary and exact Chief/Lead instructions', 'Freeze manifest hash after reviewing route/efforts/speed limitations and source snapshots'],
    frozenInputs: inputs,
    helperHashes: Object.fromEntries(['pstack-feature-prepare.mjs', 'pstack-feature-watch.mjs'].map(name => [name, hash(join(plugin, 'dev', name))])),
  }
  save(manifestFile, manifest)
  console.log(JSON.stringify({ prepared: true, launched: false, inferenceStarted: false, manifest: manifestFile, manifestHash: hash(manifestFile), privateLaunchFile: launchFile, port, modelCount: models.length, primaryRef: manifest.provider.primaryRef, settingsStatus: roleSettings.settingsStatus }))
  return manifest
}

export function loadManifest() {
  const manifest = readJson(manifestFile)
  assert.equal(manifest.home, home)
  assert.equal(manifest.project, project)
  assert.equal(manifest.sourceRoot, sourceRoot)
  return manifest
}

export async function privateApi(manifest) {
  const log = readFileSync(manifest.runtime.hostLog, 'utf8').replaceAll(String.fromCharCode(27), ' ')
  const candidates = log.match(/http:\/\/127\.0\.0\.1:\d+\/[^\s"<>]*/g) ?? []
  const login = candidates.map(value => { try { return new URL(value) } catch { return undefined } }).find(url => url?.origin === manifest.url && /token|login|auth/i.test(url.search))
  assert.ok(login, 'The isolated private log has no usable login link')
  const response = await fetch(login, { redirect: 'manual', signal: AbortSignal.timeout(10000) })
  const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  assert.ok(cookie, 'Isolated login did not set an API session cookie')
  return async (endpoint, body = {}) => {
    const result = await fetch(`${manifest.url}/api/bot`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ endpoint, payload: body }), signal: AbortSignal.timeout(30000) })
    assert.ok(result.ok, `Private DS-Bot API ${endpoint} returned HTTP ${result.status}`)
    const value = await result.json()
    assert.equal(value.ok, true, `Private DS-Bot API ${endpoint} rejected the request`)
    return value.value
  }
}

export function verifyFrozen(expectedHash) {
  assert.match(expectedHash ?? '', /^[a-f0-9]{64}$/, 'Start requires the exact parent-frozen G0 manifest hash')
  assert.equal(hash(manifestFile), expectedHash)
  const manifest = loadManifest()
  assert.equal(manifest.status, 'PARENT_G0_FROZEN')
  assert.equal(manifest.delivery.localProjectEditsAndCommits, true)
  assert.deepEqual(manifest.parentFreezeMustResolve, [])
  assert.equal(git(project, 'rev-parse', 'HEAD'), manifest.baseline.head)
  assert.equal(git(project, 'status', '--porcelain'), '')
  assert.equal(git(sourceRoot, 'rev-parse', 'HEAD'), manifest.source.pstackCommit)
  assert.equal(git(sourceRoot, 'status', '--porcelain'), '')
  assert.equal(existsSync(settingsFile), false)
  for (const [path, expected] of Object.entries(manifest.source.productHashes)) assert.equal(hash(join(plugin, path)), expected, `Frozen runtime changed: ${path}`)
  for (const [path, expected] of Object.entries(manifest.frozenInputs)) assert.equal(hash(path), expected, 'A frozen input changed')
  for (const [name, expected] of Object.entries(manifest.helperHashes)) assert.equal(hash(join(plugin, 'dev', name)), expected, 'A frozen helper changed')
  return manifest
}

export async function bootstrap(expectedHash) {
  const manifest = verifyFrozen(expectedHash)
  assert.equal(existsSync(join(home, 'evidence', 'bootstrap.json')), false, 'Business demand is single-delivery; do not replay bootstrap')
  const api = await privateApi(manifest)
  await api('models')
  const initial = await api('state')
  assert.ok(initial.models.some(model => model.ref === manifest.provider.primaryRef))
  assert.equal(initial.permissions?.defaultPreset, 'workspace-write', 'The materialized native permission default must match frozen G0')
  const chief = initial.bots.find(bot => initial.mainBotIds.includes(bot.id))
  assert.ok(chief)
  assert.equal(initial.bots.length, 1)
  assert.equal(initial.taskRuns.length, 0)
  await api('update-bot', { id: chief.id, name: 'Feature Chief', role: 'Chief', workDir: project, instructions: readFileSync(join(home, 'private', 'chief-instructions.txt'), 'utf8') })
  const lead = await api('create-bot', { name: 'Feature Lead', role: 'Lead', workDir: project, model: manifest.provider.primaryRef, instructions: readFileSync(join(home, 'private', 'lead-instructions.txt'), 'utf8') })
  save(join(home, 'evidence', 'bootstrap.json'), { startedAt: new Date().toISOString(), frozenManifestHash: expectedHash, chiefId: chief.id, leadId: lead.id, demandSent: false, realInference: true })
  await api('update-bot', { id: chief.id, model: manifest.provider.primaryRef })
  const state = await api('state')
  const currentChief = state.bots.find(bot => bot.id === chief.id)
  assert.ok(currentChief && typeof currentChief.sessionId === 'string', 'The Chief must have an explicit current own-chat Session')
  const demand = `${readFileSync(join(home, 'private', 'chief-demand.txt'), 'utf8')}\n\nThe operator froze this run's G0 at ${manifestFile}, SHA256 ${expectedHash}. Local project edits and commits within the frozen project boundary are authorized. Existing Feature Lead id: ${lead.id}. Preserve the real message_bot handoff to that persistent Lead.`
  await api('send', { sessionId: currentChief.sessionId, text: demand })
  save(join(home, 'evidence', 'bootstrap.json'), { startedAt: new Date().toISOString(), frozenManifestHash: expectedHash, chiefId: chief.id, leadId: lead.id, demandSent: true, sentOnlyToChief: true, handoff: 'Chief must perform real message_bot', realInference: true })
  console.log(JSON.stringify({ bootstrapped: true, chiefId: chief.id, leadId: lead.id, demandSentOnlyToChief: true, watcherIsReadOnly: true }))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2] ?? 'prepare'
  if (mode === 'prepare') await prepare()
  else if (mode === 'bootstrap') await bootstrap(process.argv[3])
  else if (mode === 'check-freeze') { verifyFrozen(process.argv[3]); console.log(JSON.stringify({ frozenG0Valid: true, inferenceStarted: false })) }
  else if (mode === 'status') console.log(JSON.stringify({ manifest: manifestFile, manifestHash: hash(manifestFile), ...loadManifest(), frozenInputs: undefined, source: undefined, helperHashes: undefined }))
  else throw new Error('Use prepare, status, or bootstrap <parent-frozen-manifest-sha256>')
}
