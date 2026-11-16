// Read-only Chrome revisit of one completed scenario: visible result tail and actual log page counts.
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const home = resolve(dirname(fileURLToPath(import.meta.url)), '../../.dsh-test-task-runs-host')
const scenario = process.argv[2]
assert.match(scenario, /^gui-\d+$/)
const original = JSON.parse(readFileSync(join(home, 'evidence', scenario, 'result.json'), 'utf8'))
assert.equal(original.passed, true)
const ports = JSON.parse(readFileSync(join(home, 'ports.json'), 'utf8'))
const base = `http://127.0.0.1:${ports.web}`
const bytes = readFileSync(join(home, 'web.log'))
const log = bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.subarray(2).toString('utf16le') : bytes.toString('utf8')
const login = log.match(new RegExp(`http://127\\.0\\.0\\.1:${ports.web}/\\?token=[^\\s]+`))?.[0]
assert.ok(login)
const out = join(home, 'evidence', `revisit-${Date.now()}`)
mkdirSync(out)
const { chromium } = createRequire(import.meta.url)('playwright-core')
const browser = await chromium.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true })
const context = await browser.newContext({ viewport: { width: 1600, height: 1200 }, locale: 'en-US', colorScheme: 'dark' })
const page = await context.newPage()
const safe = value => String(value).replace(/([?&]token=)[^\s"'<>]+/gi, '$1[REDACTED]')
const api = async (endpoint, payload = {}) => {
  const response = await page.evaluate(async data => fetch('/api/bot', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }).then(value => value.json()), { endpoint, payload })
  assert.equal(response.ok, true, response.error?.message)
  return response.value
}
try {
  await page.goto(login); await page.goto(base)
  const notice = page.getByRole('dialog').getByRole('button', { name: 'Continue', exact: true })
  await page.addLocatorHandler(notice, () => notice.click())
  await page.locator(`.bt-row[data-bot-id="${original.botId}"]`).waitFor()
  await page.locator(`.bt-row[data-bot-id="${original.botId}"]`).click()
  await page.getByRole('button', { name: 'View conversation details', exact: true }).click()
  const region = page.getByRole('region', { name: 'Task runs', exact: true })
  await region.waitFor()
  const state = await api('state')
  const results = []
  for (const execution of original.runs) {
    const saved = state.taskRuns.find(value => value.id === execution.id)
    assert.equal(saved.sessionId, execution.sessionId)
    const history = await api('task-run-log', { id: execution.id })
    results.push({ id: saved.id, sessionId: saved.sessionId, status: saved.status, stopReason: saved.stopReason, notification: saved.notification, previewLength: saved.output?.length ?? 0, outputLength: saved.outputLength ?? 0, eventsOnFirstPage: history.events.length, next: history.next })
  }
  const b = results.find(value => value.status === 'completed')
  const a = results.find(value => value.status === 'cancelled')
  assert.ok(a && b)
  assert.equal(b.notification, 'delivered')
  const rowB = page.locator(`.bt-task-run[data-run-id="${b.id}"]`)
  await rowB.getByRole('button', { name: 'Show result', exact: true }).click()
  const result = rowB.locator('.bt-task-run-result pre')
  await result.filter({ hasText: 'HOST_GUI_B_TAIL' }).waitFor()
  await result.evaluate(element => { element.scrollTop = element.scrollHeight })
  assert.ok(await result.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop < 3))
  await rowB.getByRole('button', { name: 'Show log', exact: true }).click()
  const history = rowB.locator('.bt-task-run-log pre')
  await history.waitFor()
  await history.evaluate(element => { element.scrollTop = element.scrollHeight })
  await history.scrollIntoViewIfNeeded()
  const more = rowB.getByRole('button', { name: 'Load more log entries', exact: true })
  let paginationExercised = false
  if (b.next !== null) {
    await more.click()
    paginationExercised = true
  } else assert.equal(await more.count(), 0)
  await page.screenshot({ path: join(out, '07-visible-full-result-tail-and-log.png') })
  await rowB.getByRole('button', { name: 'Hide log', exact: true }).click()
  await rowB.getByRole('button', { name: 'Hide result', exact: true }).click()
  await region.scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(out, '08-terminal-states-and-result-returned.png') })
  const evidence = { passed: true, url: base, sourceScenario: scenario, readOnlyRevisit: true, newBrowserContext: true, newModelScenario: false, browser: await browser.version(), fullResultTailVisible: true, resultDeliveryConfirmed: true, results, paginationExercised, paginationNote: paginationExercised ? 'Actual next log page requested through the GUI' : 'Both real logs fit in their first 200-event page; log reading is proven, pagination is not exercised.' }
  writeFileSync(join(out, 'result.json'), JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify(evidence))
  console.log(`GUI_REVISIT_PASSED ${out}`)
} catch (error) {
  console.error(safe(error.stack ?? error.message))
  process.exitCode = 1
} finally {
  await context.close()
  await browser.close()
}
