// Field-allowlisted offline evidence from this bench only; never copy state, headers, or credentials.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const home = resolve(dirname(fileURLToPath(import.meta.url)), '../../.dsh-test-task-runs-host')
const [scenario, revisit] = process.argv.slice(2)
assert.match(scenario, /^gui-\d+$/)
assert.match(revisit, /^revisit-\d+$/)
const gui = JSON.parse(readFileSync(join(home, 'evidence', scenario, 'result.json'), 'utf8'))
const viewed = JSON.parse(readFileSync(join(home, 'evidence', revisit, 'result.json'), 'utf8'))
assert.equal(gui.passed, true)
assert.equal(viewed.passed, true)
assert.equal(viewed.sourceScenario, scenario)
const saved = JSON.parse(readFileSync(join(home, 'bot/state.json'), 'utf8'))
const runs = gui.runs.map(({ id, sessionId }) => {
  assert.match(id, /^run-[0-9a-f-]{36}$/)
  const record = saved.taskRuns[id]
  assert.equal(record.sessionId, sessionId)
  assert.equal(record.ownerBotId, gui.botId)
  const observed = viewed.results.find(value => value.id === id)
  assert.equal(record.status, observed.status)
  assert.equal(record.stopReason, observed.stopReason)
  const result = JSON.parse(readFileSync(join(home, 'bot/task-results', `${id}.json`), 'utf8'))
  assert.equal(result.stopReason, record.stopReason)
  assert.equal(result.output.length, record.outputLength)
  return {
    id, sessionId, label: record.label, status: record.status, admission: record.admission ?? null,
    nativeRunId: record.runId, nativeStopReason: record.stopReason,
    provider: record.actualModel?.provider ?? record.provider, model: record.actualModel?.model ?? record.model,
    effort: record.actualModel?.reasoningEffort ?? record.effort ?? null,
    mode: record.sandboxMode, outputLength: record.outputLength, retainedPreviewLength: record.output?.length ?? 0,
    resultSaved: record.resultSaved === true, fullResultTailPresent: result.output.includes('HOST_GUI_B_TAIL'),
    notification: record.notification?.status ?? null,
    log: { eventsOnFirstPage: observed.eventsOnFirstPage, next: observed.next },
  }
})
const facts = {
  capturedAt: new Date().toISOString(), fixtureOnly: true, url: gui.url, sourceScenario: scenario,
  sources: { execution: 'Durable isolated bot/state.json, allowlisted fields only; per-run durable result lengths cross-checked', log: `${revisit}/result.json from authenticated public task-run-log queries after both runs settled` },
  ownerBotId: gui.botId, runs, paginationExercised: viewed.paginationExercised,
}
const output = join(home, 'evidence/final-facts.json')
writeFileSync(output, JSON.stringify(facts, null, 2))
console.log(JSON.stringify({ output, runs: runs.map(value => ({ id: value.id, status: value.status, admission: value.admission, nativeStopReason: value.nativeStopReason, outputLength: value.outputLength, events: value.log.eventsOnFirstPage, next: value.log.next })) }))
