# Plans

Earlier numbered plans in this folder (Fable 001–026 performance
close-out, PR-diff loading, memory, markdown preview chrome) were
implemented in product code and removed.

Leftover STOPs that are not product work live in code comments
(local / non-GitHub 64 MB skip in `boundInactivePatchPayloads`;
keep-mounted last-3 Activity in `worldViewCache` /
`RetainedWorldCodeView`).

## Current plan documents

| Document | Scope | Status |
| --- | --- | --- |
| [perf-instant-plan.md](perf-instant-plan.md) | Instant-perf program: main git path (ignored walk, watcher self-retrigger, open() snapshot), renderer boot, Cmd+P palette, Cmd+H PR open, sessions/cache, hardening. Executor-sliced into waves/tracks with in-file status table. | ACTIVE — Wave 1 in progress |
| [grok-github-fast.md](../grok-github-fast.md) | GitHub working-set replica, revised after critique. SQLite social-state cache, GitHub line map, cheap-signal skip, poller-first. Not executor-sliced. Diagrams: [`grok-github-fast.html`](../grok-github-fast.html). | PLAN — deferred |
