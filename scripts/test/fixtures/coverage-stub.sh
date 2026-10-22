#!/bin/sh
# Coverage command double for the DEC-011 tests of scripts/autopilot.sh: $1 = the lcov file, the rest = the acceptance
# tests. Every line of app/**/*.txt is reached, except: with COVERAGE_MISS_ONCE, the first run misses the files the
# implementer double writes (stub-*); with COVERAGE_LEGACY_MISS=N, the first N lines of app/src/legacy.txt.
out=$1
shift
for f in $(git ls-files --cached --others --exclude-standard -- app | grep '\.txt$'); do
  echo "SF:$f"
  n=0
  while IFS= read -r _; do
    n=$((n + 1)) hits=1
    case "$f" in */stub-*) [ -n "$COVERAGE_MISS_ONCE" ] && [ ! -e .autopilot/coverage-missed ] && hits=0 ;; esac
    [ "$f" = app/src/legacy.txt ] && [ "$n" -le "${COVERAGE_LEGACY_MISS:-0}" ] && hits=0
    echo "DA:$n,$hits"
  done <"$f"
  echo end_of_record
done >"$out"
if [ -n "$COVERAGE_MISS_ONCE" ]; then touch .autopilot/coverage-missed; fi
exit 0
