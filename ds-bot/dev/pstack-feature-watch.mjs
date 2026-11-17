import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createConnection } from 'node:net'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { home, loadManifest, privateApi, hash } from './pstack-feature-prepare.mjs'

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const git = (cwd, ...args) => execFileSync('git', ['--no-optional-locks', '-C', cwd, ...args], { encoding: 'utf8', windowsHide: true }).trim()
const safeText = value => value.replace(/([?&](?:token|key|auth|password)=)[^\s&#"<>]+/gi, '$1[REDACTED]').replace(/(authorization\s*[:=]\s*(?:bearer|basic)\s+)\S+/gi, '$1[REDACTED]')
function safe(value, key = '') {
  if (/^(?:headers|authorization|cookie|apiKey|api_key|secret|password|credentials?|access_token|refresh_token)$/i.test(key)) return '[REDACTED]'
  if (typeof value === 'string') return safeText(value)
  if (Array.isArray(value)) return value.map(item => safe(item))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, safe(item, name)]))
  return value
}

async function listening(port) {
  return new Promise(accept => {
    const socket = createConnection({ host: '127.0.0.1', port })
    socket.setTimeout(1000)
    socket.once('connect', () => { socket.destroy(); accept(true) })
    socket.once('error', () => accept(false))
    socket.once('timeout', () => { socket.destroy(); accept(false) })
  })
}

export async function observe(api, manifest) {
  const state = await api('state')
  const raw = existsSync(join(home, 'bot', 'state.json')) ? JSON.parse(readFileSync(join(home, 'bot', 'state.json'), 'utf8')) : {}
  const chats = []
  for (const bot of state.bots) {
    const pages = [], seenCursors = new Set()
    let cursor
    do {
      const page = await api('chat', { botId: bot.id, steps: true, ...(cursor ? { cursor } : {}) })
      const path = join(home, 'private', 'chats', `${bot.id}-${digest(safe(page))}.json`)
      if (!existsSync(path)) writeFileSync(path, JSON.stringify(safe(page), null, 2))
      pages.push({ path, sessionId: page.sessionId, snapshotHash: hash(path), nextCursor: page.cursor ?? null })
      cursor = page.cursor
      if (cursor) { const key = JSON.stringify(cursor); assert.ok(!seenCursors.has(key), 'Public chat pagination repeated a cursor'); seenCursors.add(key) }
    } while (cursor)
    chats.push({ botId: bot.id, pages, note: 'All public chat pages observed in this sweep; canonical native books remain runtime-owned' })
  }
  const runs = (state.taskRuns ?? []).map(run => ({ id: run.id, sessionId: run.sessionId, parentRunId: run.parentRunId, parentSessionId: run.parentSessionId, callerSessionId: run.callerSessionId, ownerBotId: run.ownerBotId, status: run.status, label: run.label, requestedModel: run.requestedModel, actualModel: run.actualModel, model: run.model, effort: run.effort, cwd: run.cwd, sandboxMode: run.sandboxMode, approvalPolicy: run.approvalPolicy, inheritedTools: run.inheritedTools, resultSaved: raw.taskRuns?.[run.id]?.resultSaved, hostSessionId: raw.taskRuns?.[run.id]?.hostSessionId }))
  const snapshot = {
    observedAt: new Date().toISOString(), observationalOnly: true, featureVerdict: 'NOT_ASSESSED_BY_WATCHER',
    bots: state.bots.map(bot => ({ id: bot.id, sessionId: bot.sessionId, name: bot.name, role: bot.role, main: state.mainBotIds.includes(bot.id), model: bot.model, effort: bot.effort, workDir: bot.workDir })),
    activity: safe(state.activity ?? {}), taskRuns: runs, chatSnapshots: chats,
    mainBotIds: [...state.mainBotIds],
    project: { path: manifest.project, head: git(manifest.project, 'rev-parse', 'HEAD'), branch: git(manifest.project, 'branch', '--show-current'), status: git(manifest.project, 'status', '--porcelain'), worktrees: git(manifest.project, 'worktree', 'list', '--porcelain') },
    sourceSnapshotChanged: Object.entries(manifest.source.productHashes).filter(([path, expected]) => hash(join(manifest.source.productRoot, path)) !== expected).map(([path]) => path),
    notes: ['Idle/completed states do not establish Feature acceptance', 'Watcher never sends messages, resumes agents, runs project checks, edits code, or dispatches playbook steps', 'Public chat pages are copied without claiming raw provider HTTP or complete canonical native event capture'],
  }
  writeFileSync(join(home, 'evidence', 'watch-latest.json'), JSON.stringify(safe(snapshot), null, 2))
  appendFileSync(join(home, 'evidence', 'watch.jsonl'), `${JSON.stringify(safe(snapshot))}\n`)
  console.log(JSON.stringify({ observedAt: snapshot.observedAt, bots: snapshot.bots.length, taskRuns: runs.length, active: Object.keys(snapshot.activity).length, head: snapshot.project.head, sourceChanged: snapshot.sourceSnapshotChanged.length, stateHash: digest(safe(snapshot)), acceptanceClaimed: false }))
  return snapshot
}

export async function main(mode = 'once') {
  const manifest = loadManifest()
  if (mode === 'closed') {
    const active = await listening(manifest.port)
    const result = { observedAt: new Date().toISOString(), port: manifest.port, listening: active, processCleanupNotInferredFromAgentState: true }
    writeFileSync(join(home, 'evidence', 'closed.json'), JSON.stringify(result, null, 2))
    assert.equal(active, false, 'The owned Feature host is still listening')
    console.log(JSON.stringify(result))
    return
  }
  assert.ok(['once', 'watch'].includes(mode))
  const bootstrapPath = join(home, 'evidence', 'bootstrap.json')
  assert.ok(existsSync(bootstrapPath), 'Observe only an already bootstrapped run; do not implicitly create identities')
  assert.equal(JSON.parse(readFileSync(bootstrapPath, 'utf8')).demandSent, true)
  mkdirSync(join(home, 'private', 'chats'), { recursive: true })
  const api = await privateApi(manifest)
  if (mode === 'once') return observe(api, manifest)
  console.log(JSON.stringify({ watching: true, readOnly: true, noFixedPlaybookRounds: true, evidence: join(home, 'evidence', 'watch.jsonl') }))
  let stopping = false
  process.once('SIGTERM', () => { stopping = true })
  process.once('SIGINT', () => { stopping = true })
  while (!stopping) {
    await observe(api, manifest)
    await new Promise(accept => setTimeout(accept, 3000))
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv[2] ?? 'once')
