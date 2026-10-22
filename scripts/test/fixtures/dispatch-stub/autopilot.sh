#!/usr/bin/env bash
# `scripts/autopilot.sh` double for the tests of scripts/autopilot-dispatch.sh. Its behaviour comes from files in
# $STUB_STATE/<repo>/ (all optional): check_rc (0), check_msg, run_rc (0), sleep (0), no_result (exists = no
# result.json), intervention (exists = "intervention": true), status (result.json's status, ok by default), done (the
# task in "done", T-01), stop_reason ("no eligible tasks left"), month and cap (month_tokens.counted and
# monthly_budget_tokens; none by default). A file with several lines gives line N to the Nth --check (check_rc,
# check_msg) or the Nth run (the rest), and its last line after that (T-95). Each run reports 100 counted tokens and
# 1000 of cache read. It records its arguments in $STUB_STATE/<repo>/args and
# "start|end <repo> <epoch ns>" lines in $STUB_STATE/timeline, and what it sees of AUTOPILOT_SECRETS and TYPESAFE_API_KEY
# in $STUB_STATE/<repo>/env. --check also reports a dirty tree, like the real one.
root=$(cd "$(dirname "$0")/.." && pwd)
name=$(basename "$root")
st="$STUB_STATE/$name"
mkdir -p "$st"
printf '%s\n' "$*" >>"$st/args"
printf 'AUTOPILOT_SECRETS=%s TYPESAFE_API_KEY=%s\n' "${AUTOPILOT_SECRETS:-}" "${TYPESAFE_API_KEY:-}" >>"$st/env"
if [ "${1:-}" = --check ]; then n=$(grep -cx -e '--check' "$st/args"); else n=$(grep -cvx -e '--check' "$st/args"); fi
cfg() { # $1 = file, $2 = default: its line n, or its last line
  if [ ! -f "$st/$1" ]; then printf '%s' "$2"; return; fi
  local l
  l=$(sed -n "${n}p" "$st/$1")
  [ -n "$l" ] || l=$(sed -n '$p' "$st/$1")
  printf '%s' "$l"
}
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
  month=null cap=null
  [ -f "$st/month" ] && month="{\"counted\": $(cfg month 0)}"
  [ -f "$st/cap" ] && cap=$(cfg cap 0)
  printf '{"exit_code": %s, "status": "%s", "stop_reason": "%s", "done": ["%s"], "intervention": %s, "next_action": "decide accepted", "tokens": {"counted": 100, "cache_read": 1000}, "month_tokens": %s, "monthly_budget_tokens": %s}\n' \
    "$rc" "$(cfg status ok)" "$(cfg stop_reason 'no eligible tasks left')" "$(cfg done T-01)" "$intervention" "$month" "$cap" >"$out"
  echo "result: $out"
fi
exit "$rc"
