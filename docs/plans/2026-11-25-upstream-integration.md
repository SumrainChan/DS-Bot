# Upstream integration project (2026-11-25)

Direction: **upstream is the base; pstack is fitted onto it.** Do not keep our task system as a parallel second system. The target is one upstream-shaped task model with pstack capability layered on top.

## Why this exists

- Our branch `feat/pstack-harness` = `bf46e80d`, based on `upstream/dev 218a6bd0` (2026-11-16).
- Upstream `main` = `d104d9ca` (2026-11-22), 920 commits newer. It ships `botTasks` (dedicated Session per task, lifecycle, reports, approvals, hooks) and new modules (`issueReport`, `deepseekServices`, `mcpServer`, `manualSkills`).
- Our adapter adds isolated execution hosts, exact caller preset composition, tool-name ceilings and the pstack source binding. Those capabilities are not in upstream `botTasks`.
- Fork `main` is synced to `d104d9ca`; `feat/pstack-harness` is pushed to the fork but cannot merge as-is.

## Target shape (directional, not yet designed)

```
upstream botTasks (task lifecycle, Session, reports, approvals)
        鈹?        鈹斺攢鈹€ pstack execution capability (preset inheritance, tool ceiling,
            source scope, read-only MCP stripping, terminal reclaim)
```

Open questions to answer in P0 before writing code:

1. Can pstack execution live as an extension of upstream `botTasks` (hook/strategy) without forking its lifecycle?
2. If not, can upstream `botTasks` delegate a task to a pstack executor while keeping its Session/report/approval model?
3. Which of our current `start_task` tools remain, and which become internal calls under upstream's `task_*` surface?
4. What is the minimal pstack-specific surface: source binding, preflight, preset composition, admission ceiling?

Do not start implementation until these are answered and the owner approves the shape.

## Milestones

### P0 路 Analysis only
- Read upstream `bot-tasks.js`, `tasks.js`, `turns.js`, `capabilities.js`, `roster.js`, `constants.js` and the task UI.
- Map upstream task lifecycle, Session creation, hooks, delivery and limits against pstack needs.
- Produce a one-page decision: extend `botTasks` vs delegate vs new layer.
- Exit: written decision + affected files list; no code changes.

### P1 路 Port pstack model/settings layer
- `pstack-models.js` and tests on the new base, independent of task execution.

### P2 路 Port pstack binding
- `pstack.js` reconciled with upstream capabilities/roster; preflight and source scope working.

### P3 路 Execution on the upstream task substrate
- Implement the P0 decision. Remove or demote our parallel `taskRuns` surface accordingly.
- Keep read-only MCP stripping, terminal reclaim, preset retention and tool ceilings as pstack requirements, not a second task UI.

### P4 路 UI
- Fit pstack status/details into upstream's task UI; regenerate `client.js` from source.

### P5 路 Verification
- Full suite, lint, generated-client check, default-off smoke, isolated CLI pstack acceptance, one real task through the upstream-shaped path.

### P6 路 PR
- One reviewable PR against `main`; no merge without separate authorization.

## Status

- Fork sync and branch push complete. P0 analysis produced in `2026-11-27-upstream-integration-analysis.md`; no code changed. Recommendation: prototype the zero-patch seam (A), fall back to a small explicit `taskRunners` hook (B) if the seam proves unreliable.
