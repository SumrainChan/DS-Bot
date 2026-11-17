// Execution instances are separate from Bot chats, group task cards and group goals.
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { SOURCE_KIND, TEXT_KEPT } from './constants.js'
import { within } from './folders.js'
import { replaceFile } from './files.js'
import { serviceOf } from './services.js'
import { own } from './store.js'
import { threadCurrentOfPart, threadOfPart } from './threads.js'
import { textOf } from './text.js'
import { createTaskExecutor } from './task-executor.js'
import { isLocalAgentRoute } from './local-agents/engines.js'
import { turnFailure } from './turns.js'

const ACTIVE = new Set(['starting', 'running'])
const MODES = ['read-only', 'workspace-write', 'danger-full-access']
const TASK_TOOLS = new Set(['start_task', 'list_task_runs', 'read_task_run', 'steer_task', 'cancel_task'])
const UNMANAGED = new Set(['subagent', 'subagent_fork', 'subagent_codex', 'subagent_claude_code', 'send_message', 'interrupt_agent', 'list_agents', 'workflow', 'ralph', 'spawn_teammate', 'wait_agent', 'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update', 'create_goal', 'update_goal', 'get_goal', 'schedule_create', 'schedule_edit', 'schedule_delete'])
const toolOutput = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] }
const reject = (message, code = 'bot/task-refused') => Object.assign(new Error(message), { code })
const requiredText = (value, name) => {
  if (typeof value !== 'string' || value.trim() === '') throw reject(`${name} must be nonempty text.`)
  return value.trim()
}
const table = value => value !== null && typeof value === 'object' && !Array.isArray(value)

export function install(rt) {
  const { ctx, state } = rt
  const enabled = rt.config.taskRuns !== false
  const runs = () => {
    if (!table(state.taskRuns)) state.taskRuns = {}
    return state.taskRuns
  }
  const requests = () => {
    if (!table(state.taskRunRequests)) state.taskRunRequests = {}
    return state.taskRunRequests
  }
  const find = id => own(runs(), String(id ?? ''))
  const sessionRun = sessionId => Object.values(runs()).find(record => record.sessionId === sessionId)
  const tools = []
  const settling = new Set()
  const starting = new Set()
  const notifications = new Map()
  const stoppingOwners = new Set()
  let stopped = false
  let reconciled = false
  let reconciling
  const cleanError = error => {
    const message = String(error?.message ?? error)
    const failure = turnFailure({ code: error?.code, status: error?.status, message: rt.redactSecrets?.(message) ?? message })
    return { code: failure.code, message: failure.message || failure.code }
  }
  const available = () => enabled && serviceOf(ctx, 'agents') !== undefined && serviceOf(ctx, 'subagents')?.getProvider?.('spawn') !== undefined && serviceOf(ctx, 'sandboxPolicy') !== undefined && serviceOf(ctx, 'approval') !== undefined
  const changes = async () => {
    await rt.save({ required: true })
    rt.publishFeed?.('live', {})
  }
  function writable() {
    if (!enabled) throw reject('Task runs are disabled.')
    if (stopped) throw reject('Task execution is stopping.')
    const reason = rt.readOnly()
    if (reason !== undefined) throw reject(reason)
  }
  function principal(exec) {
    if (exec?.user === true) return { user: true }
    const id = exec?.agent?.id
    const record = sessionRun(id)
    if (record !== undefined) {
      if (!ACTIVE.has(record.status)) throw reject('This task attempt is no longer active.')
      return { run: record, ownerBotId: record.ownerBotId, agent: exec.agent }
    }
    const ownerBotId = rt.selfOf(id)
    if (ownerBotId === undefined || !rt.isBotSession(id)) throw reject('Only an active Bot or task run can use task tools.')
    return { ownerBotId, agent: exec.agent }
  }
  function descendant(record, parentId) {
    const seen = new Set()
    let current = record
    while (current?.parentRunId !== undefined && !seen.has(current.id)) {
      if (current.parentRunId === parentId) return true
      seen.add(current.id)
      current = find(current.parentRunId)
    }
    return false
  }
  function permitted(record, who, control = false) {
    if (who.user) return true
    if (who.run !== undefined) return (!control && record.id === who.run.id) || descendant(record, who.run.id)
    return record.ownerBotId === who.ownerBotId
  }
  function authorize(id, exec, control = false) {
    const record = find(id)
    if (record === undefined) throw reject('No such task run.')
    if (!permitted(record, principal(exec), control)) throw reject('That task run is outside your execution tree.', 'bot/task-unauthorized')
    return record
  }
  const view = record => ({
    id: record.id, ownerBotId: record.ownerBotId, ownerName: rt.botOf(record.ownerBotId)?.name ?? record.ownerBotId,
    ...(record.roomId ? { roomId: record.roomId } : {}), ...(record.parentRunId ? { parentRunId: record.parentRunId } : {}),
    label: record.label, status: record.status, admission: record.admission, provider: record.actualModel?.provider ?? record.provider,
    model: record.actualModel?.model ?? record.model, ...((record.actualModel?.reasoningEffort ?? record.effort) ? { effort: record.actualModel?.reasoningEffort ?? record.effort } : {}),
    cwd: record.cwd, projectRoot: record.projectRoot, sandboxMode: record.sandboxMode,
    sessionId: record.sessionId, startedAt: record.startedAt, ...(record.endedAt ? { endedAt: record.endedAt } : {}),
    ...(record.pstack === undefined ? {} : { pstack: structuredClone(record.pstack) }),
    ...(record.inheritedTools === undefined ? {} : { inheritedTools: [...record.inheritedTools] }),
    ...(record.output !== undefined ? { output: record.output, outputLength: record.outputLength } : {}),
    ...(record.error ? { error: record.error.message, errorCode: record.error.code } : {}),
    ...(record.stopReason ? { stopReason: record.stopReason } : {}),
    ...(record.notification ? { notification: record.notification.status } : {}),
  })
  const list = exec => {
    const who = principal(exec)
    return Object.values(runs()).filter(record => permitted(record, who)).sort((a, b) => b.startedAt - a.startedAt).map(view)
  }
  const resultPath = record => join(rt.home, 'task-results', `${record.id}.json`)
  async function resultOf(record) {
    if (!/^run-[0-9a-f-]{36}$/.test(record.id)) throw reject('Invalid saved task identity.')
    if (record.resultSaved !== true) return { output: record.output ?? '', complete: false }
    const result = JSON.parse(await readFile(resultPath(record), 'utf8'))
    return { ...result, complete: true }
  }
  async function keepResult(record, result) {
    const path = resultPath(record)
    await mkdir(join(rt.home, 'task-results'), { recursive: true })
    const temp = `${path}.${randomUUID()}.tmp`
    await writeFile(temp, JSON.stringify(result), { encoding: 'utf8', mode: 0o600 })
    await replaceFile(temp, path, writable)
  }
  function targetOf(record) {
    if (record.parentRunId !== undefined) {
      const parent = find(record.parentRunId)
      return parent !== undefined && ACTIVE.has(parent.status) ? parent.sessionId : undefined
    }
    const bot = rt.botOf(record.ownerBotId)
    if (bot === undefined || stoppingOwners.has(record.ownerBotId)) return undefined
    if (record.roomId !== undefined) {
      const room = rt.roomOf(record.roomId)
      return room?.members?.includes(bot.id) ? room.sessions?.[bot.id] : undefined
    }
    return threadCurrentOfPart(bot, record.callerSessionId)
  }
  async function hasMessage(sessionId, messageId) {
    const query = serviceOf(ctx, 'sessionQuery')
    if (query === undefined) throw reject('Session history is unavailable.')
    const { events } = await query.readSession(sessionId)
    return events.some(event => (event.type === 'user/message' && (event.data?.id === messageId || event.data?.message?.id === messageId))
      || (event.type === 'agent/inbox/spliced' && (event.data?.inserted ?? []).some(message => message.id === messageId)))
  }
  async function notify(record) {
    if (stopped || record.notification?.status === 'delivered' || record.notification?.status === 'unknown') return
    if (notifications.has(record.id)) return notifications.get(record.id)
    const work = (async () => {
      const sessionId = targetOf(record)
      if (sessionId === undefined) {
        record.notification = { status: 'unavailable' }
        await changes()
        return
      }
      if (record.notification?.status === 'delivering') {
        try {
          const found = await hasMessage(record.notification.sessionId, record.notification.messageId)
          record.notification.status = found ? 'delivered' : 'unknown'
        } catch { record.notification.status = 'unknown' }
        await changes()
        return
      }
      const result = await resultOf(record).catch(() => ({ output: record.output ?? '', complete: false }))
      const errorLine = record.error === undefined ? '' : `\nExecution error: ${record.error.message}`
      const text = `[Task run ${record.id} · ${record.label} · ${record.status}]\n${result.output || '(No closing text.)'}${errorLine}${result.complete ? '' : '\n[The full result is unavailable.]'}`
      const long = await rt.attachLong(text, `${record.id}.txt`) ?? { text, files: [] }
      const parentWork = record.workChildId === undefined ? undefined : rt.closeWork(record.workChildId, record.label, text)
      await rt.ensureCapabilities(sessionId)
      const agent = record.parentRunId === undefined ? await rt.resolveAgent(sessionId) : serviceOf(ctx, 'agents')?.get(sessionId)
      if (agent === undefined) throw reject('The parent task is no longer available.')
      if (stopped || stoppingOwners.has(record.ownerBotId)) return
      const message = createUserMessage({
        content: [{ type: 'text', text: long.text }, ...long.files.map(attachment => ({ type: 'file', attachment }))],
        source: { kind: SOURCE_KIND, form: 'relay', role: 'reply', exchangeId: record.id, taskRunId: record.id,
          ...(long.length === undefined ? {} : { length: long.length }),
          ...(parentWork ? { work: parentWork, replyTo: record.workChildId } : {}),
          ...(record.roomId ? { roomId: record.roomId } : {}) },
      })
      record.notification = { status: 'delivering', sessionId, messageId: message.id }
      await changes()
      agent.followup(message)
      await ctx.sessions.flush(agent.session)
      record.notification.status = 'delivered'
      await changes()
    })()
    notifications.set(record.id, work)
    try { await work } catch (error) {
      record.notification = { ...record.notification, status: 'unknown', error: cleanError(error).message }
      await changes().catch(() => {})
      rt.warn('ds-bot: task result %s delivery is unknown: %s', record.id, cleanError(error).message)
    } finally { notifications.delete(record.id) }
  }
  async function settle(record, result) {
    const current = find(record.id)
    if (stopped || current !== record || !ACTIVE.has(record.status) || settling.has(record.id)) return
    settling.add(record.id)
    record.admission = 'accepted'
    try {
      const text = textOf(result.output ?? [])
      const saved = { output: text, blocks: result.output ?? [], stopReason: result.stopReason, ...(result.error ? { error: cleanError(result.error) } : {}) }
      await keepResult(record, saved)
      if (stopped || find(record.id) !== record) return
      record.resultSaved = true
      record.output = text.slice(0, TEXT_KEPT)
      record.outputLength = text.length
      record.stopReason = result.stopReason
      record.status = result.stopReason === 'completed' ? 'completed' : result.stopReason === 'aborted' ? 'cancelled' : 'failed'
      if (result.error) record.error = cleanError(result.error)
      else if (record.status === 'failed') record.error = { message: `Task execution ended with ${result.stopReason}; this is not successful completion.` }
      record.endedAt = Date.now()
      record.notification = record.parentRunId === undefined ? { status: 'pending' } : { status: 'native', sessionId: find(record.parentRunId)?.sessionId }
      await changes()
      if (record.parentRunId === undefined) await notify(record)
    } catch (error) {
      record.status = 'unknown'
      record.error = cleanError(error)
      record.endedAt = Date.now()
      await changes().catch(() => {})
    } finally { settling.delete(record.id) }
  }
  async function configureAgent(agent, record) {
    await rt.preparePstackTask?.(agent, record)
    for (const tool of tools) agent.ctx.tools.register(tool)
    const inherited = record.inheritedTools === undefined ? undefined : new Set(record.inheritedTools)
    const outside = name => inherited !== undefined && !TASK_TOOLS.has(name) && !inherited.has(name)
    const teamNames = new Set(rt.teamTools.map(tool => tool.name).filter(name => !TASK_TOOLS.has(name)))
    const deny = new Set([...UNMANAGED, ...teamNames, 'ask_user_question'])
    for (const tool of ctx.tools.schemas(agent)) if (outside(tool.name)) deny.add(tool.name)
    const visible = ctx.tools.schemas(agent).map(tool => tool.name).filter(name => deny.has(name))
    for (const name of visible) {
      try { agent.ctx.tools.restrict({ deny: [name] }) } catch { /* execution guard also covers scope-local tools */ }
    }
    agent.ctx.tools.guard(exec => outside(exec.name) ? 'This tool was not admitted by the calling Agent when the task started.' : deny.has(exec.name) ? 'Task workers use only their task execution tree; team management, native delegation and goals are unavailable.' : undefined)
    agent.ctx.systemPrompt.section({ name: 'task:identity', order: 600,
      text: `You are task run ${record.id} (${record.label}). Complete the supplied brief. You are not the owning Bot or a Main Bot. Only the explicit brief, instructions and authorized project material are your task context. Use start_task for necessary subwork and read_task_run to inspect its result. Your final answer is returned by the runtime automatically; do not call native messaging tools. Nested task completion arrives through the runtime's native completion notice. Keep engineering choices and exit conditions in the instructions you were given. A task execution completing does not by itself prove a project passed its checks.` })
    agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const value = await next()
      const keep = section => !deny.has(section.name?.replace(/^tool:/, '')) && !(section.name?.startsWith('tool:') && outside(section.name.slice(5))) && !['team:policy', 'team:identity'].includes(section.name)
      return { ...value, sections: value.sections.filter(keep), contexts: value.contexts.filter(keep) }
    })
  }
  const executor = createTaskExecutor(ctx, {
    configureAgent,
    onResult: settle,
    onChange: async (record, patch) => {
      if (stopped || find(record.id) !== record || !ACTIVE.has(record.status)) return
      Object.assign(record, patch)
      await changes()
    },
  })
  async function start(args, exec) {
    await rt.load()
    writable()
    if (!available()) throw reject('Task execution needs the public DSH Agent, spawn, sandbox-policy and approval services.', 'bot/task-unavailable')
    const who = principal(exec)
    const bot = rt.botOf(who.ownerBotId)
    if (bot === undefined || who.agent === undefined) throw reject('Start a task from the Bot conversation that owns it.')
    if (stoppingOwners.has(bot.id)) throw reject('This task owner is being deleted.')
    if (rt.isPrivate(bot.id)) throw reject('Task execution for private Bots is not enabled; task result storage has not been integrated with private archives.')
    const brief = requiredText(args.brief, 'Task brief')
    const label = requiredText(args.label, 'Task label').slice(0, 160)
    const instructions = typeof args.instructions === 'string' ? args.instructions.trim() : ''
    const roomId = who.run?.roomId ?? rt.groupOwners.get(who.agent.id)?.roomId
    const thread = roomId === undefined ? threadOfPart(bot, who.agent.id) : undefined
    const namespace = who.run?.id ?? roomId ?? thread?.segments?.[0]?.sessionId ?? who.agent.id
    const requestId = args.request_id === undefined ? undefined : requiredText(args.request_id, 'request_id')
    const requestKey = requestId === undefined ? undefined : createHash('sha256').update(JSON.stringify([who.ownerBotId, namespace, requestId])).digest('hex')
    const fingerprint = createHash('sha256').update(JSON.stringify({ label, brief, instructions, model: args.model ?? null, effort: args.effort ?? null, cwd: args.cwd ?? null, permission: args.permission ?? null })).digest('hex')
    const previousRequest = () => {
      const earlier = requestKey === undefined ? undefined : own(requests(), requestKey)
      if (earlier === undefined) return undefined
      if (earlier.fingerprint !== fingerprint) throw reject('That request_id already names different task instructions.', 'bot/task-conflict')
      const existing = find(earlier.id)
      if (existing === undefined) throw reject('The original task outcome is unknown; it was not started again.')
      return view(existing)
    }
    const cached = previousRequest()
    if (cached !== undefined) return cached
    const inherited = who.agent.model?.current?.()
    const modelRef = args.model === undefined ? (inherited ? `${inherited.provider}/${inherited.model}` : undefined) : await rt.resolveModel(args.model)
    if (!modelRef) throw reject('The calling Agent has no model; select one before starting a task.')
    const slash = modelRef.indexOf('/')
    if (isLocalAgentRoute(modelRef.slice(0, slash))) throw reject('Task runs currently require a native model route; CLI execution is not enabled.')
    const provider = modelRef.slice(0, slash), model = modelRef.slice(slash + 1)
    if (slash <= 0 || model === '') throw reject('The task model must name a provider and model.')
    const effort = args.effort === undefined ? (args.model === undefined ? inherited?.reasoningEffort : undefined) : await rt.resolveEffort(modelRef, args.effort)
    const policy = serviceOf(ctx, 'sandboxPolicy').resolve({ session: who.agent.session })
    const sandboxMode = args.permission ?? policy.mode
    if (!MODES.includes(sandboxMode) || !MODES.includes(policy.mode) || MODES.indexOf(sandboxMode) > MODES.indexOf(policy.mode)) throw reject('A task cannot widen its calling Agent permissions.', 'bot/task-permission')
    const projectRoot = await realpath(policy.workspaceRoot)
    const directory = args.cwd ?? serviceOf(ctx, 'workingDirectory')?.get(who.agent.session) ?? who.agent.session.header.cwd
    if (typeof directory !== 'string') throw reject('The calling Agent has no working directory.')
    const cwd = await realpath(directory)
    if (!await rt.isFolder(cwd)) throw reject('The task directory is not an existing folder.')
    await rt.workFolder(cwd)
    if (sandboxMode !== 'danger-full-access' && !within(cwd, projectRoot)) throw reject('The task directory is outside the calling Agent project root.', 'bot/task-permission')
    if (who.run !== undefined && who.run.projectRoot !== projectRoot) throw reject('A nested task cannot change its inherited project root.')
    const pstack = await rt.pstackTaskBinding?.(who.agent)
    let admission
    let inheritedTools
    try {
      if (exec.toolSet === undefined) {
        if (inherited === undefined) throw reject('The calling Agent has no model selection for tool admission.')
        admission = await ctx.tools.resolve({ agent: who.agent, modelSelection: inherited, signal: exec.signal ?? new AbortController().signal })
      }
      const upper = who.run?.inheritedTools === undefined ? undefined : new Set(who.run.inheritedTools)
      inheritedTools = ctx.tools.schemas(who.agent, exec.toolSet ?? admission).map(tool => tool.name).filter(name => upper === undefined || upper.has(name) || TASK_TOOLS.has(name))
    } finally { admission?.dispose() }
    writable()
    exec.signal?.throwIfAborted()
    if (stoppingOwners.has(bot.id) || rt.botOf(bot.id) !== bot) throw reject('The task owner changed before admission.')
    if (rt.isPrivate(bot.id)) throw reject('Task execution for private Bots is not enabled.')
    const currentMode = serviceOf(ctx, 'sandboxPolicy')?.resolve({ session: who.agent.session }).mode
    if (MODES.indexOf(sandboxMode) > MODES.indexOf(currentMode)) throw reject('The calling Agent permissions changed before task admission.', 'bot/task-permission')
    // Two identical calls may have passed the first lookup before directory/model
    // validation awaited. Reserve only after checking the shared table again.
    const raced = previousRequest()
    if (raced !== undefined) return raced
    const record = { id: `run-${randomUUID()}`, ownerBotId: bot.id, callerSessionId: who.agent.id,
      ...(roomId ? { roomId } : {}), ...(who.run ? { parentRunId: who.run.id } : {}),
      hostSessionId: who.run?.hostSessionId ?? `task-host-${randomUUID()}`, sessionId: `task-${randomUUID()}`,
      label, brief, instructions, provider, model, ...(effort ? { effort } : {}), cwd, projectRoot, sandboxMode, inheritedTools,
      ...(pstack === undefined ? {} : { pstack: structuredClone(pstack) }),
      approvalPolicy: serviceOf(ctx, 'approval')?.overrideOf?.(who.agent.session) ?? serviceOf(ctx, 'approval')?.config?.policy ?? 'ask',
      admission: 'pending', status: 'starting', startedAt: Date.now() }
    runs()[record.id] = record
    if (requestKey !== undefined) requests()[requestKey] = { fingerprint, id: record.id }
    const work = rt.workOf?.(rt.live.get(who.agent.id)?.info)
    if (!who.run && work !== undefined && rt.ownsWork?.(bot.id, work)) {
      record.workChildId = `task:${record.id}`
      rt.openWork(record.workChildId, { parent: work, from: bot.id, fromPart: who.agent.id, name: label, child: record.sessionId })
    }
    starting.add(record.id)
    try {
      await changes()
      writable()
      if (stoppingOwners.has(bot.id)) throw reject('This task owner is being deleted.')
      exec.signal?.throwIfAborted()
      const accepted = await executor.start(record, who.run)
      record.admission = 'accepted'
      const { childId, messageId, hostSessionId, runId, notification } = accepted
      Object.assign(record, { childId, messageId, hostSessionId, runId, delivery: notification })
      if (record.status === 'starting') record.status = 'running'
      await changes()
      return view(record)
    } catch (error) {
      if (record.admission === 'accepted') {
        if (ACTIVE.has(record.status)) {
          record.status = 'unknown'
          record.error = cleanError(error)
          record.endedAt = Date.now()
          await executor.cancel(record).catch(failure => rt.warn('ds-bot: task %s cleanup failed: %s', record.id, cleanError(failure).message))
        }
      } else {
        record.admission = 'rejected'
        record.status = record.cancelRequested ? 'cancelled' : 'failed'
        record.error = { ...cleanError(error), message: `Task start ${record.cancelRequested ? 'cancelled' : 'rejected'}: ${cleanError(error).message}` }
        record.endedAt = Date.now()
        // The original tool error informs the caller. No native execution result
        // or separate completion notice exists for an attempt that was not admitted.
        if (record.workChildId !== undefined) {
          const parent = rt.closeWork(record.workChildId, record.label, record.error.message)
          if (parent !== undefined) rt.takenWork(parent, record.workChildId)
        }
      }
      await changes().catch(() => {})
      throw error
    } finally { starting.delete(record.id) }
  }
  async function stopOwner(ownerBotId) {
    stoppingOwners.add(ownerBotId)
    const active = Object.values(runs()).filter(record => record.ownerBotId === ownerBotId && ACTIVE.has(record.status))
    if (active.length === 0) return
    const owned = []
    for (const record of active) {
      record.cancelRequested = true
      if (executor.ownsSession(record.sessionId)) owned.push(record)
      else {
        record.status = 'unknown'
        record.error = { message: 'The deleted Bot no longer has a live execution owner; this task was not restarted.' }
        record.endedAt = Date.now()
      }
    }
    await changes()
    await Promise.all(owned.map(record => executor.cancel(record)))
  }
  async function control(id, action, text, exec) {
    await rt.load()
    writable()
    const record = authorize(id, exec, true)
    if (!ACTIVE.has(record.status)) throw reject('This task run is already terminal; start a fresh run for new work.')
    if (action === 'steer') {
      if (exec?.user !== true && rt.isPrivate(record.ownerBotId)) throw reject('Task execution for private Bots is not enabled.')
      await executor.steer(record, requiredText(text, 'Instruction'))
    }
    else if (action === 'cancel') {
      record.cancelRequested = true
      await changes()
      await executor.cancel(record)
    }
    else throw reject('Unknown task operation.')
    return view(record)
  }
  async function log(id, exec, after = 0) {
    await rt.load()
    const record = authorize(id, exec)
    const query = serviceOf(ctx, 'sessionQuery')
    if (query === undefined) throw reject('Task Session history is unavailable.')
    const { events } = await query.readSession(record.sessionId)
    const from = Number.isSafeInteger(after) && after >= 0 ? after : 0
    return { sessionId: record.sessionId, events: events.slice(from, from + 200), next: from + 200 < events.length ? from + 200 : null }
  }
  async function read(id, exec) {
    await rt.load()
    const record = authorize(id, exec)
    return { ...view(record), ...(ACTIVE.has(record.status) ? {} : { result: await resultOf(record).catch(() => ({ output: record.output ?? '', complete: false })) }) }
  }
  function reconcile() {
    if (reconciling !== undefined) return reconciling
    reconciling = (async () => {
      await rt.load()
      if (stopped || rt.readOnly() !== undefined || reconciled) return
      reconciled = true
      for (const record of Object.values(runs())) {
        if (starting.has(record.id)) continue
        if (ACTIVE.has(record.status)) {
          record.status = 'unknown'
          record.error = { message: 'The execution was interrupted or its owner runtime changed. It was not automatically restarted.' }
          record.endedAt = Date.now()
          await changes()
        } else if (record.parentRunId === undefined && ['pending', 'delivering'].includes(record.notification?.status)) await notify(record)
      }
    })().finally(() => { reconciling = undefined })
    return reconciling
  }
  function add(name, description, parameters, execute) {
    const tool = defineTool({ name, description, parameters, output: toolOutput, async execute(args, exec) {
      await rt.load()
      const value = await execute(args, exec)
      return JSON.stringify(value)
    } })
    tools.push(tool)
    if (enabled) rt.teamTools.push(tool)
  }
  add('start_task', 'Start an independent background task with an explicit brief. Admission returns a run id; completion arrives later. Each call creates a fresh context unless request_id names an existing identical request. Use a separate run for fresh fixes. Task completion is not engineering acceptance.', {
    label: { type: 'string', required: true, description: 'Short task label' }, brief: { type: 'string', required: true, description: 'Complete task instructions and authorized handoff material' },
    instructions: { type: 'string', description: 'Task-specific system instructions; no old Bot history is copied' },
    model: { type: 'string', description: 'Exact provider/model or served model name; omitted uses the caller actual model' }, effort: { type: 'string', description: 'A supported effort for the selected model' },
    cwd: { type: 'string', description: 'Existing task working folder, within the authorized project for confined execution' }, permission: { type: 'string', enum: MODES, description: 'Inherit or narrow the caller sandbox mode' },
    request_id: { type: 'string', description: 'Optional stable identity; identical retries reuse the original receipt, conflicts refuse' },
  }, start)
  add('list_task_runs', 'List task execution instances you own, or this task and its descendants. Lists execution facts, not engineering acceptance.', {}, (_args, exec) => list(exec))
  add('read_task_run', 'Read one authorized task status and its full retained terminal result.', { id: { type: 'string', required: true, description: 'Task run id' } }, (args, exec) => read(args.id, exec))
  add('steer_task', 'Send an additional instruction to one active task. It does not restart a terminal task or alter sibling tasks.', { id: { type: 'string', required: true }, text: { type: 'string', required: true } }, (args, exec) => control(args.id, 'steer', args.text, exec))
  add('cancel_task', 'Stop one owned task execution and its owned descendants. Other runs and Bot chats continue. Cancellation is distinct from success.', { id: { type: 'string', required: true } }, (args, exec) => control(args.id, 'cancel', undefined, exec))
  ctx.tools.guard(exec => {
    if (!executor.ownsSession(exec.agent?.id)) return undefined
    if (executor.isHostSession(exec.agent?.id)) return 'Execution hosts do not run tools.'
    if (UNMANAGED.has(exec.name) || (rt.teamTools.some(tool => tool.name === exec.name) && !TASK_TOOLS.has(exec.name))) return 'Use only authorized task execution tools; a worker is not its owning Bot.'
    return undefined
  })
  ctx.effect(() => async () => {
    stopped = true
    let changed = false
    for (const record of Object.values(runs())) {
      if (!ACTIVE.has(record.status)) continue
      changed = true
      record.status = 'unknown'
      record.error = { message: 'The task runtime stopped before a durable final result was recorded; the task was not restarted.' }
      record.endedAt = Date.now()
    }
    // Queue this while store.save still accepts writes. Cordis starts other cleanup
    // callbacks while execution drains; the store then waits on its queued writes.
    const saving = changed ? rt.save({ required: true }) : Promise.resolve()
    await Promise.all([saving, executor.dispose()])
  }, 'ds-bot: task execution')
  Object.assign(rt, {
    taskRunsView: () => Object.values(runs()).sort((a, b) => b.startedAt - a.startedAt).map(view),
    taskRunsAvailable: available,
    taskRunOfSession: sessionRun,
    taskRunStart: start,
    taskRunRead: read,
    taskRunLog: log,
    taskRunControl: control,
    taskRunStopOwner: stopOwner,
    reconcileTaskRuns: reconcile,
  })
  void Promise.resolve().then(reconcile).catch(error => rt.warn('ds-bot: task reconciliation failed: %s', cleanError(error).message))
}
