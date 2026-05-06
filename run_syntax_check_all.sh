#!/bin/bash
# Full syntax check over all new source directories added to the build.
cd /src

SKIP_RE="CStringSynsetsResult|CStringSynsetResult|CStringSetResult|CStringsResult|CStringHierarchyResult|CStringSubStringsRelationResult|CQtConcurrentVariableMappingsCompositionBaseBatchLinkerVector\b|CQtConcurrentVariableMappingsCompositionBaseBatchLinkerVectorData|CQtConcurrentVariableMappingsCompositionPropagationRealizationSchedulingBatchLinkerVector|CObjectAllocator\b|CObjectMemoryPoolAllocator\b|CObjectParameterizingAllocator\b|COWL2QtXML|COWLlinkQtXML|COWLlinkQueryParser\.cpp|CXMLOWL2StreamHandler|CXMLTestsuiteCommandParser|CSPARQLQtXMLResultParser|COntologyQtXMLDocumentParser|CQtXMLContentHandlerConverter|CDefaultDoubleDynamicReferenceVector|CDefaultDynamicReferenceVector|CDoubleDynamicReferenceVector|CDynamicReferenceBucket|CDynamicReferenceVector|CHash\.cpp|CLinker\.cpp|CList\.cpp|CNegLinker\.cpp|CQtHash\.cpp|CQtList\.cpp|CQtManagedRestrictedModificationHash\.cpp|CQtManagedRestrictedModificationList\.cpp|CQtManagedRestrictedModificationMap\.cpp|CQtManagedRestrictedModificationSet\.cpp|CQtManagedRestrictedModificationSharingHash|CQtSet\.cpp|CQtVector\.cpp|CSet\.cpp|CSortedLinker\.cpp|CSortedNegLinker\.cpp|CVector\.cpp"

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
    -fsyntax-only "$f" 2>&1 | grep "error:" | grep -v "^/emsdk.*note:\|^/emsdk.*candidate" | head -5)
  if [ -n "$ERRS" ]; then
    echo "=== $f ==="
    echo "$ERRS"
    ERRORS=$((ERRORS + 1))
  fi
done < <(find \
     vendor/konclude/Source/Parser \
     vendor/konclude/Source/Parser/Expressions \
     vendor/konclude/Source/Logger/Events \
     vendor/konclude/Source/Control/Command \
     vendor/konclude/Source/Reasoner/Triples \
     vendor/konclude/Source/Reasoner/Realizer \
     vendor/konclude/Source/Utilities/Memory \
     vendor/konclude/Source/Utilities/Container \
     vendor/konclude/Source/Concurrent/Callback \
     vendor/konclude/Source/Reasoner/Query \
     vendor/konclude/Source/Reasoner/Realization \
     vendor/konclude/Source/Reasoner/Taxonomy \
     vendor/konclude/Source/Test/CCompletionGraphRandomWalkQueryGenerator.cpp \
     -maxdepth 1 -name '*.cpp' | grep -Ev "$SKIP_RE")

echo "SYNTAX_CHECK_DONE: $ERRORS files with errors"
