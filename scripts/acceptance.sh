#!/usr/bin/env bash
# Runs one acceptance test file with the runner of its extension (DEC-005), offline, with the tools of .tools/.
#
#   scripts/acceptance.sh <file>
#
# *.py → pytest · *.test.mjs → node --test · *.tftest.hcl → terraform test, from the root infra/main unless the file's
# first line is "# module: infra/<dir>" (the file is copied into the root: terraform test rejects outside dirs). Exit 2 on a usage error or an unsupported extension.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
[ -n "${COMPRAS_ENV:-}" ] || exec "$ROOT/scripts/env.sh" "$ROOT/scripts/acceptance.sh" "$@"
[ $# -eq 1 ] || { echo "usage: scripts/acceptance.sh <file>" >&2; exit 2; }
FILE=$(realpath "$1" 2>/dev/null) || { echo "acceptance: $1 does not exist" >&2; exit 2; }
[ -f "$FILE" ] || { echo "acceptance: $1 does not exist" >&2; exit 2; }
cd "$ROOT"

case "$FILE" in
  *.py) exec uv run --frozen pytest "$FILE" ;;
  *.test.mjs) exec node --test "$FILE" ;;
  *.tftest.hcl)
    module=$(head -1 "$FILE" | sed -n 's/^# module: *\(infra\/[A-Za-z0-9_\/-]*\) *$/\1/p')
    tfroot="$ROOT/${module:-infra/main}"
    [ -d "$tfroot" ] || { echo "acceptance: terraform root ${module:-infra/main} does not exist" >&2; exit 2; }
    # terraform test only accepts a test directory inside the root (S-10 does not hold): copy the file into a
    # throwaway directory of the root and remove it on exit.
    tmpdir=".acceptance-$$"
    mkdir "$tfroot/$tmpdir"
    trap 'rm -rf "$tfroot/$tmpdir"' EXIT
    cp "$FILE" "$tfroot/$tmpdir/"
    terraform -chdir="$tfroot" init -backend=false -input=false -plugin-dir="$TF_PLUGIN_DIR" -test-directory="$tmpdir" >/dev/null
    terraform -chdir="$tfroot" test -no-color -test-directory="$tmpdir"
    ;;
  *) echo "acceptance: unsupported extension: $1" >&2; exit 2 ;;
esac
