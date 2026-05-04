#!/usr/bin/env bash
# One-time conversion of Konclude vendor test ontologies (OWL 2 XML) to NTriples.
# Requires Docker. Uses obolibrary/robot image — no local Java needed.
# Output committed to tests/fixtures/ and used by integration tests.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TESTS_DIR="$REPO_ROOT/vendor/konclude/Tests"
FIXTURES_DIR="$REPO_ROOT/tests/fixtures"
ROBOT_IMAGE="obolibrary/robot:v1.9.6"

mkdir -p "$FIXTURES_DIR"

run_robot() {
  local input="$1"
  local output="$2"
  local base="$(basename "$output" .nt)"
  local tmp_ttl="$FIXTURES_DIR/${base}.ttl"
  echo "Converting $(basename "$input") → $(basename "$output") ..."
  # Step 1: OWL 2 XML → Turtle (ROBOT supports ttl output)
  docker run --rm \
    -v "$TESTS_DIR:/ontologies:ro" \
    -v "$FIXTURES_DIR:/out" \
    "$ROBOT_IMAGE" \
    robot convert \
      --input "/ontologies/$(basename "$input")" \
      --format ttl \
      --output "/out/${base}.ttl"
  # Step 2: Turtle → NTriples (rdflib, no Java needed)
  python3 - "$tmp_ttl" "$output" <<'PYEOF'
import sys
from rdflib import ConjunctiveGraph
g = ConjunctiveGraph()
g.parse(sys.argv[1], format="turtle")
g.serialize(destination=sys.argv[2], format="ntriples")
PYEOF
  rm -f "$tmp_ttl"
}

echo "Pulling $ROBOT_IMAGE ..."
docker pull "$ROBOT_IMAGE"

# Roberts family (OWL-DL with nominals, property chains — good classification test)
run_robot "$TESTS_DIR/roberts-family-full-D.owl.xml" "$FIXTURES_DIR/roberts-family.nt"

# LUBM ontology schema (39 KB — lightweight for LUBM schema-level inference test)
run_robot "$TESTS_DIR/lubm-univ-bench.owl.xml" "$FIXTURES_DIR/lubm.nt"

# GALEN (full medical ontology — large, use for stress/performance test)
run_robot "$TESTS_DIR/galen.owl.xml" "$FIXTURES_DIR/galen.nt"

# LUBM instance data (Turtle → NTriples via rdflib, no Docker needed)
echo "Converting lubm-univ-bench-data-1.ttl → lubm-data.nt ..."
python3 - "$REPO_ROOT/vendor/konclude/Tests/lubm-univ-bench-data-1.ttl" "$FIXTURES_DIR/lubm-data.nt" <<'PYEOF'
import sys
from rdflib import Graph
g = Graph()
g.parse(sys.argv[1], format="turtle")
g.serialize(destination=sys.argv[2], format="ntriples")
PYEOF

echo ""
echo "Fixtures written to $FIXTURES_DIR:"
ls -lh "$FIXTURES_DIR"/*.nt
