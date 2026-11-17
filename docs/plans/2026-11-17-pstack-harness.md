# Scoped pstack Harness mapping (downstream extension)

Date: 2026-11-17. Phase 2 builds on locally accepted TaskRun commit `16801345f70e8c5276c79eb4ee1a62341f1d43a8`. The user requested starting phase 2 after defining its Feature acceptance contract. This is an explicit downstream integration, not an upstream design change or a completed pstack Feature run.

## Scope

Load the original pstack directory bundle through public DSH APIs in explicitly enabled Bot and TaskRun scopes. Add one separate Harness mapping section and a read-only preflight tool. Preserve original Skill bodies, metadata, relative resources, role settings, candidate counts, sequencing, fallback and exit rules. The caller chat runs its playbook. The plugin does not become a playbook state machine or impose a budget, retry limit, mandatory reviewer or human architecture checkpoint.

Default behavior is off. Plugin configuration uses `pstack: { enabled: true, sourceRoot, settingsFile? }`. `sourceRoot` is an explicit absolute checkout/mirror root containing `skills/`. `settingsFile`, when supplied, is an explicit absolute project/profile-owned pstack model settings file. Otherwise use the authorized original project root's `.agents/pstack-models.md`, not the operator's real home directory. Do not execute setup-pstack or write settings merely to activate the adapter. Missing settings retain source defaults; malformed or unreadable settings are reported, never replaced by a hidden global fallback.

## Original material and native metadata

Use `@deepseek-ai/dsh-skill-filesystem` in each enabled Agent context with a unique provider name, `includeDefaultRoots: false`, and `customSkillDirs: [sourceRoot/skills]`. The provider retains native locator/resourceBase and parses frontmatter. Register no duplicate tool named `skill` and do not replace the native registry. An independent `/how`, `/architect` or `/arena` sees the same mapping as `/poteto-mode`.

57 of this pinned source's 58 top-level Skills disable model invocation. Preserve that fact. Native direct user invocations in Bot chats require the native loader. Internal references in an already authorized workflow can read the original Skill files and relative resources; this is explicit source-contract loading, not a fabricated direct user gesture or a switch of modelInvocable to true. Bot relays and nested task briefs are not presumed to be direct user gestures. The provider grants no additional filesystem permission.

Raw Agent creation does not automatically compose the caller's normal tool preset. Task execution must retain the caller's exact preset revision in its stable host through the public `agentPresets.composeFrom` seam; native spawn then inherits that revision, including any native skill loader. A Task reports actual loader and source-reader visibility, uses authorized source reads for internal contracts, and reports a missing reader to its owner. The pstack adapter does not register a replacement loader. User slash entry support belongs to the Bot scope. Source loading and mapping fidelity do not imply identical tool sets across scopes.

External source references are preferred over vendoring. The pstack MIT license remains in its checkout. Any later distributed copy must preserve its notice and complete resource reachability, including references outside the immediate Skill directory.

## Scope and execution binding

The mapping and source provider share an Agent-owned fiber. Prepare Bot scopes before the first prompt assembly and explicitly prepare TaskRun scopes in the awaited worker creation hook. Persistent Bot capability attachment alone does not reach TaskRuns. Native execution hosts receive no pstack binding and never reason or execute tools. They retain the caller's normal preset revision only so children can compose the correct native tool world.

Only authorized, non-private Bot Sessions are eligible for initial binding. A new TaskRun inherits a serializable pstack binding from its actual calling Agent, not merely its ownerBotId. Persist source/settings paths and the available source/settings fingerprints with the run. Nested tasks inherit that binding. A disabled caller cannot opt in by supplying an arbitrary path or role. The snapshot is source/context provenance, not a Bot identity or an authority grant. Keep workers outside all Bot ownership indices.

Retain the original request_id receipt before re-reading new implicit configuration. If public task parameters later acquire role/selection/handoff values, include them in the request fingerprint. No terminal resume/fork or inherited-context claim is added. Dispose mounted fibers on plugin shutdown and individual Agent disposal.

## Native tool composition and boundaries

Public profile presets place filesystem, search, Shell, jobs, tool executors and skill loading in a retained composition tree. A raw stable host without that composition produced workers with only global working-directory and TaskRun control tools. Global-tool unit fixtures did not prove this production topology. Compose the stable host from the exact live caller in unpublished setup, without a native parent link to its Bot part and without copying tool callbacks. The public registry retains that revision until its last Agent reference is released.

Composition alone does not import caller-agent-local restrictions. Admission freezes the current step's actual admitted tool names, including conditional registration decisions; a programmatic call resolves and disposes its own admission. A nested task intersects its visible names with the parent's frozen upper bound. Worker restrictions and a monotonic execution guard enforce that bound, alongside existing native-delegation/team/goal bans and independent original root, filesystem mode and approval policy. The explicit TaskRun control API remains available. The recorded name list is provenance and an execution ceiling, not an authority grant.

Arbitrary argument-sensitive caller-local guards have no public generic serialization API and are not claimed to transfer. Shared preset/global/session policies continue through their public contexts; known DS-Bot task policies are reconstructed for the worker. Additional caller-local policy integrations require an explicit supported delegation policy, rather than silently assuming that a preset join copies them.

## Models and preflight

The source `setup-pstack/SKILL.md` code fence is the default role table. Parse that source instead of maintaining a second hard-coded model-default table. Preserve scalar values, ordered panel entries including duplicates, the ordered judge pool, aliases and budget metadata. Role labels can contain commas; native route values can contain colons. Unknown retired roles are reported without rewriting the file; duplicate or malformed known entries fail explicitly.

A scoped `pstack_preflight` tool reports source/settings provenance, effective role rows, current caller selection, the native model catalog and available effort facts, plus exact execution capabilities. It never chooses the fallback or silently changes a requested model. The original role uses its own Skill's configuration/default/adjustment/rejection/fallback policy. Model unavailability, provider authentication, transport and execution capacity remain distinct facts. Separate native fast/standard controls are not advertised; a registered speed-specific route remains a route, not an invented parameter.

Shared model-settings module interface: `readPstackModelSettings({ sourceRoot, settingsFile })` returns `rows` with `{ role, kind: 'single'|'panel'|'pool', origin: 'config'|'skill-default', values: string[] }`, budget/provenance/fingerprints and ignored role names. It performs no model calls and writes no files. Missing settings are represented explicitly. The pstack scope module consumes this interface and runtime `catalog`/`reasoningOf` facts.

## Harness mapping

- Task/Agent/spawn_agent maps to fresh `start_task`; model/effort/cwd use the corresponding task fields. Its return is admission, not completion.
- readonly/readOnly maps to `permission: 'read-only'`; it is never discarded as unsupported metadata. Filesystem mode alone is not advertised as a blanket guarantee against external MCP side effects.
- subagent_type is role intent. For unregistered poteto-agent, preserve the source's prompt prefix requiring the full absolute poteto-mode Skill and Principles. Routed generalPurpose roles keep their own prompts.
- Native completion notices and `read_task_run` expose results. `steer_task` targets only active work; `cancel_task` stops the authorized subtree. Steering is not terminal resume or context fork.
- Bot questions use its existing ask_user path; workers report missing operator information to their owner. No native ask_user_question or messaging guard is removed.
- Transcript evidence is limited to authorized task/session APIs and this run's explicit artifacts, not other projects or personal history.

## Alternatives considered

A global runtime-content capability is short but loses resource bases/frontmatter and leaks into unrelated Sessions. Decorating every Skill body would make mapping depend on the entry read and muddy source fidelity. A custom skill tool could bypass native invocation policy and hide the native catalog. The selected separate scoped provider plus mapping uses the existing public discovery, resource and lifecycle contracts.

## Acceptance

Use the agreed Feature acceptance contract for actual engineering claims. First test source loading, original invocation flags, scoped lifecycle and all independent entries with the real public registry/tool loader. Test settings defaults/aliases/panel order/duplicates/malformed files and truthful model capabilities without a workflow scheduler. Add real DS-Bot/production AgentLoop cases proving worker binding before its first request and no inheritance by an unauthorized scope. Re-run repository checks and an isolated public-CLI host smoke after host changes. Scripted model protocol tests are recorded separately from a real-inference Feature run. A Feature's business AC, real model route and delivery authority must be frozen before that run starts.
