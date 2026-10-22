#!/usr/bin/env bash
# `scripts/autopilot.sh` double for the tests of scripts/autopilot-dispatch.sh. Its behaviour comes from files in
# $STUB_STATE/<repo>/ (all optional): check_rc (0), check_msg, run_rc (0), sleep (0), no_result (exists = no
# result.json), intervention (exists = "intervention": true), status (result.json's status, ok by default). It records its arguments in $STUB_STATE/<repo>/args and
# "start|end <repo> <epoch ns>" lines in $STUB_STATE/timeline, and what it sees of AUTOPILOT_SECRETS and TYPESAFE_API_KEY
# in $STUB_STATE/<repo>/env. --check also reports a dirty tree, like the real one.
root=$(cd "$(dirname "$0")/.." && pwd)
name=$(basename "$root")
st="$STUB_STATE/$name"
mkdir -p "$st"
cfg() { if [ -f "$st/$1" ]; then cat "$st/$1"; else printf '%s' "$2"; fi; }
printf '%s\n' "$*" >>"$st/args"
printf 'AUTOPILOT_SECRETS=%s TYPESAFE_API_KEY=%s\n' "${AUTOPILOT_SECRETS:-}" "${TYPESAFE_API_KEY:-}" >>"$st/env"
case "${1:-}" in
  --check)
    if [ -n "$(git -C "$root" status --porcelain 2>/dev/null)" ]; then
      echo "autopilot --check: cannot run: dirty working tree"; exit 2
    fi
    echo "autopilot --check: $(cfg check_msg 'work: task T-01 is eligible')"
    exit "$(cfg check_rc 0)"
    ;;
esac
echo "start $name $(date +%s%N)" >>"$STUB_STATE/timeline"
echo "stub run of $name"
sleep "$(cfg sleep 0)"
echo "end $name $(date +%s%N)" >>"$STUB_STATE/timeline"
rc=$(cfg run_rc 0)
if [ ! -f "$st/no_result" ]; then
  out="$st/result.json"
  intervention=false
  [ -f "$st/intervention" ] && intervention=true
  printf '{"exit_code": %s, "status": "%s", "stop_reason": "no eligible tasks left", "done": ["T-01"], "intervention": %s, "next_action": "decide accepted"}\n' \
    "$rc" "$(cfg status ok)" "$intervention" >"$out"
  echo "result: $out"
fi
exit "$rc"
