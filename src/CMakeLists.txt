# src/CMakeLists.txt — konclude_kernel static library + konclude_wasm executable/module
# Self-contained: all paths use CMAKE_SOURCE_DIR which is set by the top-level project.

# ---------------------------------------------------------------------------
# 1. Collect kernel sources via GLOB_RECURSE
# ---------------------------------------------------------------------------

file(GLOB_RECURSE KERNEL_SOURCES
    "${CMAKE_SOURCE_DIR}/vendor/konclude/Source/Reasoner/Kernel/*.cpp"
    "${CMAKE_SOURCE_DIR}/vendor/konclude/Source/Reasoner/Preprocess/*.cpp"
    "${CMAKE_SOURCE_DIR}/vendor/konclude/Source/Reasoner/Consistiser/*.cpp"
    "${CMAKE_SOURCE_DIR}/vendor/konclude/Source/Reasoner/Classifier/*.cpp"
    "${CMAKE_SOURCE_DIR}/vendor/konclude/Source/Reasoner/Ontology/*.cpp"
    "${CMAKE_SOURCE_DIR}/vendor/konclude/Source/Scheduler/*.cpp"
    "${CMAKE_SOURCE_DIR}/vendor/konclude/Source/Concurrent/*.cpp"
)

# Add all Reasoner/Triples sources
file(GLOB TRIPLES_SOURCES
    "${CMAKE_SOURCE_DIR}/vendor/konclude/Source/Reasoner/Triples/*.cpp"
)
list(APPEND KERNEL_SOURCES ${TRIPLES_SOURCES})

# Add Generator sources required by KoncludeReasoner.cpp
file(GLOB GENERATOR_SOURCES
    "${CMAKE_SOURCE_DIR}/vendor/konclude/Source/Reasoner/Generator/*.cpp"
)
list(APPEND KERNEL_SOURCES ${GENERATOR_SOURCES})

# Parser sources: all Parser/*.cpp and Parser/Expressions/*.cpp except Qt-XML
# dependent parsers (COWL2QtXML*, COWLlinkQtXML*, CXMLOWL2StreamHandler, etc.)
file(GLOB PARSER_SOURCES
    "${CMAKE_SOURCE_DIR}/vendor/konclude/Source/Parser/*.cpp"
)
file(GLOB PARSER_EXPRESSION_SOURCES
    "${CMAKE_SOURCE_DIR}/vendor/konclude/Source/Parser/Expressions/*.cpp"
)
list(APPEND KERNEL_SOURCES ${PARSER_SOURCES} ${PARSER_EXPRESSION_SOURCES})

# Add Config sources required for configuration infrastructure
file(GLOB CONFIG_SOURCES
    "${CMAKE_SOURCE_DIR}/vendor/konclude/Source/Config/*.cpp"
)
list(APPEND KERNEL_SOURCES ${CONFIG_SOURCES})

# Add Logger sources (CLogger, logTr, Events)
file(GLOB LOGGER_SOURCES
    "${CMAKE_SOURCE_DIR}/vendor/konclude/Source/Logger/*.cpp"
)
file(GLOB LOGGER_EVENTS_SOURCES
    "${CMAKE_SOURCE_DIR}/vendor/konclude/Source/Logger/Events/*.cpp"
)
file(GLOB LOGGER_RECORD_SOURCES
    "${CMAKE_SOURCE_DIR}/vendor/konclude/Source/Logger/Record/*.cpp"
)
list(APPEND KERNEL_SOURCES ${LOGGER_SOURCES} ${LOGGER_EVENTS_SOURCES} ${LOGGER_RECORD_SOURCES})

# Add Classification and Consistence sources needed by the kernel
file(GLOB CLASSIFICATION_SOURCES
    "${CMAKE_SOURCE_DIR}/vendor/konclude/Source/Reasoner/Classification/*.cpp"
)
list(APPEND KERNEL_SOURCES ${CLASSIFICATION_SOURCES})

file(GLOB CONSISTENCE_SOURCES
    "${CMAKE_SOURCE_DIR}/vendor/konclude/Source/Reasoner/Consistence/*.cpp"
)
list(APPEND KERNEL_SOURCES ${CONSISTENCE_SOURCES})

# Add Taxonomy (vtable for CTaxonomy)
file(GLOB TAXONOMY_SOURCES
    "${CMAKE_SOURCE_DIR}/vendor/konclude/Source/Reasoner/Taxonomy/*.cpp"
)
list(APPEND KERNEL_SOURCES ${TAXONOMY_SOURCES})

# Add Context sources
file(GLOB CONTEXT_SOURCES
    "${CMAKE_SOURCE_DIR}/vendor/konclude/Source/Context/*.cpp"
)
list(APPEND KERNEL_SOURCES ${CONTEXT_SOURCES})

# Add Utilities: Memory + Container via GLOB, Concurrent/Callback, and top-level files.
# Template-impl files (.cpp included from headers) are excluded in section 2 below.
file(GLOB UTILITIES_MEMORY_SOURCES
    "${CMAKE_SOURCE_DIR}/vendor/konclude/Source/Utilities/Memory/*.cpp"
)
file(GLOB UTILITIES_CONTAINER_SOURCES
    "${CMAKE_SOURCE_DIR}/vendor/konclude/Source/Utilities/Container/*.cpp"
)
file(GLOB CONCURRENT_CALLBACK_SOURCES
    "${CMAKE_SOURCE_DIR}/vendor/konclude/Source/Concurrent/Callback/*.cpp"
)
list(APPEND KERNEL_SOURCES
    ${UTILITIES_MEMORY_SOURCES}
    ${UTILITIES_CONTAINER_SOURCES}
    ${CONCURRENT_CALLBACK_SOURCES}
    "${CMAKE_SOURCE_DIR}/vendor/konclude/Source/Utilities/CAllocationObject.cpp"
    "${CMAKE_SOURCE_DIR}/vendor/konclude/Source/Utilities/CAllocationLinker.cpp"
    "${CMAKE_SOURCE_DIR}/vendor/konclude/Source/Utilities/CMath.cpp"
    "${CMAKE_SOURCE_DIR}/vendor/konclude/Source/Utilities/CMemoryReleaser.cpp"
    "${CMAKE_SOURCE_DIR}/vendor/konclude/Source/Utilities/CObjectContainer.cpp"
    "${CMAKE_SOURCE_DIR}/vendor/konclude/Source/Reasoner/Query/CSatisfiableCalculationJob.cpp"
    "${CMAKE_SOURCE_DIR}/vendor/konclude/Source/Reasoner/Query/CJobSatisfiableCallbackContextData.cpp"
    "${CMAKE_SOURCE_DIR}/vendor/konclude/Source/Reasoner/Query/CApproximatedSaturationCalculationJob.cpp"
)

# Add Realizer sources (including Events subdirectory)
file(GLOB_RECURSE REALIZER_SOURCES
    "${CMAKE_SOURCE_DIR}/vendor/konclude/Source/Reasoner/Realizer/*.cpp"
)
list(APPEND KERNEL_SOURCES ${REALIZER_SOURCES})

# Add Answerer sources
file(GLOB_RECURSE ANSWERER_SOURCES
    "${CMAKE_SOURCE_DIR}/vendor/konclude/Source/Reasoner/Answerer/*.cpp"
)
list(APPEND KERNEL_SOURCES ${ANSWERER_SOURCES})

# Add Reasoner/Query sources (minus template-impl string result files)
file(GLOB QUERY_SOURCES
    "${CMAKE_SOURCE_DIR}/vendor/konclude/Source/Reasoner/Query/*.cpp"
)
list(APPEND KERNEL_SOURCES ${QUERY_SOURCES})

# Add Reasoner/Realization sources
file(GLOB REALIZATION_SOURCES
    "${CMAKE_SOURCE_DIR}/vendor/konclude/Source/Reasoner/Realization/*.cpp"
)
list(APPEND KERNEL_SOURCES ${REALIZATION_SOURCES})

# Add Control/Command sources (including Records subdirectory)
file(GLOB CONTROL_COMMAND_SOURCES
    "${CMAKE_SOURCE_DIR}/vendor/konclude/Source/Control/Command/*.cpp"
)
file(GLOB CONTROL_COMMAND_RECORDS_SOURCES
    "${CMAKE_SOURCE_DIR}/vendor/konclude/Source/Control/Command/Records/*.cpp"
)
list(APPEND KERNEL_SOURCES ${CONTROL_COMMAND_SOURCES} ${CONTROL_COMMAND_RECORDS_SOURCES})

# Add Test source needed by kernel (CCompletionGraphRandomWalkQueryGenerator)
list(APPEND KERNEL_SOURCES
    "${CMAKE_SOURCE_DIR}/vendor/konclude/Source/Test/CCompletionGraphRandomWalkQueryGenerator.cpp"
)

# ---------------------------------------------------------------------------
# 2. Exclude Network, Loader, main* files, and template-impl cpp files
# ---------------------------------------------------------------------------

list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/Network/.*")
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/Control/Loader/.*")
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/main[^/]*\\.cpp$")
# Qt-XML parser files that require real Qt XML streams (not shim-compatible)
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/COWL2QtXML.*\\.cpp$")
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/COWLlinkQtXML.*\\.cpp$")
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/COWLlinkQueryParser\\.cpp$")
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/CXMLOWL2StreamHandler\\.cpp$")
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/CXMLTestsuiteCommandParser\\.cpp$")
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/CSPARQLQtXMLResultParser\\.cpp$")
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/COntologyQtXMLDocumentParser\\.cpp$")
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/CQtXMLContentHandlerConverter\\.cpp$")
# Template-impl files #include-d from their headers — not standalone TUs
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/CQtConcurrentVariableMappingsCompositionBaseBatchLinkerVector\\.cpp$")
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/CQtConcurrentVariableMappingsCompositionBaseBatchLinkerVectorData\\.cpp$")
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/CQtConcurrentVariableMappingsCompositionPropagationRealizationSchedulingBatchLinkerVector\\.cpp$")
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/CObjectAllocator\\.cpp$")
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/CObjectMemoryPoolAllocator\\.cpp$")
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/CObjectParameterizingAllocator\\.cpp$")
# Utilities/Container template-impl files — all included from their .h via #include "*.cpp"
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/Utilities/Container/CDefaultDoubleDynamicReferenceVector\\.cpp$")
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/Utilities/Container/CDefaultDynamicReferenceVector\\.cpp$")
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/Utilities/Container/CDoubleDynamicReferenceVector\\.cpp$")
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/Utilities/Container/CDynamicReferenceBucket\\.cpp$")
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/Utilities/Container/CDynamicReferenceVector\\.cpp$")
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/Utilities/Container/CHash\\.cpp$")
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/Utilities/Container/CLinker\\.cpp$")
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/Utilities/Container/CList\\.cpp$")
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/Utilities/Container/CNegLinker\\.cpp$")
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/Utilities/Container/CQtHash\\.cpp$")
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/Utilities/Container/CQtList\\.cpp$")
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/Utilities/Container/CQtManagedRestrictedModificationHash\\.cpp$")
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/Utilities/Container/CQtManagedRestrictedModificationList\\.cpp$")
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/Utilities/Container/CQtManagedRestrictedModificationMap\\.cpp$")
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/Utilities/Container/CQtManagedRestrictedModificationSet\\.cpp$")
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/Utilities/Container/CQtManagedRestrictedModificationSharingHash\\.cpp$")
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/Utilities/Container/CQtSet\\.cpp$")
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/Utilities/Container/CQtVector\\.cpp$")
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/Utilities/Container/CSet\\.cpp$")
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/Utilities/Container/CSortedLinker\\.cpp$")
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/Utilities/Container/CSortedNegLinker\\.cpp$")
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/Utilities/Container/CVector\\.cpp$")
# Reasoner/Query template-impl string result files
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/CStringSynsetsResult\\.cpp$")
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/CStringSynsetResult\\.cpp$")
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/CStringSetResult\\.cpp$")
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/CStringsResult\\.cpp$")
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/CStringHierarchyResult\\.cpp$")
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/CStringSubStringsRelationResult\\.cpp$")

# ---------------------------------------------------------------------------
# 2b. Source overrides: exclude vendor files replaced by src/compat/overrides/
#
# Each overridden file has a WASM-specific replacement in src/compat/overrides/.
# The vendor original is excluded from the glob, then the override is appended.
# When updating the submodule, diff the vendor file against the override to
# pick up any upstream fixes that should carry forward.
# ---------------------------------------------------------------------------

set(OVERRIDE_DIR "${CMAKE_SOURCE_DIR}/src/compat/overrides")

# Concurrent overrides (threading model: synchronous BFS dispatch, no OS threads)
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/Concurrent/CThread\\.cpp$")
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/Concurrent/CIntervalThread\\.cpp$")
list(APPEND KERNEL_SOURCES
    "${OVERRIDE_DIR}/CThread.cpp"
    "${OVERRIDE_DIR}/CIntervalThread.cpp"
)

# Parser overrides (QIODevice → string-based API; concurrent parser removed)
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/Parser/CRDFRedlandRaptorParser\\.cpp$")
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/Parser/CRDFRedlandRaptorSimpleConcurrentParser\\.cpp$")
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/Parser/COntologyMultiAutoParsingLoader\\.cpp$")
list(APPEND KERNEL_SOURCES
    "${OVERRIDE_DIR}/CRDFRedlandRaptorParser.cpp"
    "${OVERRIDE_DIR}/CRDFRedlandRaptorSimpleConcurrentParser.cpp"
    "${OVERRIDE_DIR}/COntologyMultiAutoParsingLoader.cpp"
)

# CKoncludeInfo: vendor version requires revision-git.h (absent in WASM); use stub override.
list(APPEND KERNEL_SOURCES "${OVERRIDE_DIR}/CKoncludeInfo.cpp")

# STPU override: restores original semaphore-based blocking (pthreads build only).
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/Scheduler/CSingleThreadTaskProcessorUnit\\.cpp$")
list(APPEND KERNEL_SOURCES "${OVERRIDE_DIR}/CSingleThreadTaskProcessorUnit.cpp")

# ---------------------------------------------------------------------------
# 3. Static library: konclude_kernel
# ---------------------------------------------------------------------------

add_library(konclude_kernel STATIC ${KERNEL_SOURCES})

target_compile_definitions(konclude_kernel
    PUBLIC
        KONCLUDE_REDLAND_INTEGRATION
        KONCLUDE_FORCE_ALL_DEBUG_DEACTIVATED
        KONCLUDE_WASM_PTHREADS
        WASM_LOG_LEVEL=1
)

target_include_directories(konclude_kernel
    PUBLIC
        # Qt-free compatibility shim (added in Unit 3)
        "${CMAKE_SOURCE_DIR}/src/compat"
        # Konclude source root (for intra-project includes)
        "${CMAKE_SOURCE_DIR}/vendor/konclude/Source"
)

# Force-include QtCompat.h before all translation units so that Qt type
# aliases and macros are available without modifying vendor sources.
target_compile_options(konclude_kernel PRIVATE
    "-include" "${CMAKE_SOURCE_DIR}/src/compat/QtCompat.h"
    $<$<BOOL:${EMSCRIPTEN}>:-fexceptions>
    $<$<BOOL:${EMSCRIPTEN}>:-pthread>
    $<$<BOOL:${EMSCRIPTEN}>:-flto>
)

# Unit 6: raptor2 and librdf include paths on konclude_kernel
# (link step happens after add_executable below)
if(EMSCRIPTEN)
  set(WASM_LIBS_PREFIX "${CMAKE_SOURCE_DIR}/wasm-libs")
  target_include_directories(konclude_kernel PUBLIC
    "${WASM_LIBS_PREFIX}/include"
    "${WASM_LIBS_PREFIX}/include/raptor2"
    "${WASM_LIBS_PREFIX}/include/rasqal"
  )
endif()

# ---------------------------------------------------------------------------
# 4. WASM executable / module: konclude_wasm
# ---------------------------------------------------------------------------

add_executable(konclude_wasm
    "${CMAKE_SOURCE_DIR}/src/bindings.cpp"
    "${CMAKE_SOURCE_DIR}/src/KoncludeReasoner.cpp"
)

set_target_properties(konclude_wasm PROPERTIES
    OUTPUT_NAME "konclude"
)

target_link_libraries(konclude_wasm
    PRIVATE
        konclude_kernel
)

if(EMSCRIPTEN)
  target_link_libraries(konclude_wasm PRIVATE
    "${WASM_LIBS_PREFIX}/lib/librdf.a"
    "${WASM_LIBS_PREFIX}/lib/librasqal.a"
    "${WASM_LIBS_PREFIX}/lib/libraptor2.a"
  )
endif()

# Apply Emscripten link flags when building with Emscripten.
# KONCLUDE_EMSCRIPTEN_LINK_FLAGS is populated by emscripten.cmake.
if(EMSCRIPTEN)
    target_link_options(konclude_wasm
        PRIVATE
            ${KONCLUDE_EMSCRIPTEN_LINK_FLAGS}
    )

    # Direct output to dist/
    set_target_properties(konclude_wasm PROPERTIES
        RUNTIME_OUTPUT_DIRECTORY "${KONCLUDE_WASM_OUTPUT_DIR}"
        SUFFIX ".mjs"
    )
endif()
