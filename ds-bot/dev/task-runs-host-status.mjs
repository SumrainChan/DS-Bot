// Inspect only the isolated bench; never print its authentication URL or cookie.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const name = process.argv.includes('task-runs-host-final-smoke') ? 'task-runs-host-final-smoke' : 'task-runs-host'
const home = resolve(dirname(fileURLToPath(import.meta.url)), `../../.dsh-test-${name}`)
const ports = JSON.parse(readFileSync(join(home, 'ports.json'), 'utf8'))
const url = `http://127.0.0.1:${ports.web}`
const info = { url }
const decodedLog = () => {
  const bytes = readFileSync(join(home, 'web.log'))
  return bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.subarray(2).toString('utf16le') : bytes.toString('utf8')
}
const bootLog = () => decodedLog().replace(/([?&]token=)[^\s"'<>]+/gi, '$1[REDACTED]')
if (process.argv.includes('--archive-boot-failure')) writeFileSync(join(home, 'evidence/boot-1.redacted.log'), bootLog())
try {
  const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) })
  Object.assign(info, { status: response.status, bootReachable: true })
} catch (error) {
  Object.assign(info, { bootReachable: false, error: error.message })
  console.log(bootLog().split('\n').slice(-40).join('\n'))
}
if (process.argv.includes('--log')) console.log(bootLog().split('\n').slice(-60).join('\n'))
if (process.argv.includes('--api')) {
  const login = decodedLog().match(new RegExp(`http://127\\.0\\.0\\.1:${ports.web}/\\?token=[^\\s]+`))?.[0]
  if (!login) throw new Error('No isolated bench login URL')
  const response = await fetch(login, { redirect: 'manual' })
  const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  const result = await fetch(`${url}/api/bot`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ endpoint: 'state', payload: {} }) }).then(value => value.json())
  if (!result.ok) throw new Error(`Isolated Bot state failed: ${result.error?.message}`)
  info.bot = { count: result.value.bots.length, names: result.value.bots.map(value => value.name), taskRunsAvailable: result.value.taskRunsAvailable, tasks: result.value.taskRuns.length }
  info.inactiveWarning = bootLog().includes('entry did not activate')
  writeFileSync(join(home, 'evidence/boot-current.redacted.log'), bootLog())
}
try { info.proxy = await fetch(`http://127.0.0.1:${ports.proxy}/bench/status`).then(response => response.json()) } catch (error) { info.proxyError = error.message }
writeFileSync(join(home, 'evidence/readiness.json'), JSON.stringify(info, null, 2))
console.log(JSON.stringify(info))
if (!info.bootReachable) process.exitCode = 1
