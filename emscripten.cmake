# Emscripten toolchain hints and link flags.
# Included by the top-level CMakeLists.txt only when EMSCRIPTEN is set.
# Consumed by src/CMakeLists.txt via the KONCLUDE_EMSCRIPTEN_LINK_FLAGS variable
# and the KONCLUDE_WASM_OUTPUT_DIR variable.

set(KONCLUDE_WASM_OUTPUT_DIR "${CMAKE_SOURCE_DIR}/dist")

set(KONCLUDE_EMSCRIPTEN_LINK_FLAGS
    "-s ENVIRONMENT=worker"
    "-s MODULARIZE=1"
    "-s EXPORT_ES6=1"
    "-s EXPORT_NAME=createKoncludeModule"
    "-s ALLOW_MEMORY_GROWTH=1"
    "-s NO_EXIT_RUNTIME=1"
    "--bind"
    "--oformat=esm"
)
