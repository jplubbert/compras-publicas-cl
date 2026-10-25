#!/usr/bin/env bash
# Temporary diagnostic for the T-106 stall tests on the GitHub runner: runs only those tests while copying every
# orchestrator run directory and taking process snapshots, then prints everything. Not part of the pipeline.
set -u
OUT=${RUNNER_TEMP:-/tmp}/t106-debug; mkdir -p "$OUT/runs"
echo "== versions"; bash --version | head -1; timeout --version | head -1; ps --version; uname -a; nproc
echo "== env (sorted, values trimmed)"; env | sort | cut -c1-120
(
  while true; do
    for d in /tmp/autopilot-tasks-*/.autopilot/20*; do [ -d "$d" ] && cp -r "$d" "$OUT/runs/" 2>/dev/null; done
    { echo "--- $(date '+%H:%M:%S.%N')"; ps -eo pid=,ppid=,pgid=,sid=,stat=,etimes=,time=,args= | grep -E 'timeout -s INT|autopilot-stubs|busy|sleep [0-9]|autopilot-stream|tee -a|scripts/autopilot.sh' | grep -v grep; } >>"$OUT/ps.log"
    sleep 0.5
  done
) & WATCH=$!
rc=0
scripts/env.sh node --test --test-reporter=spec --test-name-pattern="T-106" scripts/test/autopilot-tasks.test.mjs 2>&1 | grep -v '^\s*[-﹣]\|skipped\|ℹ' || rc=$?
kill "$WATCH" 2>/dev/null
for d in "$OUT"/runs/*/; do
  echo "=================== run $(basename "$d")"; ls -la "$d"
  for f in live.log stalled heartbeat; do [ -e "$d/$f" ] && { echo "--- $f"; cat "$d/$f"; }; done
  for f in "$d"/*.err "$d"/*-audit.txt; do [ -e "$f" ] && { echo "--- $(basename "$f")"; head -50 "$f"; }; done
done
echo "=================== ps snapshots"; cat "$OUT/ps.log"
exit "$rc"
