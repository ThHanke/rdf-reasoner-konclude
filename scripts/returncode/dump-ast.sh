#!/bin/bash
# Dump the clang JSON AST of the tableau completion algorithm (class members only) using the real build flags.
# usage: scripts/returncode/dump-ast.sh [out.json]      (needs the docker build image + an existing build/ dir with flags)
set -euo pipefail
OUT=${1:-logs/returncode/ast.json}
SRC=vendor/konclude/Source/Reasoner/Kernel/Algorithm/CCalculationTableauCompletionTaskHandleAlgorithm.cpp
mkdir -p "$(dirname "$OUT")"
docker compose run --rm -w /src/build/src shell bash -c "
  DEFS=\$(grep '^CXX_DEFINES' CMakeFiles/konclude_kernel.dir/flags.make | cut -d= -f2-)
  em++ \$DEFS @CMakeFiles/konclude_kernel.dir/includes_CXX.rsp -include /src/src/compat/QtCompat.h -fwasm-exceptions -pthread -std=gnu++17 -O0 \
    -fsyntax-only -Xclang -ast-dump=json -Xclang -ast-dump-filter=CCalculationTableauCompletionTaskHandleAlgorithm \
    /src/$SRC > /src/$OUT 2> /src/$OUT.err"
ls -la "$OUT"
