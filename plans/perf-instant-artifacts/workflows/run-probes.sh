#!/bin/bash
# Usage: run-probes.sh <label>   — runs the three probes against ~/Applications/Horus.app with the git shim on PATH.
set -u
LABEL=${1:-run}
S=/private/tmp/claude-501/-Users-fuadnafiz98-Developer-vibes-better-code-diff/2a975ab1-5c84-43b9-bac1-d2fcb5d3d267/scratchpad
REPO=/Users/fuadnafiz98/Developer/vibes/better-code-diff
cd "$REPO"
export HORUS_PERF_RESULTS_DIR=$S/results
export PATH="$REPO/scripts/perf/git-shim:$PATH"
pkill -x Horus 2>/dev/null; sleep 1
RUN_startup=0; RUN_open_folder=0; RUN_pr_open=0
for probe in startup open-folder pr-open pr-open; do
  KEY=${probe//-/_}; eval "RUN=\$((RUN_$KEY + 1))"; eval "RUN_$KEY=$RUN"; SUFFIX=""; [ $RUN -gt 1 ] && SUFFIX="-run$RUN"
  LOG=$S/results/$LABEL-$probe$SUFFIX-git.log; rm -f "$LOG"
  echo "=== $probe ($LABEL) $(date +%H:%M:%S) ==="
  if [ $probe = pr-open ]; then
    export PRS='https://github.com/fehrmann-materialsx/materialsx-core/pull/717,https://github.com/fehrmann-materialsx/materialsx-core/pull/715'
  fi
  HORUS_GIT_SHIM_LOG=$LOG bun scripts/perf/$probe-probe.mjs "$LABEL" > "$S/results/$LABEL-$probe$SUFFIX.out" 2> "$S/results/$LABEL-$probe$SUFFIX.err"
  echo "exit=$? spawns=$(wc -l < "$LOG" 2>/dev/null | tr -d ' ') gh=$(awk -F'\t' '$4=="gh"' "$LOG" 2>/dev/null | wc -l | tr -d ' ')"
  grep "^PERF" "$S/results/$LABEL-$probe$SUFFIX.out" | cut -c1-1500
  [ -s "$S/results/$LABEL-$probe$SUFFIX.err" ] && { echo "--- stderr ---"; tail -5 "$S/results/$LABEL-$probe$SUFFIX.err"; }
  pkill -x Horus 2>/dev/null; sleep 2
done
