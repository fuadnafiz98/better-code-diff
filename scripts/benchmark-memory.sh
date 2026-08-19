#!/usr/bin/env bash
set -euo pipefail

sample_label="${1:-manual}"
sample_count="${HORUS_PERF_SAMPLES:-5}"
sample_interval="${HORUS_PERF_INTERVAL:-2}"
root_pid="$(pgrep -x 'Horus' | head -n 1 || true)"

if [[ -z "$root_pid" ]]; then
  echo "Horus is not running." >&2
  exit 1
fi

echo "label,timestamp,pid,ppid,rss_mb,cpu_percent,process"
for ((sample = 1; sample <= sample_count; sample += 1)); do
  timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  ps -axo pid=,ppid=,rss=,%cpu=,comm= | awk -v root="$root_pid" -v label="$sample_label" -v timestamp="$timestamp" '
    $1 == root || $2 == root {
      process = $5
      for (field = 6; field <= NF; field += 1) process = process " " $field
      printf "%s,%s,%d,%d,%.1f,%s,%s\n", label, timestamp, $1, $2, $3 / 1024, $4, process
    }
  '
  if ((sample < sample_count)); then sleep "$sample_interval"; fi
done

echo
echo "macOS physical footprint"
for pid in "$root_pid" $(pgrep -P "$root_pid" || true); do
  footprint -p "$pid" 2>/dev/null | awk '
    /64-bit    Footprint:/ || /phys_footprint:/ || /phys_footprint_peak:/ { print }
  '
done
