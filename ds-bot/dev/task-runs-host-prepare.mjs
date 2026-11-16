// Windows-friendly isolated profile for published dsh. No package or user-data installation.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const plugin = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const root = resolve(plugin, '..')
const name = process.argv.slice(2).find(value => !value.startsWith('--')) ?? 'task-runs-host'
assert.ok(['task-runs-host', 'task-runs-host-final-smoke'].includes(name), 'Only the two isolated TaskRun acceptance benches are allowed')
const home = join(root, `.dsh-test-${name}`)
assert.equal(resolve(home), resolve(root, `.dsh-test-${name}`))
const profile = join(home, 'profiles', name)
const workspace = join(home, 'bot', 'workspace')
const harness = join(plugin, 'dev/harness')
const runtime = JSON.parse(readFileSync(join(harness, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8'))
assert.equal(runtime.version, '0.2.2-rc.1', 'This bench requires the published pinned rc1 runtime')
if (process.argv.includes('--recipe')) {
  const q = value => `'${value.replaceAll("'", "''")}'`
  const command = value => `& $node ${q(join(plugin, value))}`
  console.log([
    '# Run from ds-bot. Each server command below belongs in its own managed PowerShell background job.',
    `$node = ${q(process.execPath)}`, `$env:DSH_HOME = ${q(home)}`,
    '# Prepare once on a fresh name; existing profiles are never wiped:',
    `${command('dev/task-runs-host-prepare.mjs')} ${name}`,
    `$ports = Get-Content -LiteralPath ${q(join(home, 'ports.json'))} -Raw | ConvertFrom-Json`,
    '# Original local mock, own background job:',
    `$env:MOCK_PORT = [string]$ports.mock; $env:MOCK_LOG = ${q(join(home, 'mock.jsonl'))}; $env:MOCK_DELAY_MS = '120'`,
    `${command('dev/mock-llm.mjs')} 2>&1 | Out-File -Encoding utf8 -Width 4096 ${q(join(home, 'mock.out'))}`,
    ...(name === 'task-runs-host' ? ['# TaskRun transparent proxy, separate own background job:', `${command('dev/task-runs-host-mock.mjs')} 2>&1 | Out-File -Encoding utf8 -Width 4096 ${q(join(home, 'task-mock.out'))}`] : []),
    '# Public CLI, separate own background job; clear inherited real API credentials in this child environment first.',
    `$env:DEEPSEEK_API_KEY = 'mock-key'; $env:DEEPSEEK_BASE_URL = 'http://127.0.0.1:' + $ports.${name === 'task-runs-host' ? 'proxy' : 'mock'} + '/v1'`,
    `Set-Location -LiteralPath ${q(workspace)}`,
    `& $node ${q(join(harness, 'node_modules/@deepseek-ai/dsh', runtime.bin.dsh))} --profile ${name} --no-open --port $ports.web 2>&1 | Out-File -Encoding utf8 -Width 4096 ${q(join(home, 'web.log'))}`,
    '# Verify public state, then run unchanged smoke on the fresh team:',
    `${command('dev/task-runs-host-status.mjs')} ${name} --api`,
    `${command('dev/smoke.mjs')} ${name} $ports.web --out ${q(join(home, 'evidence/smoke-transcript.json'))}`,
    ...(name === 'task-runs-host' ? ['# After smoke finishes, the GUI script creates its own new synthetic Bot:', command('dev/task-runs-host-gui.mjs')] : []),
    '# Stop only this invocation\'s managed job ids. Browser scripts close their own contexts and browser in finally.',
    '# Never print web.log or the authentication URL. Only the status helper emits a decoded, redacted log.',
  ].join('\n'))
  process.exit(0)
}
for (const directory of [home, profile, workspace, join(profile, 'node_modules'), join(home, 'evidence')]) mkdirSync(directory, { recursive: true })
const manifest = join(profile, 'package.json')
if (existsSync(manifest)) throw new Error('This isolated bench already exists; retain it or explicitly choose a new run before preparing again')
writeFileSync(manifest, JSON.stringify({ name: 'dsh-profile-task-runs-host', private: true, dependencies: { 'ds-bot': `link:${plugin.replaceAll('\\', '/')}` }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'ds-bot'] } } }, null, 2))
symlinkSync(plugin, join(profile, 'node_modules', 'ds-bot'), 'junction')
const overlays = [
  { id: 'directory-picker', name: '@deepseek-ai/dsh-host-directory-picker-browse' },
  { id: 'bot', config: { checkRatio: 0.45 } },
  { id: 'llm-deepseek', config: { models: [{ id: 'deepseek-flash', contextWindow: 100000, maxTokens: 8000, inputModalities: ['text', 'image'] }, { id: 'deepseek-v4-pro', contextWindow: 100000, maxTokens: 8000 }] } },
]
writeFileSync(join(profile, 'cordis.patch.yml'), JSON.stringify(overlays, null, 2))
writeFileSync(join(workspace, 'task-run-probe.txt'), 'Isolated TaskRun smoke workspace. No personal data.\n')
const unusedPort = () => new Promise((resolve, reject) => {
  const server = createServer()
  server.on('error', reject)
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)) })
})
const used = new Set([58705, 3080])
const nextPort = async () => { let value; do { value = await unusedPort() } while (used.has(value)); used.add(value); return value }
const ports = { web: await nextPort(), proxy: await nextPort(), mock: await nextPort() }
writeFileSync(join(home, 'ports.json'), JSON.stringify(ports, null, 2))
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex')
writeFileSync(join(home, 'evidence', 'build.json'), JSON.stringify({ recordedAt: new Date().toISOString(), sourceTree: plugin, baseCommit: '218a6bd0f42a16a40660b097b9e42b9afba8ca0c', workingTreeChanges: true, clientSha256: sha256(join(plugin, 'client.js')), transport: 'local scripted mock through actual published dsh CLI/HTTP and AgentLoop', realPaidModel: false, publicRuntimeVersion: runtime.version, ...ports }, null, 2))
console.log(JSON.stringify({ home, profile: name, workspace, ...ports }))
