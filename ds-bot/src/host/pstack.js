import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import * as FileSystemSkills from '@deepseek-ai/dsh-skill-filesystem'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { readPstackModelSettings } from './pstack-models.js'
import { serviceOf } from './services.js'

const PROVIDER = 'ds-bot-pstack'
const SECTION = 'ds-bot:pstack-harness'
const TASK_TOOLS = ['start_task', 'list_task_runs', 'read_task_run', 'steer_task', 'cancel_task']
const clone = value => JSON.parse(JSON.stringify(value))
const fail = message => Object.assign(new Error(`pstack: ${message}`), { code: 'bot/pstack-unavailable' })
const absolute = (value, label) => {
  if (typeof value !== 'string' || !isAbsolute(value)) throw fail(`${label} must be an explicit absolute path.`)
  return value
}

function mapping(binding, kind, access) {
  const mode = join(binding.sourceRoot, 'skills', 'poteto-mode', 'SKILL.md')
  return `pstack Harness mapping
Source checkout: ${binding.sourceRoot}
Original authorized project root: ${binding.projectRoot}
Role settings (preflight reads only): ${binding.settingsFile}
Native skill tool in this scope: ${access.skill ? 'visible; its original invocation policy still applies' : 'unavailable; no replacement tool is installed'}.
Source-contract read tool in this scope: ${access.read ? 'visible; actual reads still depend on filesystem permissions and execution guards' : 'unavailable; do not claim to load referenced source contracts or proceed with source-dependent steps; report this missing capability to the owner'}.
${kind === 'task' ? 'Task and relay briefs are not direct user Skill gestures. Load already authorized internal Skill contracts through the original files when read access permits; a task does not require or receive a substitute native skill tool.' : 'Direct user Skill gestures use the visible native loader in this Bot scope.'}
Use pstack_preflight for original role defaults, settings provenance and native model/effort facts. It reports facts and never chooses a fallback. Preserve each original Skill's panel counts, order, adjustment, rejection, fallback and exit rules. Do not invent a budget, retry cap, mandatory reviewer or architecture checkpoint.

All original Skills retain native invocation policy. Direct user /name invocations use the native loader. For internal references in an already authorized workflow, read the complete original file at ${join(binding.sourceRoot, 'skills', '<name>', 'SKILL.md')} and resolve its resources relative to that file's directory. Read only as needed. This source-contract loading does not turn relay/task messages into direct user gestures or enable model invocation of disabled Skills. The source provider grants no filesystem permissions.

Task, Agent and spawn_agent mean fresh start_task. Supply a complete brief and preserve the original role prompt. model maps to the actual native provider/model route, effort to its supported effort, cwd to the authorized working folder. readonly/readOnly maps to permission: 'read-only'; never drop it. A filesystem mode does not guarantee absence of external MCP side effects. subagent_type is role intent. For an unregistered poteto-agent, begin its brief with: Read ${mode} in full, including its Principles section, before any work. Routed generalPurpose roles retain their own prompts.
start_task returns admission, not completion. Inspect native completion notices and read_task_run for actual results. Independent work needs a fresh run. steer_task addresses only active work; it is not terminal resume or context fork. cancel_task stops the authorized execution subtree. Do not call native subagent, workflow, send_message or ask_user_question tools.
${kind === 'bot' ? 'Bot questions use the existing ask_user tool.' : 'Task workers return missing operator information to their owner; they do not use Bot ask_user or native questions.'}
Use only authorized task/session APIs and this run's explicit artifacts for transcripts. Never scan other projects or personal history. Use the configured settings file above and never scan the operator home. Preflight reads only; do not run setup-pstack or write settings merely to activate this adapter. An explicit request to configure models uses the original setup-pstack procedure, the scoped settings path above, the caller's permissions and its required user choices. Missing settings retain Skill defaults; malformed settings fail explicitly. Aliases auto and inherit-parent mean the actual caller selection, not a fabricated model slug. Native routes and supported efforts remain separate; no separate fast/standard parameter is assumed. Authentication, route availability, transport and execution capacity are distinct facts.`
}

export function install(rt) {
  const { ctx } = rt
  const config = rt.config.pstack
  const bindings = new Map()
  const pending = new WeakMap()
  const preparations = new Set()
  let stopped = false
  const eligibleBot = agent => {
    const id = agent?.session?.id
    if (!rt.isBotSession(id)) return false
    const bot = rt.botOf(rt.selfOf(id))
    return bot !== undefined && bot.private !== true && rt.isPrivate?.(bot.id) !== true
  }
  const active = agent => {
    const held = bindings.get(agent)
    return !stopped && held !== undefined && (held.kind !== 'bot' || eligibleBot(agent)) ? held : undefined
  }
  rt.pstackTaskBinding = agent => {
    const held = active(agent)
    return held === undefined ? undefined : clone(held.binding)
  }
  rt.preparePstackTask = async () => {}
  rt.preparePstackBot = async () => {}
  if (config?.enabled !== true) return

  async function prepare(agent, input, kind) {
    if (stopped) throw fail('The scope adapter has stopped.')
    if (bindings.has(agent)) return
    if (pending.has(agent)) return pending.get(agent)
    const work = (async () => {
      const skills = serviceOf(agent.ctx, 'skills')
      const prompt = serviceOf(agent.ctx, 'systemPrompt')
      const tools = serviceOf(agent.ctx, 'tools')
      if (!skills || !prompt || !tools) throw fail('Scoped Skills, system-prompt and tools services are required before the first step.')
      if (typeof tools.get !== 'function') throw fail('Scoped tool lookup is required before the first step.')
      if (kind === 'bot' && tools.get('skill', agent) === undefined) throw fail('The native skill loader must be visible before the first Bot step.')
      const sourceRoot = await realpath(absolute(input.sourceRoot, 'sourceRoot')).catch(error => { throw fail(`Cannot read sourceRoot: ${error.code ?? error.message}`) })
      const directory = join(sourceRoot, 'skills')
      if (!(await stat(directory).catch(() => undefined))?.isDirectory()) throw fail(`Skill directory is unavailable: ${directory}`)
      const projectRoot = await realpath(absolute(input.projectRoot, 'projectRoot'))
      const settingsFile = absolute(input.settingsFile ?? join(projectRoot, '.agents', 'pstack-models.md'), 'settingsFile')
      const settings = await readPstackModelSettings({ sourceRoot, settingsFile })
      if (stopped) throw fail('The scope adapter stopped during preparation.')
      const binding = {
        sourceRoot, settingsFile, projectRoot,
        provenance: input.provenance ?? { kind: 'bot', sessionId: agent.session.id },
        fingerprints: input.fingerprints ?? {
          sourceFile: settings.sourceFile, sourceHash: settings.sourceHash, defaultsHash: settings.defaultsHash,
          settingsStatus: settings.settingsStatus, settingsHash: settings.settingsHash,
        },
      }
      const held = { binding: clone(binding), kind, fiber: undefined }
      const fiber = agent.ctx.plugin({
        name: 'ds-bot-pstack-scope',
        inject: ['skills', 'systemPrompt', 'tools'],
        async apply(c) {
          await c.plugin(FileSystemSkills, { providerName: PROVIDER, includeDefaultRoots: false, customSkillDirs: [directory], watch: false }).await()
          c.systemPrompt.section({ name: SECTION, order: 610, interpolate: false, text: () => mapping(binding, kind, { skill: c.tools.get('skill', agent) !== undefined, read: c.tools.get('read', agent) !== undefined }) })
          c.tools.register(defineTool({
            name: 'pstack_preflight',
            description: 'Read this scope’s original pstack role defaults, settings, native model/effort catalog and execution capabilities. Reports facts without selecting or changing a model.',
            parameters: { role: { type: 'string', description: 'Optional exact pstack role label' } },
            output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
            async execute(args, exec) {
              if (exec.agent !== agent || active(agent) !== held) throw fail('The calling Agent does not own this pstack binding.')
              const currentSettings = await readPstackModelSettings({ sourceRoot, settingsFile })
              const catalog = typeof rt.catalog === 'function' ? await rt.catalog({ fresh: true }) : undefined
              const rows = args.role === undefined ? currentSettings.rows : currentSettings.rows.filter(row => row.role === args.role)
              const selection = agent.model?.current?.()
              const selectionRef = selection ? `${selection.provider}/${selection.model}` : undefined
              const requested = new Set(args.role === undefined ? [selectionRef] : rows.flatMap(row => row.values.map(value => ['auto', 'inherit-parent'].includes(value) ? selectionRef : value)))
              const models = []
              for (const entry of catalog ?? []) {
                const reasoning = entry.reasoning ?? (requested.has(entry.ref) && typeof rt.reasoningOf === 'function' ? await rt.reasoningOf(entry.ref) : undefined)
                models.push({ ...entry, ...(reasoning === undefined ? {} : { reasoning }), reasoningStatus: reasoning !== undefined ? 'available' : requested.has(entry.ref) ? 'unavailable' : 'not-queried' })
              }
              const availableTools = Object.fromEntries([...TASK_TOOLS, 'ask_user', 'skill', 'read'].map(name => [name, tools.get(name, agent) !== undefined]))
              const observed = await skills.snapshot({ scope: agent, cwd: agent.session.header.cwd, signal: exec.signal })
              if (active(agent) !== held) throw fail('The pstack binding ended during preflight.')
              return JSON.stringify({
                binding: clone(held.binding), settings: { ...currentSettings, rows },
                ...(args.role !== undefined ? { requestedRole: args.role, knownRole: rows.length > 0 } : {}),
                selection: selection ?? null,
                catalog: { available: catalog !== undefined, models },
                skills: { complete: observed.complete, entries: observed.skills.filter(item => item.provider === PROVIDER) },
                execution: {
                  tools: availableTools,
                  sourceContractLoading: availableTools.read ? 'read-visible; permissions and guards still apply' : 'read-unavailable; source-dependent steps require owner assistance',
                  taskAdmissionAvailable: rt.taskRunsAvailable?.() ?? false,
                  nativeSpawnRegistered: serviceOf(ctx, 'subagents')?.getProvider?.('spawn') !== undefined,
                  capacity: 'not-probed', transport: 'not-probed', inference: 'not-probed',
                  separateSpeedControl: false,
                },
              })
            },
          }))
          c.effect(() => () => { if (bindings.get(agent) === held) bindings.delete(agent) })
        },
      })
      held.fiber = fiber
      try {
        await fiber.await()
        const catalog = await skills.snapshot({ scope: agent, cwd: projectRoot })
        if (!catalog.complete || !catalog.skills.some(skill => skill.provider === PROVIDER)) throw fail('Original Skill discovery is incomplete or empty; check source frontmatter and source permissions.')
        if (stopped) throw fail('The scope adapter stopped during preparation.')
        if (kind === 'bot' && !eligibleBot(agent)) throw fail('The Bot is no longer eligible for pstack.')
        fiber.assertActive()
        bindings.set(agent, held)
      } catch (error) {
        await fiber.dispose()
        throw error
      }
    })()
    pending.set(agent, work)
    preparations.add(work)
    try { await work } finally { pending.delete(agent); preparations.delete(work) }
  }
  rt.preparePstackTask = async (agent, record) => {
    if (record.pstack === undefined) return
    if (!record.pstack || typeof record.pstack !== 'object') throw fail('Invalid persisted task binding.')
    const projectRoot = await realpath(absolute(record.projectRoot, 'task projectRoot'))
    const inheritedRoot = await realpath(absolute(record.pstack.projectRoot, 'binding projectRoot'))
    if (projectRoot !== inheritedRoot) throw fail('A task cannot change its inherited original project root.')
    await prepare(agent, { ...record.pstack, projectRoot }, 'task')
  }
  rt.preparePstackBot = async agent => {
    if (!eligibleBot(agent)) {
      const previous = bindings.get(agent)
      if (previous?.kind === 'bot') {
        bindings.delete(agent)
        await previous.fiber.dispose()
      }
      return
    }
    const policy = serviceOf(ctx, 'sandboxPolicy')
    if (typeof policy?.resolve !== 'function') throw fail('The sandbox policy service must identify the original project root.')
    const projectRoot = policy.resolve({ session: agent.session }).workspaceRoot
    await prepare(agent, { sourceRoot: config.sourceRoot, settingsFile: config.settingsFile, projectRoot }, 'bot')
  }
  ctx.on('agent/created', async ({ agent }) => {
    if (rt.isBotSession(agent.session.id)) await rt.preparePstackBot(agent)
  })
  ctx.effect(() => async () => {
    stopped = true
    await Promise.allSettled(preparations)
    const mounted = [...bindings.values()]
    bindings.clear()
    await Promise.all(mounted.map(held => held.fiber.dispose()))
  }, 'ds-bot: pstack scopes')
}
