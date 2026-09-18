#include "compat/WasmTrace.h"

#if WASM_TRACE_LEVEL >= 3

extern "C" {

void __cyg_profile_func_enter(void* fn, void* caller) {
    (void)fn; (void)caller;
}

void __cyg_profile_func_exit(void* fn, void* caller) {
    (void)fn; (void)caller;
}

} // extern "C"

#endif
