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

# Add individual Redland integration files
list(APPEND KERNEL_SOURCES
    "${CMAKE_SOURCE_DIR}/vendor/konclude/Source/Reasoner/Triples/CRedlandStoredTriplesData.cpp"
)

# Add Generator sources required by KoncludeReasoner.cpp
file(GLOB GENERATOR_SOURCES
    "${CMAKE_SOURCE_DIR}/vendor/konclude/Source/Reasoner/Generator/*.cpp"
)
list(APPEND KERNEL_SOURCES ${GENERATOR_SOURCES})

# Add only the Redland-related Parser sources (the Qt XML parsers are excluded
# from the WASM build because they depend on QtXml which is not available).
list(APPEND KERNEL_SOURCES
    "${CMAKE_SOURCE_DIR}/vendor/konclude/Source/Parser/CRDFRedlandRaptorParser.cpp"
    "${CMAKE_SOURCE_DIR}/vendor/konclude/Source/Parser/CRDFRedlandRaptorSimpleConcurrentParser.cpp"
    "${CMAKE_SOURCE_DIR}/vendor/konclude/Source/Parser/COntologyBuilder.cpp"
    "${CMAKE_SOURCE_DIR}/vendor/konclude/Source/Parser/CTriplesDataBuilder.cpp"
    "${CMAKE_SOURCE_DIR}/vendor/konclude/Source/Parser/CAxiomOntologyBuilder.cpp"
    "${CMAKE_SOURCE_DIR}/vendor/konclude/Source/Parser/CABoxAxiomBuilder.cpp"
    "${CMAKE_SOURCE_DIR}/vendor/konclude/Source/Parser/CRBoxAxiomBuilder.cpp"
    "${CMAKE_SOURCE_DIR}/vendor/konclude/Source/Parser/CTBoxAxiomBuilder.cpp"
)

# Add Config sources required for configuration infrastructure
file(GLOB CONFIG_SOURCES
    "${CMAKE_SOURCE_DIR}/vendor/konclude/Source/Config/*.cpp"
)
list(APPEND KERNEL_SOURCES ${CONFIG_SOURCES})

# ---------------------------------------------------------------------------
# 2. Exclude Network, Loader, and main* files
# ---------------------------------------------------------------------------

list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/Network/.*")
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/Control/Loader/.*")
list(FILTER KERNEL_SOURCES EXCLUDE REGEX ".*/main[^/]*\\.cpp$")

# ---------------------------------------------------------------------------
# 3. Static library: konclude_kernel
# ---------------------------------------------------------------------------

add_library(konclude_kernel STATIC ${KERNEL_SOURCES})

target_compile_definitions(konclude_kernel
    PUBLIC
        KONCLUDE_REDLAND_INTEGRATION
        KONCLUDE_FORCE_ALL_DEBUG_DEACTIVATED
)

target_include_directories(konclude_kernel
    PUBLIC
        # Qt-free compatibility shim (added in Unit 3)
        "${CMAKE_SOURCE_DIR}/src/compat"
        # Konclude source root (for intra-project includes)
        "${CMAKE_SOURCE_DIR}/vendor/konclude/Source"
)

# Unit 6: raptor2 and librdf (pre-built for WASM by scripts/build-raptor-wasm.sh)
if(EMSCRIPTEN)
  set(WASM_LIBS_PREFIX "${CMAKE_SOURCE_DIR}/wasm-libs")
  target_include_directories(konclude_kernel PUBLIC "${WASM_LIBS_PREFIX}/include")
  target_link_libraries(konclude_wasm PRIVATE
    "${WASM_LIBS_PREFIX}/lib/librdf.a"
    "${WASM_LIBS_PREFIX}/lib/libraptor2.a"
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
