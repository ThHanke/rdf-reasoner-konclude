cmake_minimum_required(VERSION 3.16)
project(konclude_native CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Root of the repo is one level up from this native/ subdirectory.
set(ROOT "${CMAKE_CURRENT_SOURCE_DIR}/..")
get_filename_component(ROOT "${ROOT}" ABSOLUTE)

# Apply vendor patches (same as WASM build).
execute_process(
  COMMAND bash "${ROOT}/scripts/apply-patches.sh"
  WORKING_DIRECTORY "${ROOT}"
  RESULT_VARIABLE _patch_result
)
if(NOT _patch_result EQUAL 0)
  message(FATAL_ERROR "apply-patches.sh failed (exit ${_patch_result})")
endif()

# ── Source list (mirrors src/CMakeLists.txt) ─────────────────────────────────

file(GLOB_RECURSE KERNEL_SOURCES
    "${ROOT}/vendor/konclude/Source/Reasoner/Kernel/*.cpp"
    "${ROOT}/vendor/konclude/Source/Reasoner/Preprocess/*.cpp"
    "${ROOT}/vendor/konclude/Source/Reasoner/Consistiser/*.cpp"
    "${ROOT}/vendor/konclude/Source/Reasoner/Classifier/*.cpp"
    "${ROOT}/vendor/konclude/Source/Reasoner/Ontology/*.cpp"
    "${ROOT}/vendor/konclude/Source/Scheduler/*.cpp"
    "${ROOT}/vendor/konclude/Source/Concurrent/*.cpp"
)
file(GLOB TRIPLES_SOURCES    "${ROOT}/vendor/konclude/Source/Reasoner/Triples/*.cpp")
file(GLOB GENERATOR_SOURCES  "${ROOT}/vendor/konclude/Source/Reasoner/Generator/*.cpp")
file(GLOB PARSER_SOURCES     "${ROOT}/vendor/konclude/Source/Parser/*.cpp")
file(GLOB PARSER_EXPR_SOURCES "${ROOT}/vendor/konclude/Source/Parser/Expressions/*.cpp")
file(GLOB CONFIG_SOURCES     "${ROOT}/vendor/konclude/Source/Config/*.cpp")
file(GLOB LOGGER_SOURCES     "${ROOT}/vendor/konclude/Source/Logger/*.cpp")
file(GLOB LOGGER_EV_SOURCES  "${ROOT}/vendor/konclude/Source/Logger/Events/*.cpp")
file(GLOB LOGGER_REC_SOURCES "${ROOT}/vendor/konclude/Source/Logger/Record/*.cpp")
file(GLOB CLASSIF_SOURCES    "${ROOT}/vendor/konclude/Source/Reasoner/Classification/*.cpp")
file(GLOB CONSIST_SOURCES    "${ROOT}/vendor/konclude/Source/Reasoner/Consistence/*.cpp")
file(GLOB TAXONOMY_SOURCES   "${ROOT}/vendor/konclude/Source/Reasoner/Taxonomy/*.cpp")
file(GLOB CONTEXT_SOURCES    "${ROOT}/vendor/konclude/Source/Context/*.cpp")
file(GLOB UTIL_MEM_SOURCES   "${ROOT}/vendor/konclude/Source/Utilities/Memory/*.cpp")
file(GLOB UTIL_CON_SOURCES   "${ROOT}/vendor/konclude/Source/Utilities/Container/*.cpp")
file(GLOB CONC_CB_SOURCES    "${ROOT}/vendor/konclude/Source/Concurrent/Callback/*.cpp")
file(GLOB CONC_EV_SOURCES    "${ROOT}/vendor/konclude/Source/Concurrent/Events/*.cpp")
file(GLOB_RECURSE REALIZER_SOURCES "${ROOT}/vendor/konclude/Source/Reasoner/Realizer/*.cpp")
file(GLOB_RECURSE ANSWERER_SOURCES "${ROOT}/vendor/konclude/Source/Reasoner/Answerer/*.cpp")
file(GLOB QUERY_SOURCES      "${ROOT}/vendor/konclude/Source/Reasoner/Query/*.cpp")
file(GLOB REAL_SOURCES       "${ROOT}/vendor/konclude/Source/Reasoner/Realization/*.cpp")
file(GLOB CTRL_CMD_SOURCES   "${ROOT}/vendor/konclude/Source/Control/Command/*.cpp")
file(GLOB CTRL_REC_SOURCES   "${ROOT}/vendor/konclude/Source/Control/Command/Records/*.cpp")

list(APPEND KERNEL_SOURCES
    ${TRIPLES_SOURCES} ${GENERATOR_SOURCES} ${PARSER_SOURCES} ${PARSER_EXPR_SOURCES}
    ${CONFIG_SOURCES} ${LOGGER_SOURCES} ${LOGGER_EV_SOURCES} ${LOGGER_REC_SOURCES}
    ${CLASSIF_SOURCES} ${CONSIST_SOURCES} ${TAXONOMY_SOURCES} ${CONTEXT_SOURCES}
    ${UTIL_MEM_SOURCES} ${UTIL_CON_SOURCES} ${CONC_CB_SOURCES} ${CONC_EV_SOURCES}
    ${REALIZER_SOURCES} ${ANSWERER_SOURCES} ${QUERY_SOURCES} ${REAL_SOURCES}
    ${CTRL_CMD_SOURCES} ${CTRL_REC_SOURCES}
    "${ROOT}/vendor/konclude/Source/Utilities/CAllocationObject.cpp"
    "${ROOT}/vendor/konclude/Source/Utilities/CAllocationLinker.cpp"
    "${ROOT}/vendor/konclude/Source/Utilities/CMath.cpp"
    "${ROOT}/vendor/konclude/Source/Utilities/CMemoryReleaser.cpp"
    "${ROOT}/vendor/konclude/Source/Utilities/CObjectContainer.cpp"
    "${ROOT}/vendor/konclude/Source/Reasoner/Query/CSatisfiableCalculationJob.cpp"
    "${ROOT}/vendor/konclude/Source/Reasoner/Query/CJobSatisfiableCallbackContextData.cpp"
    "${ROOT}/vendor/konclude/Source/Reasoner/Query/CApproximatedSaturationCalculationJob.cpp"
    "${ROOT}/vendor/konclude/Source/Test/CCompletionGraphRandomWalkQueryGenerator.cpp"
)

# ── Exclusions (same filters as WASM build) ──────────────────────────────────
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/Network/.*")
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/Control/Loader/.*")
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/main[^/]*\\.cpp$")
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/COWL2QtXML.*\\.cpp$")
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/COWLlinkQtXML.*\\.cpp$")
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/COWLlinkQueryParser\\.cpp$")
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/CXMLOWL2StreamHandler\\.cpp$")
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/CXMLTestsuiteCommandParser\\.cpp$")
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/CSPARQLQtXMLResultParser\\.cpp$")
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/COntologyQtXMLDocumentParser\\.cpp$")
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/CQtXMLContentHandlerConverter\\.cpp$")
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/CQtConcurrentVariableMappingsCompositionBaseBatchLinkerVector\\.cpp$")
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/CQtConcurrentVariableMappingsCompositionBaseBatchLinkerVectorData\\.cpp$")
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/CQtConcurrentVariableMappingsCompositionPropagationRealizationSchedulingBatchLinkerVector\\.cpp$")
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/CObjectAllocator\\.cpp$")
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/CObjectMemoryPoolAllocator\\.cpp$")
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/CObjectParameterizingAllocator\\.cpp$")
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
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/CStringSynsetsResult\\.cpp$")
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/CStringSynsetResult\\.cpp$")
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/CStringSetResult\\.cpp$")
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/CStringsResult\\.cpp$")
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/CStringHierarchyResult\\.cpp$")
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/CStringSubStringsRelationResult\\.cpp$")

# ── Overrides (same as WASM build) ───────────────────────────────────────────
set(OVERRIDE_DIR "${ROOT}/src/compat/overrides")
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/Concurrent/CThread\\.cpp$")
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/Concurrent/CIntervalThread\\.cpp$")
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/Parser/CRDFRedlandRaptorParser\\.cpp$")
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/Parser/CRDFRedlandRaptorSimpleConcurrentParser\\.cpp$")
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/Parser/COntologyMultiAutoParsingLoader\\.cpp$")
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/Scheduler/CSingleThreadTaskProcessorUnit\\.cpp$")
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/Realizer/COntologyRealizingDynamicRequirmentCallbackData\\.cpp$")
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/Kernel/Manager/CPrecomputationManager\\.cpp$")
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/Kernel/Manager/CPreprocessingManager\\.cpp$")
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/Classifier/CClassificationManager\\.cpp$")
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/Algorithm/CSatisfiableTaskClassificationMessageAnalyser\\.cpp$")
list(APPEND KERNEL_SOURCES
    "${OVERRIDE_DIR}/CThread.cpp"
    "${OVERRIDE_DIR}/CIntervalThread.cpp"
    "${OVERRIDE_DIR}/CRDFRedlandRaptorParser.cpp"
    "${OVERRIDE_DIR}/CRDFRedlandRaptorSimpleConcurrentParser.cpp"
    "${OVERRIDE_DIR}/COntologyMultiAutoParsingLoader.cpp"
    "${OVERRIDE_DIR}/CKoncludeInfo.cpp"
    "${OVERRIDE_DIR}/CSingleThreadTaskProcessorUnit.cpp"
    "${OVERRIDE_DIR}/COntologyRealizingDynamicRequirmentCallbackData.cpp"
    "${OVERRIDE_DIR}/CPrecomputationManager.cpp"
    "${OVERRIDE_DIR}/CPreprocessingManager.cpp"
    "${OVERRIDE_DIR}/CClassificationManager.cpp"
    "${OVERRIDE_DIR}/CSatisfiableTaskClassificationMessageAnalyser.cpp"
)

# ── Static kernel library ─────────────────────────────────────────────────────
add_library(konclude_kernel_native STATIC ${KERNEL_SOURCES})

target_compile_definitions(konclude_kernel_native
    PUBLIC
        KONCLUDE_REDLAND_INTEGRATION
        KONCLUDE_FORCE_ALL_DEBUG_DEACTIVATED
        KONCLUDE_WASM_PTHREADS
        WASM_LOG_LEVEL=1
        WASM_TRACE_LEVEL=0
        WASM_JUSTIFICATION_HOOK
        NATIVE_DEBUG_BUILD
        $<$<BOOL:${REPRO_ORDERED_QHASH}>:REPRO_ORDERED_QHASH>
        $<$<BOOL:${REPRO_STD_QHASH}>:REPRO_STD_QHASH>
)

target_include_directories(konclude_kernel_native
    PUBLIC
        "${ROOT}/src/compat"
        "${ROOT}/vendor/konclude/Source"
        "${ROOT}/src"
        "/usr/include/raptor2"
        "/usr/include/rasqal"
        "/usr/include"
)

target_compile_options(konclude_kernel_native
    PRIVATE
        "-include" "${ROOT}/src/compat/QtCompat.h"
        -g3 -O1 -fno-omit-frame-pointer
        -pthread
        -fexceptions
)

# ── Debug harness executable ──────────────────────────────────────────────────
add_executable(konclude_debug
    "${ROOT}/src/debug_harness.cpp"
    "${ROOT}/src/KoncludeReasoner.cpp"
    "${ROOT}/src/tracing.cpp"
)

target_link_libraries(konclude_debug
    PRIVATE
        konclude_kernel_native
        -lrdf
        -lrasqal
        -lraptor2
        -lpthread
)

target_compile_options(konclude_debug
    PRIVATE
        -g3 -O1 -fno-omit-frame-pointer -pthread -fexceptions
)

target_include_directories(konclude_debug
    PRIVATE
        "${ROOT}/src/compat"
        "${ROOT}/vendor/konclude/Source"
        "${ROOT}/src"
        "/usr/include/raptor2"
        "/usr/include/rasqal"
        "/usr/include"
)

# ── Incremental-reasoning reproducer (no WASM, no N3) ─────────────────────────
add_executable(konclude_repro
    "${ROOT}/src/native_repro.cpp"
    "${ROOT}/src/KoncludeReasoner.cpp"
    "${ROOT}/src/tracing.cpp"
)
target_link_libraries(konclude_repro PRIVATE konclude_kernel_native -lrdf -lrasqal -lraptor2 -lpthread)
target_compile_options(konclude_repro PRIVATE -g3 -O1 -fno-omit-frame-pointer -pthread -fexceptions)

# ── Optional AddressSanitizer build (use-after-free / overflow hunting) ───────
option(REPRO_ASAN "Build with AddressSanitizer" OFF)
if(REPRO_ASAN)
  target_compile_options(konclude_kernel_native PRIVATE -fsanitize=address -fno-omit-frame-pointer)
  target_compile_options(konclude_repro PRIVATE -fsanitize=address -fno-omit-frame-pointer)
  target_link_options(konclude_repro PRIVATE -fsanitize=address)
  target_link_options(konclude_debug PRIVATE -fsanitize=address)
  target_compile_options(konclude_debug PRIVATE -fsanitize=address -fno-omit-frame-pointer)
endif()
