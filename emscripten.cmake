# Emscripten toolchain hints and link flags.
# Included by the top-level CMakeLists.txt only when EMSCRIPTEN is set.
# Consumed by src/CMakeLists.txt via the KONCLUDE_EMSCRIPTEN_LINK_FLAGS variable
# and the KONCLUDE_WASM_OUTPUT_DIR variable.

set(KONCLUDE_WASM_OUTPUT_DIR "${CMAKE_SOURCE_DIR}/dist")

set(KONCLUDE_EMSCRIPTEN_LINK_FLAGS
    "-fwasm-exceptions"
    "-pthread"
    "-sENVIRONMENT=node,worker"
    "-sMODULARIZE=1"
    "-sEXPORT_ES6=1"
    "-sEXPORT_NAME=createKoncludeModule"
    "-sINITIAL_MEMORY=1073741824"
    "-sALLOW_MEMORY_GROWTH=1"
    "-sMAXIMUM_MEMORY=4294967296"
    "-sNO_EXIT_RUNTIME=1"
    "--bind"
    "-sUSE_PTHREADS=1"
    "-sPTHREAD_POOL_SIZE=32"
    "-sPTHREAD_POOL_SIZE_STRICT=2"
    "-sMALLOC=mimalloc"
    "-Wl,--error-limit=0"
    "-sALLOW_BLOCKING_ON_MAIN_THREAD=1"
    "-sWASM_BIGINT=1"
    "-flto"
    "-sEXPORTED_RUNTIME_METHODS=[\"HEAPU8\"]"
    "-sEXPORTED_FUNCTIONS=[\"_malloc\",\"_free\"]"
)

# Native WebAssembly exceptions (-fwasm-exceptions, see above): the tableau signals task ends and clashes by C++ exception, so
# JS-based EH (-fexceptions) paid for every throw and every invoke_* trampoline (~3x slower in Chromium workers).
# Needs Chrome 95+, Firefox 100+, Safari 15.2+, Node 17+. wasm-opt (Binaryen) runs at link time (-O3 from CMAKE_BUILD_TYPE).

# Profiling builds keep the wasm name section so Chrome/Node profiles show C++ function names. wasm-opt rejected that
# section in 3.1.73, so it is skipped for these builds. Usage: KONCLUDE_PROFILING_FUNCS=ON make build-wasm
option(KONCLUDE_PROFILING_FUNCS "Keep wasm function names for profilers (skips wasm-opt)" OFF)
if(KONCLUDE_PROFILING_FUNCS)
    list(APPEND KONCLUDE_EMSCRIPTEN_LINK_FLAGS "--profiling-funcs" "--no-wasm-opt")
endif()

