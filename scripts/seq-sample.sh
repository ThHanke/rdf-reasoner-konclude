#!/usr/bin/env bash
# seq-sample.sh — N fresh-process runs of a scripted reset+load+op sequence (konclude_repro --seq).
# usage: scripts/seq-sample.sh "m:empty,c:empty,m:a.nt,..." [N=5]   (env REPRO_TIMEOUT per step, default 120)
# Exit 0: every run completed and repeated identical steps gave identical output; 1 mismatch/failure; 2 hang.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="${REPRO_BIN:-$ROOT/build-native/konclude_repro}"
SEQ="${1:?sequence}"; N="${2:-5}"; T=$(mktemp -d); rc=0
for i in $(seq 1 "$N"); do
  "$BIN" ${REPRO_MODE:+--mode "$REPRO_MODE"} --timeout "${REPRO_TIMEOUT:-120}" --out "$T/o$i" --seq "$SEQ" >"$T/l$i" 2>&1; e=$?
  last=$(grep -E "^RESULT|^HANG" "$T/l$i" | tail -1)
  if [ $e -eq 0 ]; then
    cmp=$(python3 "$ROOT/scripts/seq-compare.py" "$SEQ" "$T/o$i" 2>&1 | tail -3); last="$last / $(echo "$cmp" | tail -1)"
    echo "$cmp" | grep -q "FAIL" && { e=1; echo "$cmp"; }
  fi
  echo "run $i: exit=$e ${last:-no-result}"
  if [ $e -eq 134 ] || grep -q "^HANG" "$T/l$i"; then rc=2; elif [ $e -ne 0 ]; then [ $rc -eq 0 ] && rc=1; grep -E "MISMATCH|failed" "$T/l$i" | head -3; fi
done
rm -rf "$T"; rm -f "$ROOT/core"; exit $rc
