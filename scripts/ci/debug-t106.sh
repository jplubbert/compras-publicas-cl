#!/usr/bin/env bash
# Temporary diagnostic for the T-106 stall tests on the GitHub runner. Not part of the pipeline.
# Findings so far: the max cut fires, the stub dies, but its "busy" child survives and holds the pipe; the sampled
# `timeout -s INT` process shows no caught signals (SigCgt only SIGCHLD), unlike GNU timeout 9.4 elsewhere.
set -u
OUT=${RUNNER_TEMP:-/tmp}/t106-debug; mkdir -p "$OUT/runs"
sudo apt-get install -y -qq strace >/dev/null 2>&1 && echo "strace installed" || echo "no strace"
echo "== which timeout, in the runner PATH and under scripts/env.sh"
for t in "command -v timeout" "timeout --version | head -1"; do echo "runner: $(bash -c "$t")"; echo "env.sh: $(scripts/env.sh bash -c "$t")"; done
scripts/env.sh bash -c 'echo "PATH under env.sh: $PATH"; f=$(command -v timeout); ls -la "$f"; readlink -f "$f"; sha256sum "$(readlink -f "$f")"; dpkg -S "$(readlink -f "$f")" 2>&1 | head -1'
echo "== signal masks of a plain GNU timeout, runner PATH vs env.sh"
timeout 20 sleep 20 & p=$!; sleep 0.3; echo "runner: $(grep -E '^(SigIgn|SigCgt)' /proc/$p/status | tr -s '\t\n' '  ')"; kill $p
scripts/env.sh bash -c 'timeout 20 sleep 20 & p=$!; sleep 0.3; echo "env.sh: $(grep -E "^(SigIgn|SigCgt)" /proc/$p/status | tr -s "\t\n" "  ")"; kill $p'
echo "== kernel / ptrace"; uname -r; cat /proc/sys/kernel/yama/ptrace_scope 2>/dev/null
snap() { # every 'busy N' process: its ancestry with masks; attach strace (signals only) once per busy pid
  local b p i
  for b in $(pgrep -f 'busy [0-9]+$'); do
    p=$b; echo "--- $(date '+%H:%M:%S.%N') busy=$b"
    local chain=()
    for i in 1 2 3 4 5 6; do
      [ -r "/proc/$p/status" ] || break
      chain+=("$p")
      printf '  %s ppid=%s pgid=%s %s | %s\n' "$p" "$(awk '/^PPid/{print $2}' "/proc/$p/status")" "$(ps -o pgid= -p "$p" | tr -d ' ')" \
        "$(grep -E '^(State|SigIgn|SigCgt)' "/proc/$p/status" | tr -s '\t\n' '  ')" "$(tr '\0' ' ' <"/proc/$p/cmdline" | cut -c1-90)"
      p=$(awk '/^PPid/{print $2}' "/proc/$p/status"); [ "${p:-0}" -gt 1 ] || break
    done
    if [ ! -e "$OUT/straced-$b" ] && [ "${#chain[@]}" -ge 3 ] && command -v strace >/dev/null; then
      : >"$OUT/straced-$b"
      sudo strace -f -tt -e trace=signal,kill,tgkill,exit_group,wait4,execve -p "${chain[0]}" -p "${chain[1]}" -p "${chain[2]}" -o "$OUT/strace-$b.log" >/dev/null 2>&1 &
      echo "  strace attached to ${chain[0]} ${chain[1]} ${chain[2]}"
    fi
  done
}
(
  while true; do
    for d in /tmp/autopilot-tasks-*/.autopilot/20*; do [ -d "$d" ] && cp -r "$d" "$OUT/runs/" 2>/dev/null; done
    snap >>"$OUT/ps.log"
    sleep 0.4
  done
) & WATCH=$!
export GIT_AUTHOR_NAME=ci GIT_AUTHOR_EMAIL=ci@example.com GIT_COMMITTER_NAME=ci GIT_COMMITTER_EMAIL=ci@example.com
rc=0
scripts/env.sh node --test --test-reporter=spec --test-name-pattern="T-106" scripts/test/autopilot-tasks.test.mjs 2>&1 | grep -v '^\s*[-﹣]\|skipped\|ℹ' || rc=$?
sleep 2; kill "$WATCH" 2>/dev/null; sudo pkill strace 2>/dev/null; sleep 1
for d in "$OUT"/runs/*/; do
  grep -q 'up to 6s without the stream moving' "$d/live.log" 2>/dev/null || continue
  echo "=================== run $(basename "$d")"; cat "$d/live.log"; echo "--- stalled: $(cat "$d/stalled" 2>/dev/null)"
done
echo "=================== busy ancestry snapshots"; cat "$OUT/ps.log"
for f in "$OUT"/strace-*.log; do [ -e "$f" ] && { echo "=================== $(basename "$f")"; cat "$f"; }; done
exit "$rc"
