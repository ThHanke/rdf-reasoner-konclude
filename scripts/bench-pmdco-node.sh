#!/bin/bash
# usage: scripts/bench-pmdco-node.sh <runs> <label=packageRoot>...   alternating fresh-process runs
N=$1; shift
for i in $(seq $N); do for spec in "$@"; do
  echo -n "${spec%%=*} run$i "; node "$(dirname "$0")/../tests/bench/pmdco-seq.mjs" "${spec#*=}" ${FIXTURE:-tests/fixtures/pmdco-ontosphere.nt} 2>&1 | tail -1
done; done
