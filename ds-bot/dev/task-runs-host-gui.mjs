// Actual Chrome acceptance. All tasks enter through model tool calls; controls use the rendered UI.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { modelsFor } from '../src/client/agent-routes.js'

const plugin = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const home = resolve(plugin, '../.dsh-test-task-runs-host')
const ports = JSON.parse(readFileSync(join(home, 'ports.json'), 'utf8'))
const base = `http://127.0.0.1:${ports.web}`
assert.notEqual(ports.web, 58705)
const run = `gui-${Date.now()}`
const out = join(home, 'evidence', run)
mkdirSync(out, { recursive: true })
const bytes = readFileSync(join(home, 'web.log'))
const log = bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.subarray(2).toString('utf16le') : bytes.toString('utf8')
const login = log.match(new RegExp(`http://127\\.0\\.0\\.1:${ports.web}/\\?token=[^\\s]+`))?.[0]
if (!login) throw new Error('No isolated login URL')
const { chromium } = createRequire(import.meta.url)('playwright-core')
const browser = await chromium.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true })
const context = await browser.newContext({ viewport: { width: 1600, height: 1200 }, locale: 'en-US', colorScheme: 'dark' })
const page = await context.newPage()
const actions = [], checks = [], errors = []
let owned = [], bot
const safe = value => String(value).replace(/([?&]token=)[^\s"'<>]+/gi, '$1[REDACTED]')
page.on('pageerror', error => errors.push(safe(error.message)))
page.on('response', async response => {
  if (!response.url().endsWith('/api/bot')) return
  try {
    const request = JSON.parse(response.request().postData() ?? '{}')
    if (!String(request.endpoint).startsWith('task-run-')) return
    const result = await response.json()
    actions.push({ at: Date.now(), endpoint: request.endpoint, id: request.payload?.id, text: request.payload?.text, ok: result.ok, status: result.value?.status, error: result.error?.message })
  } catch { /* unrelated aborted requests are reported by visible UI assertions */ }
})
const api = async (endpoint, payload = {}) => {
  const result = await page.evaluate(async ({ endpoint, payload }) => fetch('/api/bot', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint, payload }) }).then(response => response.json()), { endpoint, payload })
  if (!result.ok) throw new Error(`${endpoint}: ${result.error?.message}`)
  return result.value
}
const poll = async (read, predicate, title, timeout = 30000) => {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const value = await read()
    if (predicate(value)) return value
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  throw new Error(`Timed out: ${title}`)
}
const check = (ok, title) => { assert.ok(ok, title); checks.push(title); console.log(`ok ${title}`) }
const shot = async name => { await page.screenshot({ path: join(out, name) }); console.log(`screenshot ${name}`) }
const proxy = () => fetch(`http://127.0.0.1:${ports.proxy}/bench/status`).then(response => response.json())
const release = name => fetch(`http://127.0.0.1:${ports.proxy}/bench/release/${name}`).then(response => response.text())
const responseFor = (endpoint, id) => page.waitForResponse(response => {
  if (!response.url().endsWith('/api/bot')) return false
  try { const body = JSON.parse(response.request().postData() ?? '{}'); return body.endpoint === endpoint && body.payload?.id === id } catch { return false }
})
async function openDetails() {
  await page.locator(`.bt-tile[data-bot-id="${bot.id}"],.bt-row[data-bot-id="${bot.id}"]`).first().click()
  const section = page.getByRole('region', { name: 'Task runs', exact: true })
  if (!await section.isVisible()) await page.getByRole('button', { name: 'View conversation details', exact: true }).click()
  await section.waitFor({ state: 'visible' })
  await section.scrollIntoViewIfNeeded()
  return section
}
try {
  await page.goto(login)
  await page.goto(base)
  check(new URL(page.url()).origin === base && !new URL(page.url()).searchParams.has('token'), 'exact isolated URL and authenticated canonical navigation')
  const notice = page.getByRole('dialog').getByRole('button', { name: 'Continue', exact: true })
  await page.addLocatorHandler(notice, () => notice.click())
  await page.locator('.bt-tile,.bt-row').first().waitFor({ timeout: 60000 })
  const initial = await api('state')
  mkdirSync(join(home, 'bot/workspace'), { recursive: true })
  writeFileSync(join(home, 'bot/workspace/task-run-probe.txt'), 'Isolated TaskRun probe. No personal data.\n')
  const model = modelsFor(initial.models).find(value => value.ref.startsWith('deepseek-official/')) ?? modelsFor(initial.models)[0]
  assert.ok(model, 'A real registered native route is required')
  await api('create-bot', { name: `Task GUI ${run.slice(-6)}`, role: 'Isolated task acceptance', instructions: 'Only perform the authorized synthetic local host acceptance scenario.', model: model.ref, workDir: join(home, 'bot/workspace') })
  bot = (await api('state')).bots.find(value => value.name === `Task GUI ${run.slice(-6)}`)
  assert.ok(bot?.id, 'The dedicated GUI Bot was created through the production API')
  await page.locator(`.bt-tile[data-bot-id="${bot.id}"],.bt-row[data-bot-id="${bot.id}"]`).first().waitFor()
  let section = await openDetails()
  await section.getByText('No task runs yet.', { exact: true }).waitFor()
  await shot('00-empty-task-runs.png')
  await api('send', { sessionId: bot.id, text: 'HOST_GUI_START_TWO_TASKS: start the two authorized independent acceptance instances.' })
  const started = await poll(() => api('state'), state => state.taskRuns.filter(value => value.ownerBotId === bot.id && value.status === 'running').length === 2, 'two native task executions running')
  owned = started.taskRuns.filter(value => value.ownerBotId === bot.id)
  const a = owned.find(value => value.label.startsWith('GUI Task A'))
  const b = owned.find(value => value.label.startsWith('GUI Task B'))
  assert.ok(a && b)
  check(a.id !== b.id && a.sessionId !== b.sessionId, 'two independent run and native Session identities')
  await poll(proxy, value => value.waiting.some(item => item.key === 'a-step') && value.waiting.some(item => item.key === 'b-finish'), 'both model requests independently held')
  const rowA = () => page.locator(`.bt-task-run[data-run-id="${a.id}"]`)
  const rowB = () => page.locator(`.bt-task-run[data-run-id="${b.id}"]`)
  await rowA().waitFor(); await rowB().waitFor()
  await section.scrollIntoViewIfNeeded()
  check(await rowA().getAttribute('data-status') === 'running' && await rowB().getAttribute('data-status') === 'running', 'real GUI displays both running instances')
  await shot('01-two-running.png')
  await rowA().getByRole('button', { name: /^Add instructions to GUI Task A/ }).click()
  await rowA().getByRole('textbox', { name: /^Instructions for GUI Task A/ }).fill('HOST_GUI_A_STEER_ONLY')
  const steered = responseFor('task-run-steer', a.id)
  await rowA().getByRole('button', { name: 'Send', exact: true }).click()
  assert.equal((await (await steered).json()).ok, true)
  await release('a-step')
  const seen = await poll(proxy, value => value.aSteerSeen && value.aSteps >= 2, 'A consumes GUI steer in a later real model request')
  check(seen.aSteerSeen && !seen.bSteerSeen, 'GUI steer reaches A model only, without leaking to sibling B')
  await rowA().getByRole('button', { name: 'Show log', exact: true }).click()
  await rowA().locator('.bt-task-run-log pre').filter({ hasText: 'HOST_GUI_A_STEER_ONLY' }).waitFor()
  await rowA().scrollIntoViewIfNeeded()
  await shot('02-targeted-steer-log.png')
  await rowA().getByRole('button', { name: 'Hide log', exact: true }).click()
  const stop = rowA().getByRole('button', { name: /^Stop GUI Task A/ })
  await stop.click()
  check(await stop.getAttribute('data-confirm') === 'true', 'real GUI requires the explicit second stop confirmation')
  await shot('03-confirm-stop.png')
  const cancelled = responseFor('task-run-cancel', a.id)
  await stop.click()
  assert.equal((await (await cancelled).json()).ok, true)
  await poll(() => api('state'), state => state.taskRuns.find(value => value.id === a.id)?.status === 'cancelled', 'A terminal cancellation')
  check(await rowA().getAttribute('data-status') === 'cancelled' && await rowB().getAttribute('data-status') === 'running', 'GUI stop cancels only A; B stays running')
  await shot('04-a-cancelled-b-running.png')
  await release('b-finish')
  const final = await poll(() => api('state'), state => state.taskRuns.find(value => value.id === b.id)?.status === 'completed', 'B independent completion')
  const finishedB = final.taskRuns.find(value => value.id === b.id)
  check(finishedB.outputLength > finishedB.output.length && !finishedB.output.includes('HOST_GUI_B_TAIL'), 'B retained preview is smaller than its full saved result')
  check(finishedB.stopReason === 'completed' && final.taskRuns.find(value => value.id === a.id).stopReason === 'aborted', 'native completed and aborted outcomes remain distinct')
  await rowB().getByRole('button', { name: 'Show result', exact: true }).click()
  await rowB().locator('.bt-task-run-result pre').filter({ hasText: 'HOST_GUI_B_TAIL' }).waitFor()
  check((await rowB().locator('.bt-task-run-result pre').textContent()).includes('HOST_GUI_B_TAIL'), 'real GUI reads the full saved result beyond its retained preview')
  await rowB().getByRole('button', { name: 'Show log', exact: true }).click()
  await rowB().locator('.bt-task-run-log pre').waitFor()
  check((await rowB().locator('.bt-task-run-log pre').textContent()).includes('HOST_GUI_WORKER_B'), 'real GUI loads persisted native child Session log')
  await rowB().scrollIntoViewIfNeeded()
  await shot('05-b-complete-result-log.png')
  await page.reload()
  await page.locator('.bt-tile,.bt-row').first().waitFor()
  section = await openDetails()
  await rowA().waitFor(); await rowB().waitFor()
  check(await rowA().getAttribute('data-status') === 'cancelled' && await rowB().getAttribute('data-status') === 'completed', 'browser refresh preserves both run identities and terminal states')
  await rowB().getByRole('button', { name: 'Show result', exact: true }).click()
  await rowB().locator('.bt-task-run-result pre').filter({ hasText: 'HOST_GUI_B_TAIL' }).waitFor()
  await section.scrollIntoViewIfNeeded()
  await shot('06-refresh-retained.png')
  check(errors.length === 0, 'no browser page errors during acceptance')
  writeFileSync(join(out, 'result.json'), JSON.stringify({ passed: true, url: base, transport: 'local mock, real published host and Chrome GUI', browser: await browser.version(), botId: bot.id, runs: owned.map(value => ({ id: value.id, sessionId: value.sessionId, label: value.label })), checks, actions, errors, model: await proxy() }, null, 2))
  console.log(`GUI_ACCEPTANCE_PASSED ${out}`)
} catch (error) {
  const message = safe(error.stack ?? error.message)
  console.error(message)
  await page.screenshot({ path: join(out, 'failure.png') }).catch(() => {})
  writeFileSync(join(out, 'result.json'), JSON.stringify({ passed: false, url: base, botId: bot?.id, checks, actions, errors, failure: message }, null, 2))
  for (const record of owned) await api('task-run-cancel', { id: record.id }).catch(() => {})
  process.exitCode = 1
} finally {
  await context.close()
  await browser.close()
}
