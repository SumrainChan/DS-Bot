import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { Readable } from 'node:stream'

const home = resolve(process.env.DSH_HOME ?? '')
assert.ok(home.endsWith('.dsh-test-pstack-harness'), 'Use only the isolated enabled pstack home')
const ports = JSON.parse(readFileSync(join(home, 'ports.json'), 'utf8'))
const build = JSON.parse(readFileSync(join(home, 'evidence', 'build.json'), 'utf8'))
const textOf = value => typeof value === 'string' ? value : Array.isArray(value) ? value.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n') : ''
const log = value => appendFileSync(join(home, 'pstack-model.jsonl'), `${JSON.stringify({ time: new Date().toISOString(), ...value })}\n`)
const emitted = new Set(), results = new Set(), phases = new Map(), readCalls = new Map(), writeCalls = new Map()
const deniedWritePath = join(build.workspace, 'pstack-readonly-denied.txt')
assert.equal(existsSync(deniedWritePath), false, 'The readonly mutation probe must start absent')
const originalHowPath = join(build.sourceRoot, 'skills', 'how', 'SKILL.md')
const originalHow = readFileSync(originalHowPath, 'utf8')
const originalHowHash = createHash('sha256').update(originalHow).digest('hex')
const bodies = Object.fromEntries(['how', 'arena', 'architect'].map(name => {
  const raw = readFileSync(join(build.sourceRoot, 'skills', name, 'SKILL.md'), 'utf8')
  return [name, raw.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '').trim()]
}))
const pathSeen = (text, path) => text.includes(path) || text.includes(path.replaceAll('\\', '/'))
let seq = 0
function stream(response, body, blocks) {
  const id = `pstack-host-${++seq}`
  const emit = data => response.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`)
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  emit({ type: 'message_start', message: { id, type: 'message', role: 'assistant', model: body.model, content: [], usage: { input_tokens: 1000, output_tokens: 0 } } })
  for (const [index, block] of blocks.entries()) {
    if (block.type === 'tool_use') {
      emit({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: `call-${id}-${index}`, name: block.name, input: {} } })
      emit({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } })
    } else {
      emit({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
      emit({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } })
    }
    emit({ type: 'content_block_stop', index })
  }
  emit({ type: 'message_delta', delta: { stop_reason: blocks.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 100 } })
  emit({ type: 'message_stop' })
  response.end()
  return id
}
function originalReadInput(body) {
  const reader = (body.tools ?? []).find(tool => tool.name === 'read')
  assert.ok(reader, 'No native read tool is visible; no Shell substitute is permitted')
  const schema = reader.input_schema ?? reader.parameters
  const properties = schema?.properties ?? {}
  const pathField = ['file_path', 'path', 'filePath'].find(name => Object.hasOwn(properties, name))
  assert.ok(pathField, 'The visible native read schema has no supported file path field')
  const input = { [pathField]: originalHowPath }
  if (Object.hasOwn(properties, 'offset')) input.offset = 1
  if (Object.hasOwn(properties, 'limit')) input.limit = 2000
  assert.ok((schema.required ?? []).every(name => Object.hasOwn(input, name)), 'The visible native read schema requires an unsupported argument')
  return { input, schemaProperties: Object.keys(properties), schemaRequired: schema.required ?? [] }
}
function deniedWriteInput(body) {
  const writer = (body.tools ?? []).find(tool => tool.name === 'write')
  assert.ok(writer, 'The native write tool must be visible for the readonly policy probe')
  const schema = writer.input_schema ?? writer.parameters
  const properties = schema?.properties ?? {}
  const pathField = ['file_path', 'path', 'filePath'].find(name => Object.hasOwn(properties, name))
  assert.ok(pathField && Object.hasOwn(properties, 'content'), 'The visible native write schema must supply a path and content')
  const input = { [pathField]: deniedWritePath, content: 'Synthetic readonly denial probe. This file must never be created.\n' }
  assert.ok((schema.required ?? []).every(name => Object.hasOwn(input, name)), 'The visible native write schema requires an unsupported argument')
  return { input, schemaProperties: Object.keys(properties), schemaRequired: schema.required ?? [] }
}
async function forward(request, response, raw) {
  const controller = new AbortController()
  response.once('close', () => { if (!response.writableEnded) controller.abort() })
  const upstream = await fetch(`http://127.0.0.1:${ports.mock}${request.url}`, { method: request.method, headers: { 'content-type': request.headers['content-type'] ?? 'application/json' }, ...(raw?.length ? { body: raw } : {}), signal: controller.signal })
  response.writeHead(upstream.status, Object.fromEntries([...upstream.headers].filter(([name]) => !['connection', 'transfer-encoding', 'content-length'].includes(name))))
  if (upstream.body) Readable.fromWeb(upstream.body).pipe(response)
  else response.end()
}
function recordResults(body, session, worker) {
  for (const message of body.messages ?? []) {
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block.type !== 'tool_result' || results.has(block.tool_use_id)) continue
      results.add(block.tool_use_id)
      const text = textOf(block.content)
      const read = readCalls.get(block.tool_use_id)
      if (read) {
        let position = 0, complete = true
        const originalLines = originalHow.split(/\r?\n/).filter(line => line !== '')
        for (const line of originalLines) {
          const next = text.indexOf(line, position)
          if (next === -1) { complete = false; break }
          position = next + line.length
        }
        log({ kind: 'source-read-result', session, worker, path: originalHowPath, sourceHash: originalHowHash, originalNonemptyLines: originalLines.length, orderedLinesComplete: complete, isError: block.is_error === true, schemaProperties: read.schemaProperties, schemaRequired: read.schemaRequired, input: read.input, ...complete ? {} : { resultPrefix: text.slice(0, 250) } })
      }
      const write = writeCalls.get(block.tool_use_id)
      if (write) log({ kind: 'readonly-write-result', session, worker, path: deniedWritePath, isError: block.is_error === true, sandboxDenied: /FS_SANDBOX_DENIED|\[sandbox: file access denied under read-only mode\]/.test(text), fileExists: existsSync(deniedWritePath), schemaProperties: write.schemaProperties, schemaRequired: write.schemaRequired, inputFields: Object.keys(write.input), resultPrefix: text.slice(0, 250) })
      if (/not available for model invocation/.test(text)) log({ kind: 'skill-refusal', session, worker, refused: true })
      let value
      try { value = JSON.parse(text) } catch { continue }
      if (typeof value === 'string') { try { value = JSON.parse(value) } catch { continue } }
      if (!value?.binding || !value.settings || !value.catalog) continue
      const skills = value.skills?.entries ?? []
      log({ kind: 'preflight-result', session, worker, binding: value.binding, rows: value.settings.rows, settingsHash: value.settings.settingsHash, skillCount: skills.length, disabledCount: skills.filter(skill => skill.invocation?.modelInvocable === false).length, catalogAvailable: value.catalog.available, modelRefs: value.catalog.models.map(model => model.ref), selection: value.selection, execution: value.execution })
    }
  }
}

const server = createServer(async (request, response) => {
  try {
    if (request.url === '/bench/status') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ ready: true, port: ports.proxy })); return }
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const raw = Buffer.concat(chunks)
    if (request.method !== 'POST' || !new URL(request.url, 'http://localhost').pathname.endsWith('/messages')) { await forward(request, response, raw); return }
    const body = JSON.parse(raw.toString('utf8'))
    const system = textOf(body.system)
    const input = [system, ...(body.messages ?? []).map(message => textOf(message.content))].join('\n')
    const names = (body.tools ?? []).map(tool => tool.name)
    const session = request.headers['x-deepseek-harness-session-id'] ?? 'unknown'
    const worker = system.includes('You are task run ') && input.includes('PSTACK_HOST_WORKER')
    const current = (body.messages ?? []).filter(message => message.role === 'user').flatMap(message => [...textOf(message.content).matchAll(/PSTACK_HOST_(ENTRY_(?:how|arena|architect)|PREFLIGHT|MODEL_SKILL|START_TASK)(?![A-Z_])/g)]).at(-1)?.[1]
    if (current) phases.set(session, current)
    const phase = worker ? 'WORKER' : phases.get(session) ?? 'passthrough'
    const skills = ['how', 'arena', 'architect'].filter(name => input.includes(`<skill_content name="${name}">`)).map(name => ({ name, originalBody: input.includes(bodies[name]), resourceBaseSeen: pathSeen(input, join(build.sourceRoot, 'skills', name)) }))
    log({ kind: 'request', session, worker, phase, model: body.model, mappingCount: input.split('pstack Harness mapping').length - 1, sourceSeen: pathSeen(input, build.sourceRoot), settingsSeen: pathSeen(input, build.settingsFile), tools: names, skills })
    recordResults(body, session, worker)
    const key = `${session}:${phase}`
    if (worker || phase === 'PREFLIGHT') {
      if (!emitted.has(key)) { emitted.add(key); stream(response, body, [{ type: 'tool_use', name: 'pstack_preflight', input: {} }]) }
      else if (worker && !emitted.has(`${key}:read`)) {
        const read = originalReadInput(body)
        emitted.add(`${key}:read`)
        const messageId = stream(response, body, [{ type: 'tool_use', name: 'read', input: read.input }])
        readCalls.set(`call-${messageId}-0`, read)
      } else if (worker && !emitted.has(`${key}:write`)) {
        const write = deniedWriteInput(body)
        emitted.add(`${key}:write`)
        const messageId = stream(response, body, [{ type: 'tool_use', name: 'write', input: write.input }])
        writeCalls.set(`call-${messageId}-0`, write)
      } else stream(response, body, [{ type: 'text', text: worker ? 'PUBLIC_HOST_WORKER_DONE' : 'PUBLIC_HOST_PREFLIGHT_DONE' }])
    } else if (phase === 'MODEL_SKILL') {
      if (!emitted.has(key)) { emitted.add(key); stream(response, body, [{ type: 'tool_use', name: 'skill', input: { name: 'how' } }]) }
      else stream(response, body, [{ type: 'text', text: 'PUBLIC_HOST_MODEL_BOUNDARY_DONE' }])
    } else if (phase === 'START_TASK') {
      if (!emitted.has(key)) {
        emitted.add(key)
        stream(response, body, [{ type: 'tool_use', name: 'start_task', input: { label: 'pstack host worker', brief: 'PSTACK_HOST_WORKER. Inspect only the explicit isolated pstack source and project settings through pstack_preflight; return the protocol result.', instructions: 'This is a scripted host assembly acceptance task, not a pstack Feature implementation. Do not change files or use native delegation.', model: 'deepseek-official/deepseek-flash', permission: 'read-only', request_id: 'pstack-host-worker' } }])
      } else stream(response, body, [{ type: 'text', text: 'PUBLIC_HOST_OWNER_RECEIPT_OR_RESULT_ACK' }])
    } else if (phase.startsWith('ENTRY_')) stream(response, body, [{ type: 'text', text: `PUBLIC_HOST_ENTRY_ACK ${phase}` }])
    else await forward(request, response, raw)
  } catch (error) {
    log({ kind: 'proxy-error', code: error.code ?? null, message: error.message })
    if (!response.destroyed && !response.headersSent) { response.writeHead(500, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { type: 'api_error', message: error.message } })) }
    else if (!response.destroyed) response.end()
  }
})
server.listen(ports.proxy, '127.0.0.1', () => console.log(JSON.stringify({ modelProxyReady: true, port: ports.proxy })))
process.once('SIGTERM', () => server.close())
