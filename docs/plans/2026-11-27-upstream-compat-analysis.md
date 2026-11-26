# 上游 920 提交兼容性分析（P0 详细版）

日期 2026-11-27。基线：本地 `feat/pstack-harness bf46e80d`（基于 `218a6bd0`）对 `upstream/main d104d9ca`。本文件是分析方案与首轮结论，不改代码。

## 0. 基线修正：应取 dev，不是 main

- `upstream/main d104d9ca`（11-22）是发布分支；`upstream/dev d1f82c90`（11-26）**领先 main 1,171 个提交**，是活跃开发分支。
- 相对本地基点 `218a6bd0`：**2,091 个提交、1,094 个文件、+299,990/−36,523**；本地 51 个文件与上游重叠 **23 个**。
- 仓库已迁到 `Fei-Craft/DS-Bot`（package homepage/repository 已改），`Fei2411` 仍可重定向；fork 已同步 `dev d1f82c90`。
- dev 的任务系统比 main 大得多：`bot-tasks.js` **3,651 行**（main 1,445），`parts.js` **4,734 行**（main 2,319）；新增 `TASK_HIDDEN_TEAM_TOOLS`，在任务会话中**硬隐藏** `task_*`、`ask_user` 等工具（`tools.js:1720`），比 main 的提示词约束更强，与我们的硬 ceiling 方向一致。
- dev 的团队工具新增 `delegate_work`、`ask_back`、`answer_work`、`cancel_work`、`note_bot`；`TASK_HIDDEN_TEAM_TOOLS` 也覆盖这些。
- dev 新增**插件 SDK**（`ds-bot/plugin-sdk` 的 `defineBotPlugin`/`defineBrowserProvider`）与 `code-mode` 导出；SDK 只覆盖工具与浏览器 provider，**没有任务执行器扩展点**。
- 因此迁移基线取 **`upstream/dev d1f82c90`**，PR 目标应是 dev（若向上游贡献）或 fork 的 dev；main 只在需要发布时合入。

以下第 1–4 节以 main 的 920 提交为样本说明域级变化；第 5 节起按 dev 的更大范围评估。

## 1. 规模与主题

- 上游：**920 个提交，545 个文件，+68,524 / −9,919**；新增 157 个文件，删除 6 个，重命名 3 个。
- 本地：3 个提交，51 个文件；与上游改动**重叠 22 个文件**。
- DSH 测试 harness 版本未变：`@deepseek-ai/dsh 0.2.2-rc.1`（我们依赖的公开 API 假设仍有效）。
- ds-bot 版本 0.3.6 → 0.3.10；新增 React 19 devDependencies、`test:browser`、`ds-bot-mcp` bin。

上游主要特性域：

| 域 | 代表提交/文件 | 影响面 |
|---|---|---|
| 后台任务 #783 | `bot-tasks.js`(1445行)、`parts.js:openTaskPart`、`client/bot-tasks.js`、Tasks tab、移动任务栏、群任务、handoff | **高** |
| 设置控制台重设计 | `client/settings-*`、`settings-overview/palette/preferences/tour`、`client/index.js` 大改 | **高** |
| 异步 UI / 移动端 | `agent-terminals`、`reading`、`mobile/src/*`、`test/browser/*` | 中 |
| 能力包与手册技能 | `builtin-packs.js`、`manual-skills.js`、`capabilities.js` 重构（loaded/pendingDrops/frozenCatalogs） | **中高** |
| MCP 服务端 | `mcp-server.js`、`bin/ds-bot-mcp.mjs`、`mcp-page.js` | 中 |
| Web/远程/浏览器/IM | `remote`、`phone-browser`、browser profile cookie import、IM 出站图片 | 低-中 |
| 内存/历史/后台 shell | `turns.js`（BACKGROUND_WAIT_MS、HISTORY_SCAN_PAGES）、store 迁移 | 中 |
| 服务与问题报告 | `deepseek-services.js`、`issue-report.js`、`prepare_ds_bot_issue` | 低 |

## 2. 本地改动的真实边界

本地 51 个文件中，绝大多数是**独立新文件**（task-runs、pstack、测试、dev 脚本、文档）。落在上游共享文件里的改动只有 8 处、每处 1–3 行：

| 共享文件 | 本地改动 | 性质 |
|---|---|---|
| `index.js` | 注册 `taskRuns`、`pstack` 两个模块 | 1 行 + import |
| `capabilities.js` | `ensureCapabilities` 里调用 `preparePstackBot` | 1 行 |
| `channel.js` | `view()` 加 taskRuns 字段；READS 加 `task-run-read/log`；两个 case | 13 行 |
| `constants.js` | `TEAM_TOOLS` 加 5 个 `*_task` 工具名 | 1 行 |
| `roster.js` | 删除 Bot 前 `taskRunStopOwner` | 1 行 |
| `store.js` | 初始 state 加 `taskRuns`/`taskRunRequests` | 1 行 |
| `turns.js` | subagent/start、subagent/end 跳过 task-run 会话 | 2 行 |
| `package.json` | 加 4 个 DSH 依赖 | 4 行 |

其余重叠是**生成物与 UI**：`client.js`（本地 +1050/−484；上游 +12174/−4380）、`i18n.js` 与 6 个 locale（各 +36；上游各 +311）、`details-drawer/team-actions`（各 1–3 行）、`test/mobile.test.js` 等。

结论：**主机侧冲突是“上游大改 + 我们 1–3 行钩子重贴”**；真正的重写集中在**任务系统与客户端 UI**，不是逐行合并。

## 3. 兼容性矩阵

| 上游域 | 与本地关系 | 影响 | 需要的动作 |
|---|---|---|---|
| botTasks / task_* 工具 | 与本地 taskRuns 是两套并行任务系统 | **破坏性语义冲突** | 退役本地 task-runs 工具/UI/端点；执行器降为内部引擎，挂到上游任务生命周期 |
| Tasks UI / 移动任务栏 | 上游新增；本地有 task-runs 面板 | 高 | 删除本地面板与 i18n 键，沿用上游 UI |
| 设置控制台重设计 | 上游重写 `client/index.js`、settings-* | 高（生成物） | `client.js` 重建；本地无设置类改动，直接采用上游 |
| capabilities 重构 | 本地 pstack 钩子插在旧 `ensureCapabilities` | 中高 | 钩子移入新 mounted/loaded 流程；验证 packs/manual skills 与 pstack 源 provider 共存 |
| store 迁移 / retiredParts | 本地仅加两个 state 键 | 中 | 新 state 键保留；检查 worker 会话是否被 archive/retire 误处理 |
| parts openTaskPart | 上游任务 Session 创建点 | 高 | 方案 A 包装该函数；或方案 B 显式 runner |
| turns 后台 shell/handoff | 本地 2 行 subagent 抑制 | 中 | 退役 taskRuns 后重新评估抑制是否仍需要 |
| TEAM_TOOLS 重命名 | remember/forget/recall → bot_*；新增 use_pack 等 | 中 | 本地 deny 集是动态的，自动覆盖；文档/测试引用需核对 |
| channel 端点 | 上游 bot-task-*、mcp-*、agent-chat 等；本地 task-run-* | 中 | 本地端点退役；如保留内部读取，改名避免与上游冲突 |
| MCP 服务端 | 上游新增对外 MCP server | 中 | 只读 MCP 剥离需在“客户端 MCP 工具”和“DS-Bot 作为 MCP 服务端”两种场景分别验证 |
| roster 删除钩子 | 本地 1 行 | 低 | 贴到上游新的删除序列（botTasks forget 等）之后 |
| mobile/web-remote/browser | 上游新增 | 低 | 仅测试夹具重叠；跟随上游 |
| package/build | React、test:browser、新 bin | 中 | 合并依赖；`client.js` 用新构建脚本生成 |
| DSH API | 版本未变 0.2.2-rc.1 | 低 | 仍需在兼容测试台重跑 composeFrom/tools.guard 等契约测试 |

## 4. 22 个重叠文件的冲突画像

| 文件 | 本地 | 上游 | 处理 |
|---|---|---|---|
| `client.js` | +1050/−484 | +12174/−4380 | **禁止手改**，从 `src/client` 重建 |
| `i18n.js` + 6 locales | 各 +36 | 各 +311 | 本地键随 task-runs UI 一起删除；采用上游，冲突自然消失 |
| `client/index.js` | +2 | +91/−27 | 采用上游；移除本地 task-runs 挂载 |
| `details-drawer`/`team-actions` | +3/+1 | +52/−77、+91/−25 | 采用上游 |
| `channel.js` | +13 | +111/−57 | 采用上游后重贴 task-run 端点或直接退役 |
| `constants.js` | +1 | +15/−4 | 采用上游；本地 5 个工具名随 taskRuns 退役删除 |
| `capabilities.js` | +1 | +203/−23 | 采用上游；pstack 钩子移入新流程 |
| `store.js` | +1/−1 | +198/−20 | 采用上游；保留 taskRuns 键仅当仍需要内部状态 |
| `roster.js` | +1 | +24/−1 | 采用上游；重贴删除钩子 |
| `turns.js` | +2/−1 | +269/−25 | 采用上游；抑制逻辑按新执行模型重写或删除 |
| `index.js` | +3/−1 | +10/−1 | 采用上游；模块表改为 `pstack` + 上游 `botTasks`，删除 `taskRuns` |
| `package*.json` | +9 | +42/−6 | 合并；保留 4 个 DSH 依赖，加入 React devDeps |
| 测试（install/local-agents/mobile） | 小改 | 大改 | 采用上游后重跑本地适配测试，不手工合并测试体 |

## 5. 已确认的语义不兼容点

1. **任务工具面**：上游 `task_start/task_send/task_stop/task_list/task_read` 与本地 `start_task/steer_task/cancel_task/list_task_runs/read_task_run` 并存会形成两套入口；必须只保留上游一套。
2. **结算模型**：上游以任务 Session 的 `turn/end` 结算（`bot-tasks.js:1193–1260`）；本地执行器以 `onResult` 结算。若执行器成为内部引擎，需要把 worker 的 turn/end 或结果回调接到上游 `settleTask`。
3. **任务会话来源**：上游 `openTaskPart` 创建的是 Bot 的普通 Session（fork 或 `createSession`），模型/权限来自 Bot；pstack 需要 caller preset 的精确 revision、host+worker、工具 ceiling。两者必须二选一作为“会话真相”。
4. **工具禁用方式**：上游对任务会话只用提示词要求“不要调用 task_*”；本地执行器用硬 ceiling/deny。整合后应保留硬约束，避免提示词依赖。
5. **权限来源**：上游 `applyPermission(bot, sessionId, room)`；pstack 用 caller preset + 任务 permission。需要明确优先级并测试越权拒绝。
6. **MCP 双面性**：本地只读剥离针对 `mcp__*` 客户端工具；上游新增 DS-Bot 自身作为 MCP 服务端，两种方向都要测试。
7. **存档/退休**：上游 `retiredParts`、`archiveSession` 可能把执行器创建的 worker Session 当作 Bot part 处理；需要验证或显式排除。

## 6. 尚需深入分析的问题（P0 未完成项）

1. `botTasks` 的 `task_send`/`task_stop` 是否能在不经过 `deliver` 的情况下驱动外部执行器。
2. 执行器 worker 的 `turn/end` 是否与上游 `taskOwners`/`session/event` 完全兼容（错误、取消、审批）。
3. `capabilities` 新 `loaded`/packs 流程中，pstack source provider 的挂载点与卸载顺序。
4. `retiredParts`/`archiveSession` 对非 Bot part 的 worker Session 的行为。
5. 设置控制台重写后，是否还有 task-runs 面板可挂载的位置（预计没有，需删除）。
6. 上游 `test/browser` 与移动端测试是否影响构建/验收流程。
7. 上游 0.3.10 的 store 迁移是否会在回滚到本地分支时丢字段（双向兼容）。
8. `client.js` 新构建脚本的输入/输出是否仍支持我们的 pstack 设置入口（预计不需要 UI）。

## 7. 分析方案（建议执行顺序）

### P0.1 域级档案（2 天）
每个域一份短档案：文件清单、diff 摘要、受影响的本地钩子、需要新增/修改的测试。
域：任务、capabilities/packs、store/parts、turns/background、client/settings、MCP/local-agents、package/build。

### P0.2 公开 API 复核（1 天）
在 `d104d9ca` 上重跑我们依赖的契约测试：
`agentPresets.composeFrom/composedPreset`、`tools.guard/schemas/restrict`、`sandboxPolicy.resolve`、`approval.overrideOf`、`sessionController.fork`、`workspaceRegistry.archiveSession`。

### P0.3 兼容测试台（2 天）
从 `upstream/main` 建 `feat/upstream-integration`：
1. 跑上游全量测试，确认基线绿；
2. 只重贴 8 处本地钩子（不含 taskRuns/pstack UI），跑测试；
3. 逐个移植本地测试（executor/preset/tool-policy/pstack），记录失败分类（API 变化 / 语义变化 / 测试夹具）。

### P0.4 任务底座决策（1–2 天）
用两个最小原型判定 A（包装 `openTaskPart`/`deliver`）还是 B（显式 `taskRunners` 钩子）：
- `task_start` → 执行器 host+worker → 上游 `settleTask` completed；
- `task_stop` → 执行器 cancel → 上游 stopped。
记录失败点（结算、权限、审批、重启对账）。

### P0.5 迁移与估算（1 天）
产出最终迁移清单：删除/保留/新增文件、测试清单、里程碑、风险与回滚方案。

**分析阶段总估**：7–8 个工程日；不含正式实施。

## 8. 初步实施估算（供决策，不作为承诺）

| 工作 | 估算 |
|---|---|
| 重贴 8 处钩子 + 上游基线测试 | 1 天 |
| 任务底座 A/B 原型 | 2–3 天 |
| 退役 task-runs 工具/端点/UI，接上游 Tasks | 2–4 天 |
| 客户端重建 + 设置/任务 UI 对齐 | 1–2 天 |
| 测试移植与新增集成测试 | 3–5 天 |
| 全量验证（单测/lint/浏览器/隔离 CLI/pstack 12 项） | 2 天 |
| **合计** | **11–17 个工程日** |

## 9. 分析阶段验收

- 每个域有文件级 diff 与本地钩子处置结论；
- 兼容测试台给出“上游测试通过、本地测试失败分类”的真实数字；
- A/B 决策有原型证据，不以猜测定案；
- 迁移清单可逐项执行，且不修改 DSH、不降低 pstack 语义。

## 10. 以 dev 为基线的修订评估

### 额外变化

- 任务系统：`bot-tasks.js` 77 个提交、3,651 行；新增 `TASK_HIDDEN_TEAM_TOOLS` 硬隐藏、`delegate_work/ask_back/answer_work/cancel_work/note_bot` 协作工具；`openTaskPart` 参数增加 `fork/throughSeq/fallbackContext`。
- 客户端：134 个文件变化，设置控制台、异步 UI、移动端继续演进；本地 task-runs 面板没有保留价值。
- 包结构：新增 `plugin-sdk`、`browser-provider`、`code-mode`、`socket-tos-guard` 导出与 `ds-bot-mcp`；仓库迁到 `Fei-Craft`。
- 工具面：`remember/forget/recall` 已在 main 改名 `bot_*`，dev 继续增加 `use_pack/drop_pack` 等；本地动态 deny 集可覆盖，但文档与测试引用需更新。
- 插件 SDK 只支持工具/浏览器 provider，**不能承载任务执行器**；任务整合仍走 `openTaskPart`/`deliver` 接缝或显式 `taskRunners` 钩子。

### 修订估算

| 工作 | main 基线 | dev 基线 |
|---|---|---|
| 重贴 8 处钩子 + 基线测试 | 1 天 | 1–2 天 |
| 任务底座 A/B 原型（3,651 行任务系统） | 2–3 天 | 3–5 天 |
| 退役 task-runs 工具/端点/UI | 2–4 天 | 2–4 天 |
| 客户端重建 + 设置/任务 UI 对齐 | 1–2 天 | 2–3 天 |
| 测试移植与新增集成测试 | 3–5 天 | 4–6 天 |
| 全量验证 | 2 天 | 2–3 天 |
| **合计** | 11–17 天 | **14–23 天** |

### 迁移顺序（以 dev 为基线）

1. 从 `upstream/dev d1f82c90` 建 `feat/upstream-integration`（fork 已同步 `dev`）。
2. 先只贴 8 处宿主钩子，跑上游全量测试，确认基线绿。
3. 移植 `pstack-models.js` 与 `pstack.js`（源绑定/preflight），验证 packs/manual skills 共存。
4. 在 dev 的任务系统上做 A/B 原型（`openTaskPart` 包装 vs `taskRunners` 钩子），用 `task_start`/`task_stop` 两个真实回执判定。
5. 退役 `task-runs` 工具/端点/客户端面板，改接上游 Tasks UI 与 `TASK_HIDDEN_TEAM_TOOLS`。
6. 重建 `client.js`，合并设置控制台/移动端；跑上游浏览器测试与本地 pstack 测试。
7. 全量验证：单测、lint、默认关闭 smoke、隔离 CLI pstack 12 项、真实任务 task_start→settle。
8. 以 fork `dev` 为 base 开 PR；不直接对 main。