# Emscripten toolchain hints and link flags.
# Included by the top-level CMakeLists.txt only when EMSCRIPTEN is set.
# Consumed by src/CMakeLists.txt via the KONCLUDE_EMSCRIPTEN_LINK_FLAGS variable
# and the KONCLUDE_WASM_OUTPUT_DIR variable.

set(KONCLUDE_WASM_OUTPUT_DIR "${CMAKE_SOURCE_DIR}/dist")

set(KONCLUDE_EMSCRIPTEN_LINK_FLAGS
    "-fexceptions"
    "-pthread"
    "-sENVIRONMENT=node,worker"
    "-sMODULARIZE=1"
    "-sEXPORT_ES6=1"
    "-sEXPORT_NAME=createKoncludeModule"
    "-sINITIAL_MEMORY=1073741824"
    "-sNO_EXIT_RUNTIME=1"
    "--bind"
    "-sUSE_PTHREADS=1"
    "-sPTHREAD_POOL_SIZE=8"
    "-sPTHREAD_POOL_SIZE_STRICT=2"
    "-sMALLOC=mimalloc"
    "-Wl,--error-limit=0"
    "-sNO_DISABLE_EXCEPTION_CATCHING"
    "-sALLOW_BLOCKING_ON_MAIN_THREAD=1"
    "-flto"
    "-sEXPORTED_RUNTIME_METHODS=[\"HEAPU8\"]"
    "-sEXPORTED_FUNCTIONS=[\"_malloc\",\"_free\"]"
)
