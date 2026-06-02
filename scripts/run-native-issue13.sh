#!/usr/bin/env bash
# Runs native Konclude on all six issue #13 fixtures and prints verdicts as JSON.
# Verdicts are parsed from stdout (exit code is always 0 regardless of verdict).
# Usage: bash scripts/run-native-issue13.sh > tests/fixtures/issue13-native-verdicts.json
# Requires: vendor/konclude/Binaries/Konclude (run scripts/acquire-native-konclude.sh first)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BINARY="${REPO_ROOT}/vendor/konclude/Binaries/Konclude"
FIXTURE_DIR="${REPO_ROOT}/tests/fixtures/issue13"

if [[ ! -x "${BINARY}" ]]; then
  echo "ERROR: Native binary not found at ${BINARY}" >&2
  echo "Run: bash scripts/acquire-native-konclude.sh" >&2
  exit 1
fi

declare -a CASES=(
  "1:case1-disjoint-direct.owl:disjointWith (direct)"
  "2:case2-disjoint-by-inference.owl:disjointWith (via inference)"
  "3:case3-asymmetric-property.owl:AsymmetricProperty violation"
  "4:case4-irreflexive-property.owl:IrreflexiveProperty violation"
  "5:case5-max-qualified-cardinality.owl:maxQualifiedCardinality + differentFrom"
  "6:case6-allvaluesfrom-disjoint.owl:allValuesFrom + disjointWith"
  "7:case7-reflexive-property.owl:ReflexiveProperty + ObjectComplementOf(HasSelf)"
  "8:case8-inverse-functional-property.owl:InverseFunctionalProperty + DifferentIndividuals"
  "9:case9-all-disjoint-classes.owl:AllDisjointClasses (3-way) + double membership"
  "10:case10-all-disjoint-properties.owl:DisjointObjectProperties + EquivalentObjectProperties"
  "11:case11-disjoint-union.owl:DisjointUnion + double membership"
  "12:case12-negative-property-assertion.owl:NegativeObjectPropertyAssertion contradiction"
)

echo "["
for i in "${!CASES[@]}"; do
  IFS=':' read -r num filename name <<< "${CASES[$i]}"
  fixture="${FIXTURE_DIR}/${filename}"

  output=$(timeout 30 "${BINARY}" consistency -i "${fixture}" 2>&1)
  tcode=$?

  if [[ $tcode -eq 124 ]]; then
    verdict="timeout"
    exitCode=124
  elif echo "${output}" | grep -q "is inconsistent"; then
    verdict="inconsistent"
    exitCode=0
  elif echo "${output}" | grep -q "is consistent"; then
    verdict="consistent"
    exitCode=0
  else
    verdict="error"
    exitCode=$tcode
  fi

  comma=","
  [[ $i -eq $((${#CASES[@]} - 1)) ]] && comma=""

  printf '  { "case": %s, "name": "%s", "fixture": "%s", "verdict": "%s", "exitCode": %s }%s\n' \
    "${num}" "${name}" "${filename}" "${verdict}" "${exitCode}" "${comma}"
done
echo "]"
