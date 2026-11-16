// Test-only transparent model proxy. Non-TaskRun requests use the unchanged bench mock.
import { appendFileSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { resolve, join } from 'node:path'
import { Readable } from 'node:stream'

const home = resolve(process.env.DSH_HOME ?? '')
if (!home.endsWith('.dsh-test-task-runs-host')) throw new Error('An isolated TaskRun DSH_HOME is required')
const ports = JSON.parse(readFileSync(join(home, 'ports.json'), 'utf8'))
const log = value => appendFileSync(join(home, 'task-model.jsonl'), `${JSON.stringify({ time: new Date().toISOString(), ...value })}\n`)
const textOf = value => typeof value === 'string' ? value : Array.isArray(value) ? value.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n') : ''
const launched = new Set()
const opened = new Set()
const waiters = new Map()
let seq = 0
const stats = { requests: 0, dispatched: 0, aSteps: 0, aSteerSeen: false, bSteerSeen: false, aDisconnected: false }
function release(key) {
  opened.add(key)
  for (const waiter of waiters.get(key) ?? []) waiter.resolve()
  waiters.delete(key)
}
function held(key, response) {
  if (opened.has(key)) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const row = { resolve: () => { response.off('close', close); resolve() } }
    const close = () => {
      waiters.get(key)?.delete(row)
      if (key.startsWith('a')) stats.aDisconnected = true
      log({ kind: 'client-disconnected', key })
      reject(new Error('Model client disconnected'))
    }
    if (!waiters.has(key)) waiters.set(key, new Set())
    waiters.get(key).add(row)
    response.once('close', close)
  })
}
function stream(response, body, blocks) {
  if (response.destroyed) return
  const id = `task-host-${++seq}`
  const emit = data => response.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`)
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  emit({ type: 'message_start', message: { id, type: 'message', role: 'assistant', model: body.model, content: [], usage: { input_tokens: 300, output_tokens: 0 } } })
  let index = 0
  for (const block of blocks) {
    if (block.type === 'tool_use') {
      emit({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: `call-${id}-${index}`, name: block.name, input: {} } })
      emit({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } })
    } else {
      emit({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
      emit({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } })
    }
    emit({ type: 'content_block_stop', index: index++ })
  }
  emit({ type: 'message_delta', delta: { stop_reason: blocks.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 100 } })
  emit({ type: 'message_stop' })
  response.end()
}
async function forward(request, response, raw) {
  const controller = new AbortController()
  response.once('close', () => { if (!response.writableEnded) controller.abort() })
  const upstream = await fetch(`http://127.0.0.1:${ports.mock}${request.url}`, { method: request.method, headers: { 'content-type': request.headers['content-type'] ?? 'application/json' }, ...(raw ? { body: raw } : {}), signal: controller.signal })
  response.writeHead(upstream.status, Object.fromEntries([...upstream.headers].filter(([name]) => !['connection', 'transfer-encoding', 'content-length'].includes(name))))
  if (upstream.body) Readable.fromWeb(upstream.body).pipe(response)
  else response.end()
}
const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, 'http://localhost').pathname
    if (path === '/bench/status') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ ...stats, open: [...opened], waiting: [...waiters].map(([key, rows]) => ({ key, count: rows.size })) })); return }
    if (path.startsWith('/bench/release/')) { release(path.split('/').at(-1)); response.end('released'); return }
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const raw = Buffer.concat(chunks)
    if (request.method !== 'POST' || !path.endsWith('/messages')) { await forward(request, response, raw.length ? raw : undefined); return }
    const body = JSON.parse(raw.toString('utf8'))
    const messages = body.messages ?? []
    const input = messages.map(message => textOf(message.content)).join('\n')
    const names = (body.tools ?? []).map(tool => tool.name)
    const session = request.headers['x-deepseek-harness-session-id'] ?? 'unknown'
    stats.requests += 1
    const taskTools = names.includes('list_task_runs')
    const workerA = taskTools && input.includes('HOST_GUI_WORKER_A')
    const workerB = taskTools && input.includes('HOST_GUI_WORKER_B')
    if (workerA || workerB) {
      const sawSteer = input.includes('HOST_GUI_A_STEER_ONLY')
      log({ kind: 'worker-request', worker: workerA ? 'A' : 'B', session, sawSteer, tools: names })
      if (workerA) {
        stats.aSteps += 1
        stats.aSteerSeen ||= sawSteer
        if (stats.aSteps === 1) {
          await held('a-step', response)
          const name = names.includes('working_directory') ? 'working_directory' : names.includes('read') ? 'read' : undefined
          if (!name) throw new Error('A worker has no harmless public working_directory/read tool')
          stream(response, body, [{ type: 'tool_use', name, input: name === 'read' ? { file_path: join(home, 'bot/workspace/task-run-probe.txt') } : {} }])
        } else {
          await held('a-finish', response)
          stream(response, body, [{ type: 'text', text: 'HOST_GUI_A_SHOULD_HAVE_BEEN_CANCELLED' }])
        }
      } else {
        stats.bSteerSeen ||= sawSteer
        await held('b-finish', response)
        stream(response, body, [{ type: 'text', text: `HOST_GUI_B_COMPLETED\n${'B_RESULT_LINE\n'.repeat(3000)}HOST_GUI_B_TAIL` }])
      }
      return
    }
    const last = textOf(messages.at(-1)?.content)
    if (last.includes('HOST_GUI_START_TWO_TASKS') && names.includes('start_task') && !launched.has(session)) {
      launched.add(session)
      stats.dispatched += 2
      log({ kind: 'dispatch-tools', session, tools: ['start_task', 'start_task'] })
      stream(response, body, [
        { type: 'tool_use', name: 'start_task', input: { label: 'GUI Task A — steer and cancel', brief: 'HOST_GUI_WORKER_A: work in the isolated folder. Stay active until explicitly cancelled.', instructions: 'This is a synthetic local host acceptance task. Use only the authorized test workspace.', permission: 'read-only', request_id: 'host-gui-a' } },
        { type: 'tool_use', name: 'start_task', input: { label: 'GUI Task B — independent completion', brief: 'HOST_GUI_WORKER_B: produce the synthetic retained result when your request is released.', instructions: 'This is a synthetic local host acceptance task. Do not access personal data.', permission: 'read-only', request_id: 'host-gui-b' } },
      ])
      return
    }
    if (launched.has(session) && (last.includes('task-run-result') || messages.some(message => (message.content ?? []).some?.(block => block.type === 'tool_result')))) {
      stream(response, body, [{ type: 'text', text: 'HOST_GUI_OWNER_ACK: task receipts or returned results received.' }])
      return
    }
    await forward(request, response, raw)
  } catch (error) {
    if (!response.destroyed && !response.headersSent) { response.writeHead(500, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { type: 'api_error', message: error.message } })) }
    else if (!response.destroyed) response.end()
  }
})
server.listen(ports.proxy, '127.0.0.1', () => console.log(JSON.stringify({ modelProxyReady: true, port: ports.proxy })))
process.once('SIGTERM', () => { for (const key of waiters.keys()) release(key); server.close() })
