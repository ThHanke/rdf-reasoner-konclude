cmake_minimum_required(VERSION 3.20)
project(konclude_wasm CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Apply vendor patches at configure time (idempotent — sentinel guards re-runs).
execute_process(
  COMMAND bash "${CMAKE_CURRENT_SOURCE_DIR}/scripts/apply-patches.sh"
  WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}"
  RESULT_VARIABLE _patch_result
)
if(NOT _patch_result EQUAL 0)
  message(FATAL_ERROR "apply-patches.sh failed (exit ${_patch_result})")
endif()

# Include Emscripten toolchain settings
if(EMSCRIPTEN)
  include(${CMAKE_CURRENT_SOURCE_DIR}/emscripten.cmake)
endif()

add_subdirectory(src)
