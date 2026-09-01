# Plans

Earlier numbered plans in this folder (Fable 001–026 performance close-out, PR-diff loading, memory) were implemented in product code and removed, including the scoreboard HTML and Aug 30 RSS CSVs.

Leftover STOPs that are not product work live in code comments (local / non-GitHub 64 MB skip in `boundInactivePatchPayloads`; keep-mounted last-3 Activity in `worldViewCache` / `RetainedWorldCodeView`).

## Current plan documents

| Document | Scope | Status |
| --- | --- | --- |
| [grok-github-fast.md](../grok-github-fast.md) | GitHub working-set replica, revised after critique. SQLite social-state cache, GitHub line map, cheap-signal skip, poller-first. Not executor-sliced; Stage 0–2 is a separate product, not a Fable 001–026 leftover. Diagrams: [`grok-github-fast.html`](../grok-github-fast.html). | PLAN — deferred |
