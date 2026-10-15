// KonStall.h — cheap process-wide activity accounting used to detect a stalled reasoning call.
//
// A stall (observed in WASM, ~1 in 3 second large materialize calls) leaves the caller waiting
// for the pipeline while no tableau task is being processed and no thread completes an event
// (a handler may even sit blocked inside an event, so "event in progress" must not count as busy).
// `gBusy` counts tableau tasks being processed (a long single test is legitimate work);
// `gLastMs` is the time any task or event last finished/started. Stall = no task in progress and
// no activity for the threshold.
#pragma once
#include <atomic>
#include <chrono>
#include <cstdio>

namespace KonStall {

inline std::atomic<int> gBusy{0};
inline std::atomic<long long> gLastMs{0};
inline std::atomic<long long> gThresholdMs{60000};       // before any task ran in this wait (preprocessing, ...)
inline std::atomic<long long> gFastThresholdMs{8000};     // once tasks are flowing: a gap this long is abnormal
inline std::atomic<long long> gTasksSinceWait{0};
inline std::atomic<bool> gStalled{false};

inline long long nowMs() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now().time_since_epoch()).count();
}

struct Scope {
    Scope() { gBusy.fetch_add(1, std::memory_order_relaxed); gTasksSinceWait.fetch_add(1, std::memory_order_relaxed); }
    ~Scope() {
        gLastMs.store(nowMs(), std::memory_order_relaxed);
        gBusy.fetch_sub(1, std::memory_order_relaxed);
    }
};

inline void touch() { gLastMs.store(nowMs(), std::memory_order_relaxed); }

// Event bracket: only timestamps (see above).
struct EventTouch {
    EventTouch() { touch(); }
    ~EventTouch() { touch(); }
};

// Call at the start of a blocking wait: the clock starts now.
inline void beginWait() { gStalled.store(false); gTasksSinceWait.store(0); gLastMs.store(nowMs()); }

// True when nothing has been busy for longer than the threshold (0 disables detection).
inline bool stallDetected() {
    long long th = gThresholdMs.load();
    if (th <= 0 || gBusy.load() != 0) return false;
    // Once tableau tasks have been flowing during this wait (classification / realization phase),
    // a gap without any task or event is abnormal long before the generic threshold.
    long long fast = gFastThresholdMs.load();
    if (gTasksSinceWait.load() > 0 && fast > 0 && fast < th) th = fast;
    long long idle = nowMs() - gLastMs.load();
    if (idle <= th) return false;
    fprintf(stderr, "{warn} KonStall: no task or event completed for %lld ms (threshold %lld ms, %lld tasks this wait); declaring stall\n", idle, th, (long long)gTasksSinceWait.load());
    gStalled.store(true);
    return true;
}

} // namespace KonStall
