#!/usr/bin/env bash
# bisect-variants.sh — run repro-sample.sh once per env-variant (serial; CPU contention
# would change race rates). Variants are native-only REPRO_* env overrides read in
# src/KoncludeReasoner.cpp (reproEnvInt) — no rebuild needed per variant.
#
# usage: scripts/bisect-variants.sh N "label|ENV=V ENV=V" ["label2|..." ...]
# Appends a row per variant to $BISECT_OUT (default /tmp/bisect-results.txt).
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
N="${1:?N}"; shift
OUT="${BISECT_OUT:-/tmp/bisect-results.txt}"
FIX="${BISECT_FIXTURE:-$ROOT/tests/fixtures/roberts-family.nt}"
ORA="${BISECT_ORACLE:-$ROOT/tests/fixtures/oracle/roberts-family.oracle.json}"
for spec in "$@"; do
  label="${spec%%|*}"; envs="${spec#*|}"
  log="$(env $envs bash "$ROOT/scripts/repro-sample.sh" "$FIX" "$ORA" "$N" 2>&1)"
  res="$(echo "$log" | grep '^RESULT')"
  detail="$(echo "$log" | grep '^sample' | sed 's/sample [0-9]*: //' | tr '\n' ';')"
  printf '%s | %s | %s | %s\n' "$label" "$envs" "$res" "$detail" | tee -a "$OUT"
done
