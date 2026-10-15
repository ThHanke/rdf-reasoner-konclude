#!/usr/bin/env bash
# repro-sample.sh — N FRESH-PROCESS realization samples vs. an oracle fingerprint.
#
# usage: scripts/repro-sample.sh FIXTURE.nt ORACLE.json [N=5] [--keep]
# env:   REPRO_BIN (default build-native/konclude_repro), REPRO_TIMEOUT (default 300),
#        REPRO_EXTRA (extra konclude_repro flags, e.g. "--threads 4")
# Each sample is a new process (realization is cached after the first call, so
# repeated calls in one process are NOT independent samples).
# Exit: 0 all samples equal oracle, 1 any mismatch, 2 any hang/failed run.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURE="${1:?fixture.nt}"; ORACLE="${2:?oracle.json}"; N="${3:-5}"; KEEP="${4:-}"
BIN="${REPRO_BIN:-$ROOT/build-native/konclude_repro}"
TIMEOUT="${REPRO_TIMEOUT:-300}"
WORK="$(mktemp -d /tmp/repro-sample-XXXXXX)"
trap '[ "$KEEP" = "--keep" ] || rm -rf "$WORK"' EXIT

echo "baseline: $(bash "$ROOT/scripts/baseline-info.sh")"
pass=0; mism=0; hang=0
for i in $(seq 1 "$N"); do
  out="$WORK/s$i"
  # shellcheck disable=SC2086
  if ! "$BIN" --mode reuse --runs 1 --timeout "$TIMEOUT" --out "$out" ${REPRO_EXTRA:-} "$FIXTURE" >"$WORK/s$i.log" 2>&1; then
    if grep -q "^HANG" "$WORK/s$i.log"; then echo "sample $i: HANG"; hang=$((hang+1)); else echo "sample $i: FAILED ($(tail -1 "$WORK/s$i.log"))"; hang=$((hang+1)); fi
    rm -f "$ROOT/core"; continue
  fi
  triples=$(wc -l < "$out/run1.nt")
  res=$(python3 "$ROOT/scripts/compare-fingerprint.py" "$FIXTURE" "$out/run1.nt" "$ORACLE" --json)
  eq=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["equal"])' "$res")
  miss=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["net_missing"])' "$res")
  if [ "$eq" = "True" ]; then pass=$((pass+1)); echo "sample $i: EQUAL  triples=$triples"; else mism=$((mism+1)); echo "sample $i: MISMATCH triples=$triples net_missing=$miss"; fi
  [ "$eq" = "True" ] && rm -rf "$out"
done
echo "RESULT: $pass/$N equal, $mism mismatch, $hang hang/failed"
[ "$hang" -gt 0 ] && exit 2
[ "$mism" -gt 0 ] && exit 1
exit 0
