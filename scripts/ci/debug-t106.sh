#!/usr/bin/env bash
# Temporary diagnostic for the T-106 stall tests on the GitHub runner: runs the three tests alone (they pass there)
# and then the whole protocol suite (the MAX=6 one fails there), sampling the ancestry and signal masks of every
# "busy" child of the stub, and prints the MAX=6 runs' live.log. Not part of the pipeline.
set -u
OUT=${RUNNER_TEMP:-/tmp}/t106-debug; mkdir -p "$OUT/runs"
echo "== versions"; bash --version | head -1; timeout --version | head -1; ps --version; uname -a; nproc
snap() { # every 'busy N' process: its ancestry (up to 6 levels) with state and signal masks
  local b p i
  for b in $(pgrep -f 'busy [0-9]+$'); do
    p=$b; echo "--- $(date '+%H:%M:%S.%N') busy=$b"
    for i in 1 2 3 4 5 6; do
      [ -r "/proc/$p/status" ] || break
      printf '  %s ppid=%s pgid=%s %s | %s\n' "$p" "$(awk '/^PPid/{print $2}' "/proc/$p/status")" "$(ps -o pgid= -p "$p" | tr -d ' ')" \
        "$(grep -E '^(State|SigBlk|SigIgn|SigCgt)' "/proc/$p/status" | tr -s '\t\n' '  ')" "$(tr '\0' ' ' <"/proc/$p/cmdline" | cut -c1-110)"
      p=$(awk '/^PPid/{print $2}' "/proc/$p/status"); [ "${p:-0}" -gt 1 ] || break
    done
  done
}
(
  while true; do
    for d in /tmp/autopilot-tasks-*/.autopilot/20*; do [ -d "$d" ] && cp -r "$d" "$OUT/runs/" 2>/dev/null; done
    snap >>"$OUT/ps.log"
    sleep 0.5
  done
) & WATCH=$!
export GIT_AUTHOR_NAME=ci GIT_AUTHOR_EMAIL=ci@example.com GIT_COMMITTER_NAME=ci GIT_COMMITTER_EMAIL=ci@example.com
echo "===================================== ISOLATED T-106"
scripts/env.sh node --test --test-reporter=spec --test-name-pattern="T-106" scripts/test/autopilot-tasks.test.mjs 2>&1 | grep -v '^\s*[-﹣]\|skipped\|ℹ'
echo "===================================== FULL SUITE"
rc=0
scripts/env.sh npm run test:sdd 2>&1 | grep -v '^\s*[-﹣]\|skipped\|ℹ' || rc=$?
kill "$WATCH" 2>/dev/null
for d in "$OUT"/runs/*/; do
  grep -q 'up to 6s without the stream moving' "$d/live.log" 2>/dev/null || continue   # only the MAX=6 runs
  echo "=================== run $(basename "$d")"; cat "$d/live.log"; echo "--- stalled: $(cat "$d/stalled" 2>/dev/null)"
  for f in "$d"/*.err; do [ -s "$f" ] && { echo "--- $(basename "$f")"; head -30 "$f"; }; done
done
echo "=================== busy ancestry snapshots"; cat "$OUT/ps.log"
exit "$rc"
