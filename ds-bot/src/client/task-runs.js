import { createElement as h, useEffect, useId, useRef, useState } from 'react'
import { useFlip, useLinger, useMorph, SPRING_TAP, spring } from './motion.js'
import { clockLabel } from './text.js'
import { t } from './i18n.js'

const LIVE = new Set(['starting', 'running'])
const STATUSES = { starting: 'Starting', running: 'Running', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled', unknown: 'Unknown' }
const MODES = { 'read-only': 'Read-only', 'workspace-write': 'Workspace write', 'danger-full-access': 'Full access' }
const DELIVERIES = { pending: 'Awaiting result delivery', delivering: 'Delivering result', delivered: 'Result returned', native: 'Returned to parent task', unknown: 'Result delivery unconfirmed', unavailable: 'Result destination unavailable' }

function textOf(value) {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join('\n')
  if (typeof value.text === 'string') return value.text
  if (typeof value.message === 'string') return value.message
  return JSON.stringify(value, null, 2)
}

function orderedRuns(runs) {
  const sorted = runs.slice().sort((a, b) => Number(LIVE.has(b.status)) - Number(LIVE.has(a.status)) || (b.startedAt ?? 0) - (a.startedAt ?? 0) || a.id.localeCompare(b.id))
  const ids = new Set(sorted.map(run => run.id))
  const children = new Map()
  for (const run of sorted) {
    if (!children.has(run.parentRunId)) children.set(run.parentRunId, [])
    children.get(run.parentRunId).push(run)
  }
  const rows = [], seen = new Set()
  const add = (run, depth) => {
    if (seen.has(run.id)) return
    seen.add(run.id)
    rows.push({ run, depth })
    for (const child of children.get(run.id) ?? []) add(child, Math.min(depth + 1, 3))
  }
  for (const run of sorted) if (!ids.has(run.parentRunId)) add(run, 0)
  for (const run of sorted) add(run, 0)
  return rows
}

function Field({ label, children, code = false }) {
  return h('div', { className: 'bt-task-run-field' },
    h('span', { className: 'bt-note' }, t(label)),
    h(code ? 'code' : 'span', null, children))
}

function RunResult({ output, outputLength, runId, act }) {
  const [open, setOpen] = useState(false)
  const [whole, setWhole] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [shown, leaving] = useLinger(open, 160)
  const id = useId(), body = useRef(null), loading = useRef(false)
  useMorph(body, `${shown}:${busy}:${whole?.length ?? 0}:${error}`)
  const toggle = async () => {
    setOpen(value => !value)
    if (open || whole !== null || loading.current || !(outputLength > output.length) || typeof act !== 'function') return
    loading.current = true
    setBusy(true)
    setError('')
    try {
      const value = await act('task-run-read', { id: runId })
      if (value?.result?.complete !== true || typeof value.result.output !== 'string') throw new Error(t('Full result unavailable; showing the retained preview.'))
      setWhole(value.result.output)
    } catch (failure) { setError(failure?.message ?? t('Request failed')) }
    finally { loading.current = false; setBusy(false) }
  }
  return h('div', { ref: body, className: 'bt-task-run-result' },
    h('button', { type: 'button', className: 'bt-more', 'aria-expanded': open, 'aria-controls': id, onClick: toggle }, open ? t('Hide result') : t('Show result')),
    shown && busy ? h('div', { className: 'bt-note' }, t('Loading…')) : null,
    shown && error ? h('div', { className: 'bt-task-run-error', role: 'alert' }, error) : null,
    shown ? h('pre', { id, className: 'bt-task-run-text', 'data-leaving': leaving || undefined, 'aria-hidden': leaving || undefined }, whole ?? output) : null)
}

function RunRow({ run, depth, ownerName, act, onOpenSession, readOnly }) {
  const [writing, setWriting] = useState(false)
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState(null)
  const [confirming, setConfirming] = useState(false)
  const [stopRequested, setStopRequested] = useState(false)
  const [error, setError] = useState('')
  const [logOpen, setLogOpen] = useState(false)
  const [log, setLog] = useState(null)
  const [logBusy, setLogBusy] = useState(false)
  const [logError, setLogError] = useState('')
  const mounted = useRef(true), pendingAction = useRef(null), readingLog = useRef(null), stopAccepted = useRef(false)
  const current = useRef(run)
  current.current = { ...run, readOnly }
  const body = useRef(null)
  const formId = useId(), logId = useId()
  const active = LIVE.has(run.status)
  const controls = active && !readOnly && !stopRequested && typeof act === 'function'
  const [writeShown, writeLeaving] = useLinger(writing && active, 160)
  const [logShown, logLeaving] = useLinger(logOpen, 160)
  const cachedLog = log?.scope === run.sessionId ? log : null
  useMorph(body, `${writeShown}:${logShown}:${logBusy}:${cachedLog?.text.length ?? 0}:${run.status}:${error}:${logError}`)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  useEffect(() => {
    if (!confirming) return undefined
    const timer = setTimeout(() => setConfirming(false), 3000)
    return () => clearTimeout(timer)
  }, [confirming])

  const invoke = async (endpoint, payload) => {
    const value = await act(endpoint, payload)
    if (value === false) throw new Error(t('Request failed'))
    return value
  }
  const mutate = async (kind, payload) => {
    if (current.current.readOnly || !LIVE.has(current.current.status) || stopAccepted.current || pendingAction.current !== null || typeof act !== 'function') return
    pendingAction.current = kind
    setPending(kind)
    setError('')
    try {
      await invoke(`task-run-${kind}`, { id: run.id, ...payload })
      if (!mounted.current) return
      if (kind === 'cancel') { stopAccepted.current = true; setStopRequested(true) }
      else { setDraft(''); setWriting(false) }
    } catch (failure) {
      if (mounted.current) setError(failure?.message ?? t('Request failed'))
    } finally {
      pendingAction.current = null
      if (mounted.current) setPending(null)
    }
  }
  const stop = () => {
    if (!controls || stopAccepted.current || pendingAction.current !== null) return
    if (!confirming) { setConfirming(true); return }
    setConfirming(false)
    void mutate('cancel')
  }
  const send = (event) => {
    event?.preventDefault()
    const line = draft.trim()
    if (line !== '') void mutate('steer', { text: line })
  }
  const loadLog = async (after = 0) => {
    const scope = run.sessionId
    if (readingLog.current !== null || typeof act !== 'function') return
    const request = {}
    readingLog.current = request
    setLogBusy(true)
    setLogError('')
    try {
      const value = await invoke('task-run-log', { id: run.id, ...(after > 0 ? { after } : {}) })
      if (!Array.isArray(value?.events)) throw new Error(t('Could not read the task log. Try again.'))
      if (mounted.current && current.current.sessionId === scope) {
        const text = value.events.map(event => typeof event === 'string' ? event : JSON.stringify(event, null, 2)).join('\n\n')
        setLog(previous => ({ scope, sessionId: value.sessionId ?? scope, text: after > 0 && previous?.scope === scope ? `${previous.text}\n\n${text}` : text, next: Number.isSafeInteger(value.next) ? value.next : null }))
      }
    } catch (failure) {
      if (mounted.current && current.current.sessionId === scope) setLogError(failure?.message ?? t('Could not read the task log. Try again.'))
    } finally {
      if (readingLog.current === request) readingLog.current = null
      if (mounted.current) setLogBusy(false)
    }
  }
  const toggleLog = () => {
    setLogOpen(value => !value)
    if (!logOpen && !cachedLog) void loadLog()
  }
  const output = textOf(run.output), failure = textOf(run.error), notification = textOf(run.notification)
  const label = run.label || t('Task run')
  const identity = `${label} · ${run.id}`
  const state = STATUSES[run.status] ? run.status : 'unknown'
  return h('article', {
    ref: body, role: 'listitem', className: 'bt-task-run', 'data-run-id': run.id, 'data-status': state,
    'data-parent-run-id': run.parentRunId, 'data-flip': run.id, style: { marginInlineStart: `${depth * 12}px` },
  },
  h('div', { className: 'bt-task-run-head' },
    h('span', { className: 'bt-task-run-label' }, label),
    h('span', { className: 'bt-task-run-status' }, t(STATUSES[state]))),
  h('div', { className: 'bt-task-run-identity' },
    h('span', null, ownerName), h('code', null, run.id)),
  run.parentRunId ? h('div', { className: 'bt-note bt-task-run-parent' }, t('Child of {id}', { id: run.parentRunId })) : null,
  h(Field, { label: 'Model', code: true }, [run.provider, run.model].filter(Boolean).join('/') || t('Not available')),
  run.effort ? h(Field, { label: 'Effort' }, run.effort) : null,
  h(Field, { label: 'Folder', code: true }, run.cwd || t('Not available')),
  h(Field, { label: 'Permissions' }, t(MODES[run.sandboxMode] ?? 'Unknown')),
  h('div', { className: 'bt-task-run-times' },
    Number.isFinite(run.startedAt) ? h('span', { title: new Date(run.startedAt).toLocaleString() }, t('Started'), ' ', clockLabel(run.startedAt)) : null,
    Number.isFinite(run.endedAt) ? h('span', { title: new Date(run.endedAt).toLocaleString() }, t('Ended'), ' ', clockLabel(run.endedAt)) : null),
  failure ? h('div', { className: 'bt-error bt-task-run-error' }, failure) : null,
  notification ? h('div', { className: 'bt-note bt-task-run-notification' }, t(DELIVERIES[notification] ?? notification)) : null,
  output ? h(RunResult, { output, outputLength: run.outputLength, runId: run.id, act }) : null,
  stopRequested && active ? h('div', { className: 'bt-note', role: 'status' }, t('Stop requested')) : null,
  h('div', { className: 'bt-task-run-actions' },
    h('button', {
      type: 'button', className: 'bt-soft bt-soft-sm', disabled: !controls || pending !== null,
      'aria-expanded': writing && active, 'aria-controls': formId, 'aria-label': t('Add instructions to {run}', { run: identity }),
      onClick: () => setWriting(value => !value),
    }, t('Add instructions')),
    h('button', {
      type: 'button', className: 'bt-soft bt-soft-sm', disabled: !controls || pending !== null,
      'data-confirm': confirming || undefined, 'aria-label': t('Stop {run}', { run: identity }), onClick: stop,
    }, pending === 'cancel' ? t('Stopping…') : confirming ? t('Confirm stop') : t('Stop'))),
  writeShown ? h('form', { id: formId, className: 'bt-task-run-write', 'data-leaving': writeLeaving || undefined, 'aria-hidden': writeLeaving || undefined, onSubmit: send },
    h('textarea', {
      className: 'bt-input bt-input-area', value: draft, autoFocus: true,
      disabled: !controls || pending !== null || writeLeaving, 'aria-label': t('Instructions for {run}', { run: identity }), placeholder: t('What should change?'),
      onChange: event => setDraft(event.target.value),
      onKeyDown: event => { if (event.key === 'Escape') { event.stopPropagation(); setWriting(false) } },
    }),
    h('button', { type: 'submit', className: 'bt-send bt-soft-sm', disabled: !controls || pending !== null || writeLeaving || draft.trim() === '' }, pending === 'steer' ? t('Sending…') : t('Send'))) : null,
  error ? h('div', { className: 'bt-error bt-task-run-error', role: 'alert' }, error) : null,
  h('div', { className: 'bt-task-run-log-actions' },
    h('button', { type: 'button', className: 'bt-more', 'aria-expanded': logOpen, 'aria-controls': logId, disabled: typeof act !== 'function', onClick: toggleLog }, logOpen ? t('Hide log') : t('Show log')),
    run.sessionId && typeof onOpenSession === 'function' ? h('button', { type: 'button', className: 'bt-more', onClick: () => onOpenSession(run.sessionId) }, t('Open session')) : null),
  logShown ? h('div', { id: logId, className: 'bt-task-run-log', 'data-leaving': logLeaving || undefined, 'aria-hidden': logLeaving || undefined },
    logBusy ? h('div', { className: 'bt-note', role: 'status' }, t('Loading…')) : null,
    logError ? h('div', { className: 'bt-error', role: 'alert' }, logError) : null,
    cachedLog ? h('div', null,
      cachedLog.sessionId ? h('code', { className: 'bt-task-run-log-session' }, cachedLog.sessionId) : null,
      cachedLog.text ? h('pre', { className: 'bt-task-run-text' }, cachedLog.text) : h('div', { className: 'bt-note' }, t('No log entries yet.'))) : null,
    cachedLog?.next !== null && cachedLog?.next !== undefined ? h('button', { type: 'button', className: 'bt-more', disabled: logBusy || logLeaving, onClick: () => { void loadLog(cachedLog.next) } }, t('Load more log entries')) : null,
    h('button', { type: 'button', className: 'bt-more', disabled: logBusy || logLeaving, onClick: () => { void loadLog() } }, t('Refresh log'))) : null)
}

// A run is an execution instance, separate from a group's member-registered TaskBoard.
// Group-scoped records need roomId; membership alone does not establish run ownership.
export function TaskRuns({ state, bot, room, act, onOpenSession }) {
  const all = Array.isArray(state?.taskRuns) ? state.taskRuns : []
  const runs = all.filter(run => (!bot || run.ownerBotId === bot.id) && (!room || run.roomId === room.id))
  const rows = orderedRuns(runs)
  const list = useRef(null)
  useFlip(list, rows.map(({ run }) => run.id).join(':'), '.bt-task-run')
  return h('section', { className: 'bt-task-runs', 'aria-label': t('Task runs') },
    h('div', { className: 'bt-task-runs-head' },
      h('div', { className: 'bt-section-title' }, t('Task runs')),
      runs.length ? h('span', { className: 'bt-note' }, runs.length) : null),
    rows.length ? h('div', { ref: list, className: 'bt-task-run-list', role: 'list' }, rows.map(({ run, depth }) => h(RunRow, {
      key: run.id, run, depth, act, onOpenSession, readOnly: Boolean(state?.readOnly) || state?.taskRunsAvailable === false,
      ownerName: run.ownerName ?? (bot?.id === run.ownerBotId ? bot.name : state?.byId?.[run.ownerBotId]?.name) ?? run.ownerBotId,
    }))) : h('div', { className: 'bt-empty bt-task-runs-empty' }, t('No task runs yet.')))
}

export const TASK_RUNS_CSS = `
.bt-task-runs{min-width:0}
.bt-task-runs-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:8px}
.bt-task-runs-head>.bt-section-title{margin:0}
.bt-task-runs-empty{padding:12px 0}
.bt-task-run-list{display:flex;flex-direction:column;gap:8px}
.bt-task-run{min-width:0;padding:12px;border:1px solid var(--bt-line);border-radius:12px;background:var(--bt-card);color:var(--bt-ink);font-size:13px;line-height:18px}
.bt-task-run-head{display:flex;align-items:baseline;gap:8px;min-width:0}
.bt-task-run-label{flex:1;min-width:0;font-weight:600;overflow-wrap:anywhere}
.bt-task-run-status{flex:none;padding:0 6px;border-radius:4px;font-size:12px;line-height:16px;background:var(--bt-tag-bg);color:var(--bt-tag-ink)}
.bt-task-run[data-status=running] .bt-task-run-status,.bt-task-run[data-status=completed] .bt-task-run-status{color:var(--bt-green)}
.bt-task-run[data-status=starting] .bt-task-run-status{color:var(--bt-accent)}
.bt-task-run[data-status=failed] .bt-task-run-status{color:var(--bt-danger)}
.bt-task-run-identity{display:flex;flex-wrap:wrap;gap:4px 8px;margin:4px 0 8px;color:var(--bt-ink-2);font-size:11px;line-height:16px}
.bt-task-run code,.bt-task-run-text{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;overflow-wrap:anywhere}
.bt-task-run-parent{margin-bottom:6px;overflow-wrap:anywhere}
.bt-task-run-field{display:flex;flex-direction:column;gap:2px;margin-top:6px;min-width:0}
.bt-task-run-field>code{font-size:12px;line-height:16px;white-space:pre-wrap}
.bt-task-run-times{display:flex;flex-wrap:wrap;gap:4px 8px;margin-top:8px;color:var(--bt-ink-3);font-size:11px;line-height:16px;font-variant-numeric:tabular-nums}
.bt-task-run-actions,.bt-task-run-log-actions{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:8px}
.bt-task-run-actions>.bt-soft-sm,.bt-task-run-log-actions>.bt-more{margin:0}
.bt-task-run-actions [data-confirm]{color:var(--bt-danger)}
.bt-task-run-write{display:flex;flex-direction:column;align-items:flex-start;gap:6px;margin-top:8px;animation:bt-veil-in .22s ease-out both}
.bt-task-run-write>.bt-input-area{width:100%;box-sizing:border-box;resize:vertical;min-height:80px}
.bt-task-run-write>.bt-send{margin:0;min-height:28px}
.bt-task-run-error,.bt-task-run-notification{margin-top:8px;white-space:pre-wrap;overflow-wrap:anywhere}
.bt-task-run-result{margin-top:6px}
.bt-task-run-text{max-height:280px;overflow:auto;white-space:pre-wrap;margin:6px 0 0;padding:8px;border-radius:8px;background:var(--bt-hover);font-size:12px;line-height:16px}
.bt-task-run-log{margin-top:6px;animation:bt-veil-in .22s ease-out both}
.bt-task-run-log-session{display:block;color:var(--bt-ink-3);font-size:11px;line-height:16px}
.bt-task-run [data-leaving]{animation:bt-pop-out .16s ease forwards;pointer-events:none}
.bt-task-runs button,.bt-task-runs textarea{transition:background-color .12s ease,color .12s ease,${spring(SPRING_TAP, 'scale')}}
.bt-task-runs button{min-height:28px}
.bt-task-runs button:active:not(:disabled){scale:.96}
.bt-task-runs :is(button,textarea):focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}
@media(prefers-reduced-motion:reduce){.bt-task-runs *{animation:none!important;transition:none!important}}
body[data-bt-effects=off] .bt-task-runs *,body[data-bt-effects=reduced] .bt-task-runs *{animation:none!important;transition:none!important}
`
