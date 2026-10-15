// DetSched.h — deterministic cooperative scheduler for native debug runs (REPRO_SERIAL=1).
//
// Only one Konclude thread runs at a time (a baton). A thread gives the baton away only at a
// scheduling point: blocking on a primitive, yield, thread exit, or a seeded random preemption at
// lock/unlock. The next thread is chosen from the runnable set by a seeded RNG, so one seed = one
// schedule (REPRO_SCHED_SEED, REPRO_SCHED_PREEMPT=1/N preemption odds, default 8).
// Primitives (QMutex, QSemaphore, QWaitCondition, QReadWriteLock, CThread queues) are modelled
// logically on top of block()/wake(), so wake-up order never depends on OS timing.
// Timed waits use virtual time: a timeout fires only when nothing else is runnable.
// No runnable thread and no timer = deadlock: all thread states are printed and abort() is called.
// Compiled out unless NATIVE_DEBUG_BUILD (WASM build is untouched).
#pragma once
#ifdef NATIVE_DEBUG_BUILD
#include <pthread.h>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

namespace DetSched {

struct Th {
    int id = 0;
    std::string name;
    pthread_cond_t cv;
    bool done = false;
    bool runnable = true;
    const void* key = nullptr;       // what it is blocked on
    long long deadline = -1;         // virtual ms, -1 = none
    bool timedOut = false;
    uint64_t seq = 0;                // block order, FIFO wake-up
    Th() { pthread_cond_init(&cv, nullptr); }
};

struct State {
    pthread_mutex_t m = PTHREAD_MUTEX_INITIALIZER;
    std::vector<Th*> all;
    Th* cur = nullptr;
    bool enabled = false;
    uint64_t rng = 0, hash = 1469598103934665603ULL, evhash = 1469598103934665603ULL;
    uint64_t switches = 0, blockSeq = 0;
    long long vnow = 0;
    unsigned preemptOdds = 8;
    State() {
        const char* e = getenv("REPRO_SERIAL");
        enabled = e && *e && *e != '0';
        const char* s = getenv("REPRO_SCHED_SEED");
        rng = 0x9E3779B97F4A7C15ULL ^ (s ? strtoull(s, nullptr, 10) * 0xBF58476D1CE4E5B9ULL : 0);
        if (const char* p = getenv("REPRO_SCHED_PREEMPT")) preemptOdds = (unsigned)atoi(p);
    }
};

inline State& S() { static State s; return s; }
inline bool on() { return S().enabled; }
inline thread_local Th* tCur = nullptr;

inline uint64_t next(State& s) {   // splitmix64
    uint64_t z = (s.rng += 0x9E3779B97F4A7C15ULL);
    z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ULL;
    z = (z ^ (z >> 27)) * 0x94D049BB133111EBULL;
    return z ^ (z >> 31);
}

inline void dumpDeadlock(State& s) {
    fprintf(stderr, "DETSCHED DEADLOCK: no runnable thread, no timer (switches=%llu)\n", (unsigned long long)s.switches);
    for (Th* t : s.all)
        fprintf(stderr, "  thread %d %-28s %s key=%p\n", t->id, t->name.c_str(), t->done ? "done" : (t->runnable ? "runnable" : "blocked"), t->key);
    fflush(stderr);
    abort();
}

// Register the calling (already running) thread as the baton holder if nothing is registered yet.
inline Th* self() {
    if (tCur) return tCur;
    State& s = S();
    pthread_mutex_lock(&s.m);
    Th* t = new Th();
    t->id = (int)s.all.size(); t->name = "main";
    s.all.push_back(t);
    if (!s.cur) s.cur = t;
    tCur = t;
    pthread_mutex_unlock(&s.m);
    return t;
}

// Pick the next thread to run and hand the baton over. s.m held. `me` may be done/blocked/runnable.
// Returns when `me` holds the baton again (never waits if me is done).
inline void schedule(State& s, Th* me) {
    std::vector<Th*> run;
    for (;;) {
        run.clear();
        for (Th* t : s.all) if (t->runnable && !t->done) run.push_back(t);
        if (!run.empty()) break;
        long long best = -1;
        for (Th* t : s.all) if (!t->done && !t->runnable && t->deadline >= 0 && (best < 0 || t->deadline < best)) best = t->deadline;
        if (best < 0) dumpDeadlock(s);
        if (best > s.vnow) s.vnow = best;
        for (Th* t : s.all) if (!t->done && !t->runnable && t->deadline >= 0 && t->deadline <= s.vnow) { t->runnable = true; t->timedOut = true; t->key = nullptr; t->deadline = -1; }
    }
    Th* n = run[run.size() == 1 ? 0 : next(s) % run.size()];
    s.hash = (s.hash ^ (uint64_t)(n->id + 1)) * 1099511628211ULL;
    s.switches++;
    s.cur = n;
    if (n == me) return;
    pthread_cond_signal(&n->cv);
    if (me->done) return;
    while (s.cur != me) pthread_cond_wait(&me->cv, &s.m);
}

// Block on `key` until woken; timeoutMs >= 0 arms a virtual-time timeout. Returns true if timed out.
inline bool block(const void* key, long long timeoutMs = -1) {
    State& s = S(); Th* me = self();
    pthread_mutex_lock(&s.m);
    me->runnable = false; me->key = key; me->timedOut = false; me->seq = ++s.blockSeq;
    me->deadline = timeoutMs >= 0 ? s.vnow + timeoutMs : -1;
    schedule(s, me);
    bool to = me->timedOut; me->timedOut = false;
    pthread_mutex_unlock(&s.m);
    return to;
}

inline void wake(const void* key, bool all) {
    State& s = S();
    pthread_mutex_lock(&s.m);
    Th* first = nullptr;
    for (Th* t : s.all) {
        if (t->runnable || t->done || t->key != key) continue;
        if (all) { t->runnable = true; t->key = nullptr; t->deadline = -1; }
        else if (!first || t->seq < first->seq) first = t;
    }
    if (first) { first->runnable = true; first->key = nullptr; first->deadline = -1; }
    pthread_mutex_unlock(&s.m);
}

inline void yield() {
    State& s = S(); Th* me = self();
    pthread_mutex_lock(&s.m);
    schedule(s, me);
    pthread_mutex_unlock(&s.m);
}

// Seeded random preemption at sync points (lock/unlock/post).
inline void maybePreempt() {
    State& s = S();
    if (!s.preemptOdds) return;
    Th* me = self();
    pthread_mutex_lock(&s.m);
    bool go = s.all.size() > 1 && next(s) % s.preemptOdds == 0;
    if (go) schedule(s, me);
    pthread_mutex_unlock(&s.m);
}

inline long long vnow() { return S().vnow; }

// Called by the parent (baton holder) before pthread_create.
inline Th* spawn(const std::string& name) {
    State& s = S(); self();
    pthread_mutex_lock(&s.m);
    Th* t = new Th();
    t->id = (int)s.all.size(); t->name = name;
    s.all.push_back(t);
    pthread_mutex_unlock(&s.m);
    return t;
}
// First call in the new OS thread: park until scheduled.
inline void childStart(Th* t) {
    State& s = S();
    tCur = t;
    pthread_mutex_lock(&s.m);
    while (s.cur != t) pthread_cond_wait(&t->cv, &s.m);
    pthread_mutex_unlock(&s.m);
}
// Last call in the OS thread: wake joiners, hand the baton on.
inline void finish(Th* t) {
    State& s = S();
    pthread_mutex_lock(&s.m);
    t->done = true; t->runnable = false;
    for (Th* j : s.all) if (!j->runnable && !j->done && j->key == t) { j->runnable = true; j->key = nullptr; j->deadline = -1; }
    schedule(s, t);
    pthread_mutex_unlock(&s.m);
}
inline void join(Th* t) { while (!t->done) block(t); }

inline void note(uint64_t v) { State& s = S(); s.evhash = (s.evhash ^ v) * 1099511628211ULL; }
inline void report(const char* label) {
    State& s = S();
    if (s.enabled) fprintf(stderr, "SCHEDTRACE %s switches=%llu sched=%016llx events=%016llx threads=%zu vnow=%lld\n", label,
                           (unsigned long long)s.switches, (unsigned long long)s.hash, (unsigned long long)s.evhash, s.all.size(), s.vnow);
}

}  // namespace DetSched
#else
// Non-native (WASM) build: inert stubs so the shim code compiles unchanged; on() is always false.
namespace DetSched {
struct Th {};
constexpr bool on() { return false; }
inline Th* self() { return nullptr; }
inline bool block(const void*, long long = -1) { return false; }
inline void wake(const void*, bool) {}
inline void yield() {}
inline void maybePreempt() {}
inline long long vnow() { return 0; }
}  // namespace DetSched
#endif
