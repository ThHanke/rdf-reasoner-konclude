#ifndef WASM_TRACE_H
#define WASM_TRACE_H

/*
 * Unified WASM trace system — JSONL to stderr.
 *
 * WASM_TRACE_LEVEL: 0=off, 1=pipeline, 2=detail, 3=hot-path
 * At level 0 all macros compile to ((void)0) — zero overhead.
 *
 * Format: {"t":ms,"tid":"hex","tag":"TAG","ev":"event","d":"detail"}\n
 * Tags are short class-name tokens (STPU, SAT, KPSET, PRECOMP, etc).
 * Community ID mapping happens at post-processing time via graphify.
 *
 * Self-contained: no dependency on QtCompat.h.
 */

#ifndef WASM_TRACE_LEVEL
#define WASM_TRACE_LEVEL 0
#endif

#if WASM_TRACE_LEVEL > 0

#include <cstdio>
#include <cstdarg>
#include <cstdint>
#include <pthread.h>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#endif

namespace WasmTraceInternal {

inline double getTimeMs() {
#ifdef __EMSCRIPTEN__
    return emscripten_get_now();
#else
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec * 1000.0 + ts.tv_nsec / 1000000.0;
#endif
}

inline uint64_t getThreadId() {
    return (uint64_t)(uintptr_t)pthread_self();
}

inline void trace(const char* tag, const char* ev, const char* fmt, ...) {
    char detail[384];
    va_list args;
    va_start(args, fmt);
    vsnprintf(detail, sizeof(detail), fmt, args);
    va_end(args);

    fprintf(stderr,
        "{\"t\":%.1f,\"tid\":\"%lx\",\"tag\":\"%s\",\"ev\":\"%s\",\"d\":\"%s\"}\n",
        getTimeMs(), (unsigned long)getThreadId(), tag, ev, detail);
    fflush(stderr);
}

inline void trace3(const char* tag, const char* ev, const char* fmt, ...) {
    char detail[384];
    va_list args;
    va_start(args, fmt);
    vsnprintf(detail, sizeof(detail), fmt, args);
    va_end(args);

    fprintf(stderr,
        "{\"t\":%.1f,\"tid\":\"%lx\",\"tag\":\"%s\",\"ev\":\"%s\",\"d\":\"%s\"}\n",
        getTimeMs(), (unsigned long)getThreadId(), tag, ev, detail);
}

} // namespace WasmTraceInternal

#define WASM_TRACE(tag, ev, fmt, ...) \
    WasmTraceInternal::trace(tag, ev, fmt, ##__VA_ARGS__)

#if WASM_TRACE_LEVEL >= 1
#define WASM_TRACE1(tag, ev, fmt, ...) \
    WasmTraceInternal::trace(tag, ev, fmt, ##__VA_ARGS__)
#else
#define WASM_TRACE1(tag, ev, fmt, ...) ((void)0)
#endif

#if WASM_TRACE_LEVEL >= 2
#define WASM_TRACE2(tag, ev, fmt, ...) \
    WasmTraceInternal::trace(tag, ev, fmt, ##__VA_ARGS__)
#else
#define WASM_TRACE2(tag, ev, fmt, ...) ((void)0)
#endif

#if WASM_TRACE_LEVEL >= 3
#define WASM_TRACE3(tag, ev, fmt, ...) \
    WasmTraceInternal::trace3(tag, ev, fmt, ##__VA_ARGS__)
#else
#define WASM_TRACE3(tag, ev, fmt, ...) ((void)0)
#endif

#else /* WASM_TRACE_LEVEL == 0 */

#define WASM_TRACE(tag, ev, fmt, ...)  ((void)0)
#define WASM_TRACE1(tag, ev, fmt, ...) ((void)0)
#define WASM_TRACE2(tag, ev, fmt, ...) ((void)0)
#define WASM_TRACE3(tag, ev, fmt, ...) ((void)0)

#endif /* WASM_TRACE_LEVEL > 0 */

/* ── Mechanism B: Vendor macro hijack ──────────────────────────────────
 *
 * When WASM_TRACE_OVERRIDE is defined AND WASM_TRACE_LEVEL >= 2, redirect
 * vendor debug macros (normally disabled by KONCLUDE_FORCE_ALL_DEBUG_DEACTIVATED)
 * to the trace system. Requires patch-023 to wrap vendor definitions in
 * #ifndef WASM_TRACE_OVERRIDE guards.
 */
#ifdef WASM_TRACE_OVERRIDE
#if WASM_TRACE_LEVEL >= 2

#define KONCLUCE_TASK_ALGORITHM_TIME_MEASURE_INSTRUCTION(a) \
    WASM_TRACE2("TABLEAU", "time_measure", "")
#define KONCLUCE_TASK_ALGORITHM_CLASH_STRING_INSTRUCTION(a) \
    WASM_TRACE2("TABLEAU", "clash", "")
#define KONCLUCE_TASK_ALGORITHM_MODEL_STRING_INSTRUCTION(a) \
    WASM_TRACE2("TABLEAU", "model_string", "")
#define KONCLUCE_TASK_ALGORITHM_MERGING_DEBUGGING_INSTRUCTION(a) \
    WASM_TRACE2("TABLEAU", "merge_debug", "")
#define KONCLUCE_TASK_ALGORITHM_VARIABLE_PROPAGATION_BLOCKING_DEBUGGING_INSTRUCTION(a) \
    WASM_TRACE2("TABLEAU", "var_prop_block", "")

#define SETTASKDESCRIPTION(a) \
    WASM_TRACE2("THREAD", "task_desc", "")
#define TIMEMEASUREMENTBEGINWAITING() \
    WASM_TRACE2("THREAD", "begin_waiting", "")
#define TIMEMEASUREMENTENDWAITING() \
    WASM_TRACE2("THREAD", "end_waiting", "")
#define TIMEMEASUREMENTBEGINEXECUTION() \
    WASM_TRACE2("THREAD", "begin_exec", "")
#define TIMEMEASUREMENTENDEXECUTION() \
    WASM_TRACE2("THREAD", "end_exec", "")
#define TIMEMEASUREMENTBEGINBLOCKING() \
    WASM_TRACE2("THREAD", "begin_block", "")
#define TIMEMEASUREMENTENDBLOCKING() \
    WASM_TRACE2("THREAD", "end_block", "")

#else /* WASM_TRACE_LEVEL < 2 with WASM_TRACE_OVERRIDE — define as no-ops */

#define KONCLUCE_TASK_ALGORITHM_TIME_MEASURE_INSTRUCTION(a)
#define KONCLUCE_TASK_ALGORITHM_CLASH_STRING_INSTRUCTION(a)
#define KONCLUCE_TASK_ALGORITHM_MODEL_STRING_INSTRUCTION(a)
#define KONCLUCE_TASK_ALGORITHM_MERGING_DEBUGGING_INSTRUCTION(a)
#define KONCLUCE_TASK_ALGORITHM_VARIABLE_PROPAGATION_BLOCKING_DEBUGGING_INSTRUCTION(a)
#define SETTASKDESCRIPTION(a)
#define TIMEMEASUREMENTBEGINWAITING()
#define TIMEMEASUREMENTENDWAITING()
#define TIMEMEASUREMENTBEGINEXECUTION()
#define TIMEMEASUREMENTENDEXECUTION()
#define TIMEMEASUREMENTBEGINBLOCKING()
#define TIMEMEASUREMENTENDBLOCKING()

#endif /* WASM_TRACE_LEVEL >= 2 */
#endif /* WASM_TRACE_OVERRIDE */

#endif /* WASM_TRACE_H */
