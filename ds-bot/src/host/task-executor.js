import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { SessionId } from '@deepseek-ai/dsh-session'
import { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import { serviceOf } from './services.js'

const content = text => [{ type: 'text', text }]
const failureOf = error => ({ message: String(error?.message ?? error), ...(typeof error?.code === 'string' ? { code: error.code } : {}) })

/** Execute validated, persisted task attempts without borrowing a Bot's chat Session. */
export function createTaskExecutor(ctx, { configureAgent, onResult, onChange } = {}) {
  const runs = new Map()
  const sessions = new Map()
  const hosts = new Map()
  const callbackErrors = []
  let closing

  function service(name) {
    const found = serviceOf(ctx, name)
    if (found === undefined) throw new Error(`Task execution needs the ${name} service`)
    return found
  }
  const agents = () => service('agents')
  const subagents = () => service('subagents')
  const ownsSession = sessionId => sessions.has(sessionId) || hosts.has(sessionId)
  const isHostSession = sessionId => hosts.has(sessionId)
  const warn = (entry, error) => {
    callbackErrors.push(error)
    ctx.logger?.warn('task-executor: callback failed for %s: %s', entry.config.id, error)
  }
  const change = (entry, patch) => {
    entry.notifications = entry.notifications.then(() => onChange?.(entry.record, patch)).catch(error => warn(entry, error))
  }

  const offCreated = ctx.on('agent/created', async ({ agent }) => {
    const entry = sessions.get(agent.id)
    if (entry === undefined) return
    const { config } = entry
    setSandboxMode(agent.session, config.sandboxMode)
    if (config.approvalPolicy !== undefined) setApprovalPolicy(agent.session, config.approvalPolicy)
    if (config.instructions) agent.ctx.systemPrompt.section({ name: 'task:instructions', order: 0, text: config.instructions })
    await configureAgent?.(agent, entry.record)
    entry.controller.signal.throwIfAborted()
  })
  const offStart = ctx.on('subagent/start', info => {
    const entry = sessions.get(info.id)
    if (entry === undefined || info.provider !== 'spawn' || entry.settled) return
    entry.runId = info.runId
    change(entry, { runId: info.runId })
  })
  const offEvent = ctx.on('session/event', (session, event) => {
    const entry = sessions.get(session.id)
    if (entry === undefined || entry.settled) return
    if (event.type === 'turn/end') {
      entry.failure = event.data?.reason?.kind === 'error' ? failureOf(event.data.reason.error) : undefined
      return
    }
    if (event.type !== 'request/header') return
    const { provider, model, reasoningEffort } = event.data.header.config
    entry.actualModel = { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) }
    change(entry, { actualModel: entry.actualModel })
  })

  async function createHost(config) {
    let host = hosts.get(config.hostSessionId)
    if (host !== undefined && host.projectRoot !== config.projectRoot) throw new Error('A task host cannot change its project root')
    if (host === undefined) {
      if (sessions.has(config.hostSessionId)) throw new Error('A task host cannot use a worker Session')
      host = { projectRoot: config.projectRoot, controller: new AbortController() }
      hosts.set(config.hostSessionId, host)
      host.pending = agents().create({
        sessionId: SessionId(config.hostSessionId),
        meta: { cwd: config.projectRoot },
        agentOptions: { provider: config.provider, model: config.model },
        signal: host.controller.signal,
        setup(agentCtx) {
          // The host is an execution owner, never another reasoning role or automatic driver.
          agentCtx.on('agent/pre-step', ({ agent }, next) => agent.id === config.hostSessionId ? { kind: 'reject' } : next())
          agentCtx.tools.guard(exec => exec.agent?.id === config.hostSessionId ? 'Task execution hosts do not execute tools' : undefined)
        },
      }).then(handle => {
        host.handle = handle
        return host
      })
    }
    return host.pending
  }

  function find(record) {
    const entry = runs.get(record.id)
    if (entry === undefined || entry.config.sessionId !== record.sessionId) throw new Error('This task execution is not owned by this executor')
    return entry
  }

  async function parentOf(entry, parentRecord) {
    const { config } = entry
    if (config.parentRunId === undefined) {
      if (parentRecord !== undefined) throw new Error('A top-level task cannot supply a parent run')
      const host = await createHost(config)
      entry.host = host
      return host.handle.agent
    }
    if (parentRecord === undefined || parentRecord.id !== config.parentRunId) throw new Error('A nested task needs its exact parent record')
    const parent = find(parentRecord)
    if (parent.config.projectRoot !== config.projectRoot || parent.config.hostSessionId !== config.hostSessionId) {
      throw new Error('A native nested task must share its parent project root and stable host')
    }
    await parent.pending
    if (parent.settled || parent.cancelRequested) throw new Error('A nested task needs an active parent execution')
    const agent = agents().get(SessionId(parent.config.sessionId))
    if (agent === undefined) throw new Error('The parent task Agent is no longer live')
    entry.host = parent.host
    return agent
  }

  async function finish(entry, result) {
    entry.settled = true
    if (result.stopReason === 'error' && result.error === undefined && entry.failure !== undefined) result = { ...result, error: entry.failure }
    entry.result = result
    await entry.notifications
    try {
      await onResult?.(entry.record, result)
    } catch (error) {
      warn(entry, error)
    }
  }

  async function launch(entry, parentRecord) {
    const { config } = entry
    try {
      service('sandboxPolicy')
      if (config.approvalPolicy !== undefined) service('approval')
      const parent = await parentOf(entry, parentRecord)
      entry.controller.signal.throwIfAborted()
      // Native parent delivery admits the child notice before capturing the parent's final output.
      const activation = await subagents().startActivation({
        provider: 'spawn',
        childId: SessionId(config.sessionId),
        label: config.id,
        delivery: config.parentRunId === undefined ? 'caller' : 'parent',
        signal: entry.controller.signal,
        request: {
          parent,
          cwd: config.cwd,
          prompt: content(config.brief),
          agentOptions: { provider: config.provider, model: config.model, reasoningEffort: config.effort },
        },
      })
      entry.activation = activation
      entry.parent = parent
      // Even an already-settled activation reports after start's acceptance reaches its caller.
      entry.delivery = activation.result.then(
        async result => { entry.settled = true; await new Promise(resolve => setImmediate(resolve)); await finish(entry, result) },
        async error => { entry.settled = true; await new Promise(resolve => setImmediate(resolve)); await finish(entry, { stopReason: 'error', output: [], error: failureOf(error) }) },
      )
      if (entry.cancelRequested) await release(entry)
      return { childId: activation.childId, messageId: activation.messageId, hostSessionId: config.hostSessionId, runId: entry.runId, notification: config.parentRunId === undefined ? 'caller' : 'native' }
    } catch (error) {
      entry.settled = true
      throw error
    }
  }

  function start(record, parentRecord) {
    if (closing !== undefined) return Promise.reject(new Error('The task executor is disposed'))
    const previous = runs.get(record.id)
    if (previous !== undefined) {
      if (previous.config.sessionId !== record.sessionId) return Promise.reject(new Error('A task attempt cannot change its Session'))
      return previous.pending
    }
    if (sessions.has(record.sessionId) || hosts.has(record.sessionId) || record.sessionId === record.hostSessionId) {
      return Promise.reject(new Error('A task needs an unused worker Session'))
    }
    const entry = { record, config: Object.freeze({ ...record }), controller: new AbortController(), notifications: Promise.resolve(), settled: false, cancelRequested: false }
    runs.set(record.id, entry)
    sessions.set(record.sessionId, entry)
    entry.pending = launch(entry, parentRecord)
    return entry.pending
  }

  async function steer(record, text) {
    if (closing !== undefined) throw new Error('The task executor is disposed')
    const entry = find(record)
    await entry.pending
    if (entry.settled || entry.cancelRequested) throw new Error('A terminal task needs an explicit new attempt')
    if (agents().get(SessionId(entry.config.sessionId)) === undefined) throw new Error('The task Agent is no longer live')
    const messageId = await subagents().sendMessage(entry.parent, SessionId(entry.config.sessionId), content(text), { signal: entry.controller.signal })
    return { childId: entry.config.sessionId, messageId }
  }

  function release(entry) {
    if (entry.releasing === undefined && entry.activation !== undefined) entry.releasing = entry.activation.dispose()
    return entry.releasing
  }

  async function cancel(record) {
    const entry = find(record)
    if (entry.settled) return { childId: entry.config.sessionId, requested: false }
    entry.cancelRequested = true
    entry.controller.abort(new Error('Task execution cancelled'))
    if (entry.activation !== undefined) await release(entry)
    return { childId: entry.config.sessionId, requested: true }
  }

  function dispose() {
    if (closing !== undefined) return closing
    // Close admission before any asynchronous teardown can admit another run.
    closing = Promise.resolve().then(async () => {
      const errors = []
      const collect = results => { for (const result of results) if (result.status === 'rejected') errors.push(result.reason) }
      for (const entry of runs.values()) {
        entry.cancelRequested = true
        entry.controller.abort(new Error('Task executor disposed'))
      }
      for (const host of hosts.values()) host.controller.abort(new Error('Task executor disposed'))
      collect(await Promise.allSettled([...runs.values()].filter(entry => entry.activation !== undefined).map(release)))
      await Promise.allSettled([...runs.values()].map(entry => entry.pending))
      await Promise.allSettled([...hosts.values()].map(host => host.pending))
      const handles = [...hosts.values()].flatMap(host => host.handle === undefined ? [] : [host.handle])
      // AgentHandle.dispose can wait for owned children; drain the exact forest first.
      const delegation = serviceOf(ctx, 'subagents')
      if (delegation !== undefined) collect(await Promise.allSettled(handles.map(handle => delegation.drainDescendants([handle.agent]))))
      collect(await Promise.allSettled(handles.map(handle => handle.dispose())))
      collect(await Promise.allSettled([...runs.values()].flatMap(entry => entry.delivery === undefined ? [] : [entry.delivery])))
      offEvent()
      offStart()
      offCreated()
      sessions.clear()
      hosts.clear()
      errors.push(...callbackErrors)
      if (errors.length > 0) throw new AggregateError(errors, 'Task executor cleanup failed')
    })
    return closing
  }

  return { start, steer, cancel, dispose, ownsSession, isHostSession }
}
