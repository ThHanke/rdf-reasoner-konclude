#!/bin/bash
cd /src

SKIP_RE="CStringSynsetsResult|CStringSynsetResult|CStringSetResult|CStringsResult|CStringHierarchyResult|CStringSubStringsRelationResult|CQtConcurrentVariableMappingsCompositionBaseBatchLinkerVector\b|CQtConcurrentVariableMappingsCompositionBaseBatchLinkerVectorData|CQtConcurrentVariableMappingsCompositionPropagationRealizationSchedulingBatchLinkerVector"

ERRORS=0

while IFS= read -r f; do
  ERRS=$(emcc -std=c++17 -O0 \
    -include /src/src/compat/QtCompat.h \
    -I /src/src/compat \
    -I /src/vendor/konclude/Source \
    -I /src/wasm-libs/include \
    -I /src/wasm-libs/include/raptor2 \
    -I /src/wasm-libs/include/rasqal \
    -DKONCLUDE_REDLAND_INTEGRATION \
    -DKONCLUDE_FORCE_ALL_DEBUG_DEACTIVATED \
    -fsyntax-only "$f" 2>&1 | grep "error:" | head -5)
  if [ -n "$ERRS" ]; then
    echo "=== $f ==="
    echo "$ERRS"
    ERRORS=$((ERRORS + 1))
  fi
done < <(find vendor/konclude/Source/Reasoner/Query \
     vendor/konclude/Source/Reasoner/Realization \
     vendor/konclude/Source/Control/Command \
     vendor/konclude/Source/Reasoner/Taxonomy \
     vendor/konclude/Source/Test/CCompletionGraphRandomWalkQueryGenerator.cpp \
     -name '*.cpp' | grep -Ev "$SKIP_RE")

echo "SYNTAX_CHECK_DONE: $ERRORS files with errors"
