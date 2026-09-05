# perf-instant program artifacts (2026-09-05)

Durable copy of everything the perf-instant program produced, so a new session can
resume without the original scratchpad. Plan: `../perf-instant-plan.md` (status table
is the source of truth for what is done).

| Folder | Contents |
| --- | --- |
| `results/` | Probe outputs per wave: `waveN.jsonl` (all samples), `waveN-<probe>.out` (stdout incl. the `PERF {...}` summary line), `waveN-<probe>-git.log` (git PATH-shim spawn logs). `wave0-startup-baseline.jsonl` is the pre-program baseline. |
| `reports/` | Deep-scan findings (`main-startup-and-session-restore.json`, `folder-open.json`, `renderer-boot.json`, `command-palette.json`, `pr-open.json`) and implementer final reports per wave/track (`waveN-trackX.json`). |
| `progress/` | Per-track durable progress logs written by the implementer agents (section-by-section: files, tests, gates, deviations, needs-owner). |
| `review/fable-review-notes.md` | Reviewer notes per section, carry items (W2-X*, W3-X*), gate results. |
| `react-doctor/` | Baseline diagnostics (81/100, 25 warnings) and the Wave 2 run. |
| `workflows/` | The Workflow scripts that drove each wave, the probe runner (`run-probes.sh`) and the ad hoc palette measure. |
| `wave*-tree.txt` | git tree object ids of the worktree at each wave boundary (`git diff <a> <b>` shows a wave's full change set). |

Re-measure: `bun run update:mac`, then `bash plans/perf-instant-artifacts/workflows/run-probes.sh <label>`
(edit the scratchpad path at the top first) or the individual `bun run perf:*-probe <label>` scripts.
