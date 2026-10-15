#!/usr/bin/env bash
# wasm-sample.sh — N FRESH-PROCESS WASM materialize samples vs. an oracle fingerprint.
#
# usage: scripts/wasm-sample.sh FIXTURE.nt ORACLE.json [N=5]
# env:   WASM_TIMEOUT (default 600 s per sample)
# Exit: 0 all equal, 1 any mismatch, 2 any hang/failed run.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURE="${1:?fixture.nt}"; ORACLE="${2:?oracle.json}"; N="${3:-5}"
TIMEOUT="${WASM_TIMEOUT:-600}"
WORK="$(mktemp -d /tmp/wasm-sample-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
pass=0; mism=0; hang=0
for i in $(seq 1 "$N"); do
  out="$WORK/s$i.nt"; start=$SECONDS
  if ! timeout "$TIMEOUT" node "$ROOT/dist/cli.js" -i "$FIXTURE" -m materialize -o "$out" >"$WORK/s$i.log" 2>&1; then
    echo "sample $i: HANG/FAILED ($(tail -1 "$WORK/s$i.log"))"; hang=$((hang+1)); continue
  fi
  # CLI emits inferred triples only; the oracle fingerprint covers asserted + inferred
  cat "$FIXTURE" "$out" >"$out.all"
  res=$(python3 "$ROOT/scripts/compare-fingerprint.py" "$FIXTURE" "$out.all" "$ORACLE" --json)
  eq=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["equal"])' "$res")
  if [ "$eq" = "True" ]; then pass=$((pass+1)); echo "sample $i: EQUAL ($((SECONDS-start)) s)"
  else mism=$((mism+1)); echo "sample $i: MISMATCH ($((SECONDS-start)) s) $res"; fi
done
echo "RESULT: $pass/$N equal, $mism mismatch, $hang hang/failed"
[ "$hang" -gt 0 ] && exit 2
[ "$mism" -gt 0 ] && exit 1
exit 0
