# Horus performance harness

Three CDP probes that drive the **installed** app (`~/Applications/Horus.app`,
or whatever `HORUS_APP` points at) and one PATH shim that counts git/gh spawns.
They measure the shipped build, so run `bun run update:mac` first — building the
repo alone changes nothing they can see.

Every probe quits Horus before it starts and again when it finishes, including
on Ctrl+C, so none of them leaves a window behind.

```bash
bun run perf:startup-probe before      # cold launch + first Cmd+P
bun run perf:open-folder-probe before  # Cmd+O -> Enter -> usable tree
bun run perf:pr-open-probe before      # horus://review deep link, warm and cold
```

The argument is a label. Each run appends one JSON object to
`scripts/perf/results/<label>.jsonl` (gitignored) as well as printing to stdout,
so `before` and `after` runs stay side by side. Every probe also prints one
`PERF {…}` line last, carrying the median, min and max of its headline metrics —
`grep '^PERF' ` two runs and the comparison is a two-line diff.

## Environment

| Variable | Default | Applies to |
| --- | --- | --- |
| `HORUS_APP` | `~/Applications/Horus.app` | all |
| `HORUS_PERF_RESULTS_DIR` | `scripts/perf/results` | all |
| `SAMPLES` | `3` | startup |
| `TIMEOUT_MS` | `20000` | startup |
| `QUERY` | `app` | startup (what to type into the palette) |
| `FOLDERS` | `imux,materialsx-core-3,imux,better-code-diff` | open-folder |
| `OPEN_TIMEOUT_MS` | `20000` | open-folder (whole open, not per condition) |
| `PRS` | *(required)* | pr-open |
| `PR_TIMEOUT_MS` | `20000` | pr-open (whole open, not per condition) |

## What each probe reports

**startup-probe** — `firstPaintMs` / `fcpMs` measured from the `open` call, the
renderer marks (`reactCommitted`, `snapshotReady`, `explorerCommitted`,
`viewerCommitted`), main's `mainStartup` block (`windowShown`,
`restoreSettled`), every long task over 50 ms, and a palette block:
`openMs`, `paletteOpenAppMs`, `emptyRows`, `fileResultsMs`, `contentResultsMs`
and `workspaceRenders` (the re-render delta across the typed query; `null` until
the renderer exposes `window.__horusMetrics`). Read Cmd+P from
`paletteOpenAppMs`: it is the app's own `horus:palette-open-to-focus` measure,
where `openMs` also carries the probe's four input round trips and a poll.
`emptyRows` is read once the count stops moving (the palette paints 12 rows and
fills in the rest a frame later), so it is the list the user actually sees.

**open-folder-probe** — per folder: `pickerOpenMs`, `pickerRowsMs`,
`headingMs`, `treeRowsMs`, `branchMs`, `publishedMs` and `liveSnapshotMs`. The
last one is the number that matters: the first moment the folder is genuinely
usable rather than a path skeleton. It is the earlier of two sightings, reported
as `liveSource`: `change` for a publish carrying a branch (or `stage: 'live'`),
and `dom` for the branch appearing in the explorer heading. Both are needed —
an open whose refresh wins the 150 ms race answers over IPC and publishes
nothing, and `window.repository` is frozen by `contextBridge`, so the probe
cannot intercept the IPC result itself. A skeleton snapshot has no branch and
renders as "Detached HEAD", which is what makes the heading a reliable marker.

**pr-open-probe** — per pull request, warm app and cold app:
`tabOrLoadingMs`, `reviewSurfaceMs`, `metadataMs`, `firstPageMs`, `doneMs`,
`firstCodeViewMs`, and `progressKinds` (the first sighting and the count of
every progress kind the renderer saw, including ones this probe predates).
`timedOut` says whether the review finished inside the deadline; the moments
that did happen are still timed when it did not.

Both open probes poll one expression against a single deadline, so a condition
that never arrives leaves its own field null instead of delaying every
measurement behind it.

## Counting git and gh spawns

`git-shim/` holds a `git` and a `gh` that log every spawn and then exec the real
binary. Put it first on `PATH` for the process that launches Horus, and point
`HORUS_GIT_SHIM_LOG` at a file:

```bash
HORUS_GIT_SHIM_LOG=/tmp/horus-git.log \
PATH="$PWD/scripts/perf/git-shim:$PATH" \
  bun run perf:open-folder-probe after
```

The app must inherit that environment, so launch it from the same shell (the
probes use `open -na`, which does inherit it). Each line is tab separated:

```
started_epoch_seconds  elapsed_ms  exit_status  tool  argv
```

Useful reductions:

```bash
wc -l < /tmp/horus-git.log                                    # total spawns
cut -f5 /tmp/horus-git.log | sort | uniq -c | sort -rn | head # by command
awk -F'\t' '{sum += $2} END {print sum " ms"}' /tmp/horus-git.log
awk -F'\t' '$4 == "gh"' /tmp/horus-git.log                    # gh only
```

Without `HORUS_GIT_SHIM_LOG` the shim is a transparent pass-through, so leaving
it on `PATH` is harmless. It adds one `zsh -f` startup per spawn (a few
milliseconds), which is why spawn *counts* are the number to trust from it and
wall times are indicative.

## Bundle budget

`bun run check:entry` is the static counterpart: it sums the transitive
pre-mount closure in `out/renderer` (entry, boot and the workspace/viewer
chunks, following static imports only) and fails above `MAX_PREMOUNT_BYTES`. It
prints the fifteen largest chunks in that closure, which is the fastest way to
see what a regression pulled back onto the boot path.
