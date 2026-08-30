# Plans

Earlier numbered plans in this folder (performance, PR-diff loading, memory) were implemented and removed.

## Current plan documents

| Document | Scope | Status |
| --- | --- | --- |
| [fable-perf-plan.md](./fable-perf-plan.md) | 2026-08-30 Fable audit: 25 executor-ready plans (002–026, incl. React Compiler adoption) across renderer perf, main-process perf, bundle/startup and UI consistency, with a React 19.2/Compiler review, reconciliation against `grok-perf-plan.md`, a ranked findings table, execution order and a "considered and rejected" list. Executors update the status table inside that file. | TODO |
| [grok-github-fast.md](../grok-github-fast.md) | Local GitHub replica: research (PR Cockpit, Code Storage, Cursor Continuity, GitHub DGit/API limits) and the architecture for a SQLite + local-git read model, webhook invalidation, mutation queue, and agent listen. Research-only; not executor-sliced. | PLAN |

## Animation fixes

| Plan | Title | Severity | Status |
| --- | --- | --- | --- |
| [001](./001-stop-file-tree-selection-flash.md) | Stop the file-tree selection flash | HIGH | DONE |
