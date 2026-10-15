#!/usr/bin/env bash
# flake-rate.sh FIXTURE [N=20] — fresh-process realization output sizes (mode reuse), prints a histogram.
# Seconds-fast determinism probe for small fixtures (mini-family flakes ~25 % pre-fix).
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="${REPRO_BIN:-$ROOT/build-native/konclude_repro}"
FIX="${1:?fixture.nt}"; N="${2:-20}"; T=$(mktemp -d)
for i in $(seq 1 "$N"); do
  "$BIN" --mode reuse --runs 1 --timeout 120 --out "$T" "$FIX" 2>&1 | grep -E "run 1:" | awk '{print $3}'
done | sort | uniq -c
rm -rf "$T"
