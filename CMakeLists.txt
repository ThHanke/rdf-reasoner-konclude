cmake_minimum_required(VERSION 3.20)
project(konclude_wasm CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Include Emscripten toolchain settings
if(EMSCRIPTEN)
  include(${CMAKE_CURRENT_SOURCE_DIR}/emscripten.cmake)
endif()

add_subdirectory(src)
