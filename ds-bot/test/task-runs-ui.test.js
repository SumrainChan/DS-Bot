import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/task-runs.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent', external: ['react'],
})

// Like the existing form component tests, exercise the bundled component and its
// actual handlers. Hook cells are keyed by component and row key, not list position.
function mount(props) {
  const instances = new Map(), types = new Map()
  let current, concrete, rendering = false, dirty = false, nextId = 0
  const slot = make => current.slots[current.index++] ??= make()
  const effects = []
  const effect = (make, deps) => {
    const owner = current, cell = slot(() => ({}))
    if (!cell.deps || !deps || deps.some((value, index) => !Object.is(value, cell.deps[index]))) {
      effects.push(() => { if (!owner.seen) return; cell.cleanup?.(); cell.deps = deps; cell.cleanup = make() })
    }
  }
  const react = {
    createElement: (type, attributes, ...children) => ({ type, props: { ...attributes, children }, key: attributes?.key }),
    Fragment: 'fragment',
    useEffect: effect, useLayoutEffect: effect,
    useRef: value => slot(() => ({ current: value })),
    useId: () => slot(() => ({ value: `task-runs-test-${nextId++}` })).value,
    useState: initial => {
      const owner = current, cell = slot(() => ({ value: typeof initial === 'function' ? initial() : initial }))
      return [cell.value, value => {
        const next = typeof value === 'function' ? value(cell.value) : value
        if (Object.is(next, cell.value)) return
        cell.value = next
        if (owner.seen) render()
      }]
    },
  }
  const module = { exports: {} }
  runInNewContext(outputFiles[0].text, {
    module, exports: module.exports, setTimeout, clearTimeout,
    require: name => { assert.equal(name, 'react'); return react },
  }, { filename: 'task-runs-ui.cjs' })
  const expand = (node, path = 'root') => {
    if (Array.isArray(node)) return node.map((child, index) => expand(child, `${path}/${child?.key === undefined ? index : `key:${child.key}`}`))
    if (node === null || typeof node !== 'object') return node
    if (typeof node.type === 'function') {
      if (!types.has(node.type)) types.set(node.type, types.size)
      const key = `${path}/component:${types.get(node.type)}`
      let instance = instances.get(key)
      if (!instance) { instance = { slots: [] }; instances.set(key, instance) }
      instance.seen = true; instance.index = 0
      const previous = current
      current = instance
      const output = node.type(node.props)
      current = previous
      return expand(output, key)
    }
    return { ...node, props: { ...node.props, children: expand(node.props.children, `${path}/children`) } }
  }
  const stop = instance => { for (const cell of instance.slots) cell?.cleanup?.() }
  function render() {
    if (rendering) { dirty = true; return }
    rendering = true
    do {
      dirty = false
      for (const instance of instances.values()) instance.seen = false
      concrete = expand(react.createElement(module.exports.TaskRuns, props))
      for (const [key, instance] of instances) if (!instance.seen) { stop(instance); instances.delete(key) }
      for (const run of effects.splice(0)) run()
    } while (dirty)
    rendering = false
  }
  render()
  return {
    get tree() { return concrete },
    update(next) { props = { ...props, ...next }; render() },
    close() { for (const instance of instances.values()) { instance.seen = false; stop(instance) } instances.clear() },
  }
}
const plain = value => JSON.parse(JSON.stringify(value))
const all = (node, match, found = []) => {
  if (Array.isArray(node)) { node.forEach(child => all(child, match, found)); return found }
  if (!node || typeof node !== 'object') return found
  if (match(node)) found.push(node)
  all(node.props?.children, match, found)
  return found
}
const text = node => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.props?.children) : node === undefined || node === null || typeof node === 'boolean' ? '' : String(node)
const row = (view, id) => all(view.tree, node => node.props?.['data-run-id'] === id)[0]
const button = (tree, label) => all(tree, node => node.type === 'button' && text(node) === label)[0]
const click = (tree, label) => {
  const found = button(tree, label)
  assert.ok(found, `button ${label} exists`)
  assert.equal(Boolean(found.props.disabled), false, `button ${label} is enabled`)
  found.props.onClick?.()
}
const flush = () => new Promise(resolve => setImmediate(resolve))
const bot = { id: 'owner', name: 'Builder' }
const record = (id, extra = {}) => ({
  id, ownerBotId: bot.id, label: 'Implement feature', status: 'running', provider: 'mock', model: 'model-A', effort: 'high',
  cwd: `D:\\project\\${id}`, sandboxMode: 'workspace-write', sessionId: `session-${id}`, startedAt: 1700000000000, ...extra,
})
const openInstructions = (view, id, value) => {
  click(row(view, id), 'Add instructions')
  const input = all(row(view, id), node => node.type === 'textarea')[0]
  input.props.onChange({ target: { value } })
  return all(row(view, id), node => node.type === 'form')[0]
}
const submit = form => form.props.onSubmit({ preventDefault() {} })

test('empty state is a user-facing section and Bot scope excludes other owners', (t) => {
  const view = mount({ state: {}, bot, act: async () => {} }); t.after(view.close)
  assert.ok(text(view.tree).includes('Task runs'))
  assert.ok(text(view.tree).includes('No task runs yet.'))
  view.update({ state: { taskRuns: [record('other', { ownerBotId: 'another' })] } })
  assert.equal(all(view.tree, node => node.props?.['data-run-id']).length, 0)
})

test('two runs with the same owner and label have distinct identity, model, folder and hierarchy', (t) => {
  const view = mount({ state: { taskRuns: [record('parent'), record('child', { parentRunId: 'parent', model: 'model-B', sandboxMode: 'read-only' })] }, bot, act: async () => {} }); t.after(view.close)
  assert.ok(text(row(view, 'parent')).includes('Builderparent'))
  assert.ok(text(row(view, 'child')).includes('Builderchild'))
  assert.ok(text(row(view, 'parent')).includes('mock/model-A'))
  assert.ok(text(row(view, 'child')).includes('mock/model-B'))
  assert.ok(text(row(view, 'child')).includes('D:\\project\\child'))
  assert.ok(text(row(view, 'child')).includes('Child of parent'))
  assert.equal(row(view, 'child').props.style.marginInlineStart, '12px')
  assert.notEqual(button(row(view, 'parent'), 'Stop').props['aria-label'], button(row(view, 'child'), 'Stop').props['aria-label'])
})

test('stopping A confirms only A and never marks an accepted request as a cancelled outcome', async (t) => {
  const calls = [], runs = [record('A'), record('B')]
  const view = mount({ state: { taskRuns: runs }, bot, act: async (endpoint, payload) => { calls.push([endpoint, plain(payload)]); return { accepted: true } } }); t.after(view.close)
  click(row(view, 'A'), 'Stop')
  assert.equal(calls.length, 0)
  assert.ok(button(row(view, 'A'), 'Confirm stop'))
  assert.ok(button(row(view, 'B'), 'Stop'))
  click(row(view, 'A'), 'Confirm stop'); await flush()
  assert.deepEqual(calls, [['task-run-cancel', { id: 'A' }]])
  assert.equal(row(view, 'A').props['data-status'], 'running')
  assert.ok(text(row(view, 'A')).includes('Stop requested'))
  assert.equal(button(row(view, 'A'), 'Stop').props.disabled, true)
  assert.equal(button(row(view, 'B'), 'Stop').props.disabled, false)
  view.update({ state: { taskRuns: [record('A', { status: 'cancelled' }), record('B')] } })
  assert.equal(row(view, 'A').props['data-status'], 'cancelled')
  assert.equal(button(row(view, 'B'), 'Add instructions').props.disabled, false)
})

test('each run keeps its own instruction draft and sends its exact run id', async (t) => {
  const calls = []
  const view = mount({ state: { taskRuns: [record('A'), record('B')] }, bot, act: async (endpoint, payload) => { calls.push([endpoint, plain(payload)]) } }); t.after(view.close)
  openInstructions(view, 'A', '  Fix A only  ')
  openInstructions(view, 'B', 'Keep B separate')
  assert.equal(all(row(view, 'A'), node => node.type === 'textarea')[0].props.value, '  Fix A only  ')
  submit(all(row(view, 'A'), node => node.type === 'form')[0]); await flush()
  assert.deepEqual(calls, [['task-run-steer', { id: 'A', text: 'Fix A only' }]])
  assert.equal(all(row(view, 'B'), node => node.type === 'textarea')[0].props.value, 'Keep B separate')
  submit(all(row(view, 'B'), node => node.type === 'form')[0]); await flush()
  assert.deepEqual(calls[1], ['task-run-steer', { id: 'B', text: 'Keep B separate' }])
})

test('a pending command cannot double-submit or block another run', async (t) => {
  const calls = []; let release
  const view = mount({ state: { taskRuns: [record('A'), record('B')] }, bot, act: (endpoint, payload) => {
    calls.push([endpoint, plain(payload)])
    return payload.id === 'A' ? new Promise(resolve => { release = resolve }) : Promise.resolve(true)
  } }); t.after(view.close)
  const stale = openInstructions(view, 'A', 'A scope')
  submit(stale); submit(stale)
  assert.equal(calls.length, 1)
  assert.equal(button(row(view, 'A'), 'Sending…').props.disabled, true)
  assert.equal(button(row(view, 'B'), 'Add instructions').props.disabled, false)
  const b = openInstructions(view, 'B', 'B scope'); submit(b); await flush()
  assert.deepEqual(calls[1], ['task-run-steer', { id: 'B', text: 'B scope' }])
  release(true); await flush()
})

test('all terminal outcomes disable mutation and stale live handlers cannot send after completion', async (t) => {
  const calls = [], view = mount({ state: { taskRuns: [record('A')] }, bot, act: async (...args) => { calls.push(args) } }); t.after(view.close)
  const stale = openInstructions(view, 'A', 'Too late')
  for (const status of ['completed', 'failed', 'cancelled', 'unknown']) {
    view.update({ state: { taskRuns: [record('A', { status })] } })
    assert.equal(button(row(view, 'A'), 'Add instructions').props.disabled, true)
    assert.equal(button(row(view, 'A'), 'Stop').props.disabled, true)
    submit(stale)
    await flush()
  }
  assert.equal(calls.length, 0)
})

test('results expand independently, logs show returned events, and session navigation uses the execution session', async (t) => {
  const calls = [], sessions = []
  const view = mount({ state: { taskRuns: [record('A', { status: 'completed', output: [{ type: 'text', text: 'RESULT_A <script>literal</script>' }] }), record('B', { status: 'failed', output: 'RESULT_B', error: { message: 'B transport failed' } })] }, bot,
    act: async (endpoint, payload) => { calls.push([endpoint, plain(payload)]); return { sessionId: 'session-A', events: [{ seq: 41, type: 'assistant/message', data: { text: 'REAL_LOG_EVENT_A' } }] } }, onOpenSession: id => sessions.push(id),
  }); t.after(view.close)
  assert.ok(!text(view.tree).includes('RESULT_A'))
  click(row(view, 'A'), 'Show result')
  assert.ok(text(row(view, 'A')).includes('RESULT_A <script>literal</script>'))
  assert.ok(!text(row(view, 'B')).includes('RESULT_B'))
  assert.ok(text(row(view, 'B')).includes('B transport failed'))
  assert.equal(all(view.tree, node => node.type === 'script').length, 0)
  click(row(view, 'A'), 'Show log'); await flush()
  assert.deepEqual(calls, [['task-run-log', { id: 'A' }]])
  const log = all(row(view, 'A'), node => node.props?.className === 'bt-task-run-log')[0]
  assert.ok(text(log).includes('REAL_LOG_EVENT_A')); assert.ok(text(log).includes('"seq": 41'))
  assert.ok(text(log).includes('assistant/message')); assert.ok(!text(log).includes('RESULT_A'))
  click(row(view, 'A'), 'Open session'); assert.deepEqual(sessions, ['session-A'])
  click(row(view, 'A'), 'Refresh log'); await flush(); assert.equal(calls.length, 2)
  click(row(view, 'A'), 'Hide log'); assert.equal(button(row(view, 'A'), 'Show log').props['aria-expanded'], false)
})

test('logs accept events-only responses and invalid responses show a retryable error instead of invented history', async (t) => {
  let reads = 0
  const view = mount({ state: { taskRuns: [record('A')] }, bot, act: async () => ++reads === 1 ? { output: 'not an event log' } : { events: [{ type: 'turn/start', data: { turn: 1 } }] } }); t.after(view.close)
  click(row(view, 'A'), 'Show log'); await flush()
  assert.ok(text(row(view, 'A')).includes('Could not read the task log. Try again.'))
  assert.ok(!text(row(view, 'A')).includes('not an event log'))
  click(row(view, 'A'), 'Refresh log'); await flush()
  assert.ok(text(row(view, 'A')).includes('turn/start'))
  assert.ok(!text(row(view, 'A')).includes('Could not read the task log. Try again.'))
})

test('command failures stay beside their run and preserve the unsent draft', async (t) => {
  const view = mount({ state: { taskRuns: [record('A'), record('B')] }, bot, act: async () => { throw new Error('Task is no longer controllable') } }); t.after(view.close)
  submit(openInstructions(view, 'A', 'Retain my instructions')); await flush()
  assert.ok(text(row(view, 'A')).includes('Task is no longer controllable'))
  assert.ok(!text(row(view, 'B')).includes('Task is no longer controllable'))
  assert.equal(all(row(view, 'A'), node => node.type === 'textarea')[0].props.value, 'Retain my instructions')
})

test('group scope matches roomId rather than inferring ownership from membership', (t) => {
  const view = mount({ state: { taskRuns: [record('private'), record('here', { roomId: 'group' }), record('elsewhere', { roomId: 'other' })] }, room: { id: 'group', members: [bot.id] }, act: async () => {} }); t.after(view.close)
  assert.ok(row(view, 'here')); assert.equal(row(view, 'private'), undefined); assert.equal(row(view, 'elsewhere'), undefined)
})

test('changing execution session hides cached logs and a late old-session response is ignored', async (t) => {
  let release
  const view = mount({ state: { taskRuns: [record('A')] }, bot, act: () => new Promise(resolve => { release = resolve }) }); t.after(view.close)
  click(row(view, 'A'), 'Show log')
  view.update({ state: { taskRuns: [record('A', { sessionId: 'new-part' })] } })
  release({ sessionId: 'session-A', events: ['STALE_LOG'] }); await flush()
  assert.ok(!text(row(view, 'A')).includes('STALE_LOG'))
})

test('a truncated result requests its exact retained run and shows the complete tail without fetching another run', async (t) => {
  const calls = [], complete = `PREVIEW_A ${'retained '.repeat(700)}COMPLETE_TAIL_A`
  const view = mount({ state: { taskRuns: [record('A', { status: 'completed', output: 'PREVIEW_A', outputLength: complete.length }), record('B', { status: 'completed', output: 'SMALL_B', outputLength: 7 })] }, bot,
    act: async (endpoint, payload) => { calls.push([endpoint, plain(payload)]); return { result: { complete: true, output: complete } } },
  }); t.after(view.close)
  assert.ok(!text(view.tree).includes('COMPLETE_TAIL_A'))
  click(row(view, 'A'), 'Show result'); await flush()
  assert.deepEqual(calls, [['task-run-read', { id: 'A' }]])
  assert.ok(text(row(view, 'A')).includes('COMPLETE_TAIL_A'))
  assert.ok(!text(row(view, 'B')).includes('COMPLETE_TAIL_A'))
  click(row(view, 'A'), 'Hide result'); click(row(view, 'A'), 'Show result'); await flush()
  assert.equal(calls.length, 1, 'reopening uses the already fetched complete result')
  click(row(view, 'B'), 'Show result'); await flush()
  assert.equal(calls.length, 1, 'a complete small preview does not fetch again')
})

test('log next pages use the returned cursor and append events, while refresh replaces the loaded pages', async (t) => {
  const calls = []; let firstPageReads = 0
  const view = mount({ state: { taskRuns: [record('A')] }, bot, act: async (endpoint, payload) => {
    calls.push([endpoint, plain(payload)])
    if (payload.after === 200) return { events: ['SECOND_PAGE_EVENT'], next: 400 }
    if (payload.after === 400) return { events: ['LAST_PAGE_EVENT'], next: null }
    return ++firstPageReads === 1 ? { events: ['FIRST_PAGE_EVENT'], next: 200 } : { events: ['REFRESHED_EVENT'], next: null }
  } }); t.after(view.close)
  click(row(view, 'A'), 'Show log'); await flush()
  assert.ok(text(row(view, 'A')).includes('FIRST_PAGE_EVENT'))
  click(row(view, 'A'), 'Load more log entries'); await flush()
  assert.ok(text(row(view, 'A')).includes('FIRST_PAGE_EVENT')); assert.ok(text(row(view, 'A')).includes('SECOND_PAGE_EVENT'))
  click(row(view, 'A'), 'Load more log entries'); await flush()
  assert.ok(text(row(view, 'A')).includes('FIRST_PAGE_EVENT')); assert.ok(text(row(view, 'A')).includes('LAST_PAGE_EVENT'))
  assert.equal(button(row(view, 'A'), 'Load more log entries'), undefined)
  assert.deepEqual(calls, [['task-run-log', { id: 'A' }], ['task-run-log', { id: 'A', after: 200 }], ['task-run-log', { id: 'A', after: 400 }]])
  click(row(view, 'A'), 'Refresh log'); await flush()
  assert.deepEqual(calls[3], ['task-run-log', { id: 'A' }])
  assert.ok(text(row(view, 'A')).includes('REFRESHED_EVENT'))
  for (const old of ['FIRST_PAGE_EVENT', 'SECOND_PAGE_EVENT', 'LAST_PAGE_EVENT']) assert.ok(!text(row(view, 'A')).includes(old))
})

test('read-only or unavailable state disables mutations including handlers retained from the writable view', async (t) => {
  for (const flags of [{ readOnly: 'This profile belongs to another host' }, { taskRunsAvailable: false }]) {
    const calls = [], runs = [record('A')]
    const view = mount({ state: { taskRuns: runs }, bot, act: async (endpoint, payload) => { calls.push([endpoint, plain(payload)]); return { events: [] } } }); t.after(view.close)
    const staleForm = openInstructions(view, 'A', 'Must not send')
    click(row(view, 'A'), 'Stop')
    const staleConfirm = button(row(view, 'A'), 'Confirm stop').props.onClick
    view.update({ state: { taskRuns: runs, ...flags } })
    assert.equal(button(row(view, 'A'), 'Add instructions').props.disabled, true)
    assert.equal(button(row(view, 'A'), 'Confirm stop').props.disabled, true)
    submit(staleForm); staleConfirm(); await flush()
    assert.equal(calls.length, 0)
    click(row(view, 'A'), 'Show log'); await flush()
    assert.deepEqual(calls, [['task-run-log', { id: 'A' }]], 'read access remains available without mutation')
  }
})
