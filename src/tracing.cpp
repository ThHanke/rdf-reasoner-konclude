#include "compat/WasmTrace.h"

#if WASM_TRACE_LEVEL >= 3

extern "C" {

void __cyg_profile_func_enter(void* fn, void* caller) {
    WASM_TRACE3("PROF", "enter", "fn=%lx caller=%lx",
        (unsigned long)(uintptr_t)fn, (unsigned long)(uintptr_t)caller);
}

void __cyg_profile_func_exit(void* fn, void* caller) {
    WASM_TRACE3("PROF", "exit", "fn=%lx caller=%lx",
        (unsigned long)(uintptr_t)fn, (unsigned long)(uintptr_t)caller);
}

} // extern "C"

#endif
