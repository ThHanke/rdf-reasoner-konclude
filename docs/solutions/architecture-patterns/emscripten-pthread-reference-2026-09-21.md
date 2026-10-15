---
title: "Emscripten/WASM pthread reference: thread safety, performance, and pitfalls"
date: 2026-09-21
category: docs/solutions/architecture-patterns/
module: wasm-threading
problem_type: architecture_pattern
component: tooling
severity: informational
applies_when:
  - Writing or reviewing C++ code compiled to WASM with USE_PTHREADS=1
  - Porting a native multi-threaded C++ system to Emscripten
  - Debugging deadlocks, hangs, or data races in WASM builds
  - Evaluating synchronization primitive choices (mutex vs atomic vs semaphore)
tags:
  - wasm
  - emscripten
  - pthreads
  - concurrency
  - memory-ordering
  - thread-safety
  - reference
---

# Emscripten/WASM pthread reference: thread safety, performance, and pitfalls

This document covers the rules, rationale, and WASM-specific caveats for correct and
performant pthread usage in a C++ codebase compiled with Emscripten. It is written for
a project using `USE_PTHREADS=1`, `PTHREAD_POOL_SIZE=8`, `PTHREAD_POOL_SIZE_STRICT=2`,
`MALLOC=mimalloc`, and `ALLOW_BLOCKING_ON_MAIN_THREAD=1`.

---

## 1. Thread-safe data sharing

### 1.1 `std::atomic` vs plain variables

A plain (non-atomic) variable written by one thread and read by another is a data race.
Under the C++ memory model, a data race produces **undefined behaviour** — the compiler
may cache the value in a register, generate torn reads on non-word-aligned accesses, or
elide the write entirely. This is true even for `bool` and `int` on x86, which are
naturally atomic at the hardware level, because the C++ standard operates above the ISA.

Rule: any variable whose lifetime spans more than one thread and that is written on at
least one of them must be declared `std::atomic<T>` (or guarded by a mutex). There are
no safe shortcuts.

### 1.2 Memory ordering: which order to choose

The C++11 memory model defines six orderings. For practical use, three matter:

**`memory_order_relaxed`**
Guarantees only that the atomic operation itself is indivisible — no ordering constraints
on surrounding accesses. Suitable for independent counters and statistics where the only
requirement is that no torn value is observed. Never sufficient for a flag that gates
visibility of other data.

Example safe use: incrementing a statistics counter from multiple threads where the exact
count observed by a reader is not critical.

**`memory_order_acquire` / `memory_order_release`** (paired)
A `release` store guarantees that all writes in the storing thread that precede it are
visible to any thread that then performs an `acquire` load and observes the stored value.
This is the correct ordering for a classic producer-consumer flag: writer sets data, then
does `flag.store(true, release)`; reader does `while (!flag.load(acquire))` and then
reads data. No extra fence is required and performance is better than `seq_cst` on ARM.

**`memory_order_seq_cst`** (the default)
Establishes a single total modification order across all `seq_cst` atomic operations on
all threads. Necessary only when multiple producers and multiple consumers must agree on
the order of writes to *different* atomic variables. Has a full memory fence cost on all
multicore architectures; on x86 this is cheap (mfence only on stores), on ARM it is more
expensive. The default for `std::atomic<T>::store/load` when no order is specified.

Decision rule:
- Counter with no dependent reads → `relaxed`
- Single flag that gates visibility of other data → `release` on write, `acquire` on read
- Multiple atomic variables whose relative order must be observed consistently → `seq_cst`

### 1.3 When a mutex is needed vs when atomics suffice

Atomics suffice when:
- The operation fits in one machine word (or the atomic type is lock-free for the target)
- The invariant involves a single variable (or a pair that can be packed into one word)
- The update can be expressed as a single compare-and-swap or fetch-add

A mutex is required when:
- A logical invariant spans multiple variables that must be updated atomically as a group
- The critical section involves non-atomic operations (e.g., pointer chasing, list
  traversal, memory allocation)
- Correctness requires that a sequence of reads and conditional writes be atomic

Trying to build a multi-variable invariant from atomics alone — without a mutex — results
in complex lock-free algorithms that are error-prone and hard to verify. Reserve lock-free
structures for hot paths where profiling demonstrates that mutex contention is a problem.

### 1.4 False sharing and cache-line alignment

False sharing occurs when two threads write to different variables that happen to occupy
the same cache line (typically 64 bytes on x86-64, 128 bytes on Apple M-series). The
hardware cache coherency protocol forces the line to be invalidated and re-fetched on
every write, serialising what should be independent operations. The symptom is linear
scaling with thread count replaced by near-serial execution.

C++17 provides `std::hardware_destructive_interference_size` (header `<new>`) to query
the appropriate alignment. Use `alignas` to force separation:

```cpp
#ifdef __cpp_lib_hardware_interference_size
    using std::hardware_destructive_interference_size;
#else
    constexpr std::size_t hardware_destructive_interference_size = 64;
#endif

struct PerThreadCounter {
    alignas(hardware_destructive_interference_size) std::atomic<int64_t> value{0};
};
```

In WASM the WebAssembly memory model is sequentially consistent at the hardware level
(all shared accesses are visible in program order across threads by design), but false
sharing still applies because Emscripten threads are real Web Workers sharing a
`SharedArrayBuffer` and the browser's underlying hardware cache coherency still operates.
Align hot per-thread data structures to cache line boundaries.

---

## 2. Event queue / message passing patterns

### 2.1 Lock-free vs mutex-based FIFO

A mutex-guarded `std::deque` with a condition variable is the correct default. It is:
- Correct with straightforward reasoning
- Free of ABA problems and epoch management complexity
- Efficient enough for any queue depth above a few hundred messages per second

Lock-free queues (e.g., a Michael-Scott queue with `std::atomic<Node*>`) should be
adopted only after profiling shows that mutex contention on the queue is a measured
bottleneck. Lock-free algorithms require rigorous memory ordering analysis at every
CAS site; a single missed `acquire` on a load produces a race that is reproducible
only under high thread counts or specific CPU microarchitectures.

In WASM, the cost of the futex-based mutex (`pthread_mutex_lock`) is a JS runtime call
via `Atomics.wait`/`Atomics.notify`. This is measurably slower than native but the
relative cost between mutex-based and lock-free approaches is similar to native — the
absolute latency floor is higher. Do not pre-optimise.

### 2.2 Producer-consumer: semaphore vs condition variable

Both are correct. The practical differences:

**Semaphore (`sem_t`)**
- Count semantics: `sem_post` increments; `sem_wait` decrements (blocks at zero)
- No associated mutex; count accumulates while no consumer is waiting
- Slightly lower overhead per wakeup — one syscall vs lock + signal + unlock
- Count semantics are useful when producers can outrun consumers intermittently

**Condition variable (`pthread_cond_t` + `pthread_mutex_t`)**
- Requires a predicate loop to guard against spurious wakeups
- No built-in count; the predicate must encode the queue-non-empty check
- `pthread_cond_signal` while holding the mutex causes the woken thread to immediately
  re-contend for the mutex — call `signal` after `unlock` to avoid the gratuitous
  lock bounce (some implementations optimise this, but it is not guaranteed)

For a simple work queue with persistent worker threads, a counting semaphore is the
cleaner abstraction: post once per item enqueued, wait once per item consumed, no
spurious wakeup handling required.

### 2.3 Cost in WASM

Both `sem_wait` and `pthread_cond_wait` reduce to `Atomics.wait` on the underlying
`SharedArrayBuffer` word (futex). In a Web Worker the JS engine may block the worker
thread at `Atomics.wait` — this is permitted and correct. The wakeup path goes through
`Atomics.notify` → futex wakeup → scheduler run queue → WASM resume. Empirically this
is in the range of tens to low hundreds of microseconds in Node.js worker context,
compared to single-digit microseconds for native futex wakeup.

The implication: avoid designs where correctness requires sub-10µs synchronization
latency. For reasoning tasks (multi-millisecond to multi-second latency), this is
irrelevant.

### 2.4 Synchronous in-place processing vs async postEvent

The Konclude `CThread` model uses asynchronous `postEvent`: the caller enqueues an event
and returns; the worker thread dequeues and processes later. This is the correct model
for an actor system. However, it has a hazard (see Section 6.1 on stale pointer capture).

For WASM-specific correctness, all `CThread` event queues must use synchronous mode
(i.e., the posting thread blocks until the event is processed) in configurations where
the system must not re-enter the JS event loop mid-computation. If any handler performs
a blocking wait on another actor's response, and all actors are on the same thread pool
with no spare worker to process the response, the system deadlocks. The `PTHREAD_POOL_SIZE=8`
setting gives 8 workers; if 8 actors each block waiting for a 9th, there is no worker
available to process the 9th's queue.

---

## 3. Semaphore usage (`sem_t`)

### 3.1 `sem_timedwait` availability in Emscripten

Emscripten's musl-based libc implements `sem_wait` by calling `sem_timedwait` internally.
Both are available when compiled with `-pthread`. Named semaphores (`sem_open`,
`sem_unlink`) are NOT supported — use unnamed semaphores (`sem_init`) only.

`sem_timedwait` takes an **absolute** `struct timespec` (CLOCK_REALTIME epoch), not a
relative timeout. Get the current time with `clock_gettime(CLOCK_REALTIME, &ts)` and add
the desired delta.

### 3.2 Emscripten-specific limitations

Emscripten implements semaphores on top of futexes via `Atomics.wait`. This means:
- `sem_wait` on the main browser thread will NOT block — the main thread cannot call
  `Atomics.wait`. It will busy-wait instead, consuming 100% of the main thread's JS event
  loop time and preventing proxied calls from other workers from completing. This causes
  deadlocks in typical usage patterns.
- `sem_wait` on a Worker thread (i.e., on any thread created by `pthread_create`) works
  correctly.

The project uses `ALLOW_BLOCKING_ON_MAIN_THREAD=1`, which suppresses the error but does
not fix the busy-wait problem. Never call `sem_wait` (or `pthread_mutex_lock` for an
uncontested period) from the main browser thread in a long-running block.

### 3.3 `tryAcquire` patterns for draining stale semaphore counts

When a worker thread is reset while its semaphore has accumulated a count > 0 (because
events were posted before the reset), the next `sem_wait` after reset returns immediately
with the stale count — causing the thread to process garbage events or loop unexpectedly.

Drain pattern: after stopping event processing and before re-initializing, drain the
semaphore:

```cpp
while (sem_trywait(&mSemaphore) == 0) { /* drain */ }
```

`sem_trywait` returns `EAGAIN` immediately when count is zero. This pattern is
necessary whenever a semaphore is reused across logical lifetimes. The sequential
classify() hang fix (memory entry: project_sequential_call_fix.md) was resolved
exactly by draining stale semaphore counts before re-use.

---

## 4. Emscripten-specific constraints

### 4.1 `fflush(stderr)` deadlock in pthreads — why it happens

Emscripten proxies stdio writes from worker threads to the main browser thread. The musl
C library's `fflush` acquires a per-file lock via `flockfile` (the `__lockfile` internal
function) and then performs a write. When this happens concurrently from two threads —
or when the main thread is blocked on a futex while a worker is trying to proxy a write —
the file lock and the futex interact to produce a deadlock:

1. Worker W holds `flockfile(stderr)` and issues `_fd_write()`, which must proxy to the
   main thread.
2. The main thread is blocked in `Atomics.wait` (or in busy-wait) and cannot process the
   proxy queue.
3. W waits for the proxy to complete, holding the file lock.
4. If the main thread (when it eventually runs) also tries to write to stderr, it calls
   `flockfile(stderr)`, which blocks on the lock held by W. Circular wait → deadlock.

**Rule: never call `fflush(stderr)` or `fflush(stdout)` from a pthread.** Use
`fprintf(stderr, "...\n")` without a subsequent `fflush`. The trailing newline triggers
line-buffered flush in musl without acquiring the lock for a separate flush call. If
unbuffered output is required, use `write(STDERR_FILENO, buf, len)` directly (bypasses
musl's locking entirely).

This is a project-wide constraint documented in memory entry `feedback_fflush_deadlock_in_pthreads.md`.

### 4.2 `PROXY_TO_PTHREAD` implications

`PROXY_TO_PTHREAD` moves `main()` to a dedicated Worker, leaving the main browser thread
to run only the JS event loop and proxy dispatch. Benefits:
- `pthread_create` and `pthread_join` are safe from the main thread (it never blocks)
- DOM access from workers is proxied automatically
- Eliminates the class of deadlocks where the main thread blocks while workers proxy to it

Costs and constraints:
- All global C++ constructors and `main()` now run in a Worker context, not the browser
  main thread. Code that calls JS-only APIs (WebGL, canvas, etc.) must explicitly proxy
  to the main thread.
- `pthread_create` from within `PROXY_TO_PTHREAD`'s main thread still requires pool
  capacity. If the pool is exhausted (see 4.3), the newly created thread cannot start
  until a worker becomes free.
- Thread startup latency increases slightly because creation must be proxied to the main
  thread (which then delegates to the pool).

This project does NOT use `PROXY_TO_PTHREAD`. The current build works correctly without
it because the call path enters WASM from a JS Worker (the TypeScript RdfReasoner
wraps the WASM in a dedicated Worker), so the "main browser thread" is already a Worker.
`PROXY_TO_PTHREAD` would be needed only if the WASM were loaded directly on the page's
main thread.

### 4.3 `PTHREAD_POOL_SIZE_STRICT=2` — behavior on exhaustion

With `PTHREAD_POOL_SIZE_STRICT=2`, attempting to create a thread when all pool workers
are occupied causes Emscripten to throw a JavaScript exception immediately rather than
silently deadlocking (which is what `STRICT=0` does). The exception surfaces as a WASM
trap in the calling thread.

The pool size is `PTHREAD_POOL_SIZE=8`. If the Konclude scheduler attempts to create a
9th concurrent thread, the application will crash with a pool exhaustion error. Current
behaviour: the KPSet classifier and its parallel test runners use up to ~8 threads
concurrently, so the limit is tight. If new thread types are added, increase the pool
size or ensure older threads have exited before new ones are created.

Memory scaling: each Worker in the pool reserves its own JS heap and WASM stack.
Empirically, 8 workers in Node.js consumes roughly 200–400 MB of process memory.
Do not increase the pool size without profiling memory.

### 4.4 `SharedArrayBuffer` / `Atomics.wait` restrictions

**Node.js worker context:** `Atomics.wait` is permitted inside Node.js `Worker` threads
(created by `worker_threads`). The TypeScript layer creates one `Worker` that loads the
WASM module; all Konclude C++ threads run as pthreads inside that single Worker process.
This is the correct configuration — there is no `Atomics.wait` restriction in this
context.

**Browser main thread:** `Atomics.wait` is forbidden on the browser's main thread
(synchronous blocking is not allowed). `Atomics.waitAsync()` (Promise-based, resolved
Baseline 2025) is permitted but requires restructuring the blocking call into a
Promise chain. Any code path that reaches `pthread_mutex_lock`, `sem_wait`, or
`pthread_cond_wait` from the browser main thread will busy-wait (wasting CPU) or
deadlock (if the proxy queue is involved).

**Browser deployment:** SharedArrayBuffer requires the response headers:
```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```
Without these headers, SharedArrayBuffer is undefined and `USE_PTHREADS` silently fails.

### 4.5 Thread-local storage (`thread_local` / `__thread`)

Both `thread_local` (C++11) and `__thread` (GNU extension) are supported in Emscripten
for both pthreads and Wasm Workers. Implementation:
- TLS variables are placed in a `.tdata` segment with offsets from `__tls_base`
- Emscripten uses the **local-exec** TLS model exclusively (dynamic linking with threads
  is not supported)
- Workers are reused across multiple logical pthreads (a Worker runs one pthread to
  completion, then is returned to the pool and may run another). Emscripten tracks
  whether TLS has been dynamically allocated for a reused Worker via a thread-local
  WebAssembly global `g_needs_dynamic_alloc`; re-initialisation happens automatically

Practical consequence: TLS works correctly across pthread reuse. However, TLS
destructors (`pthread_key_create` with a destructor, or `thread_local` objects with
non-trivial destructors) are called when the logical pthread exits, not when the Worker
exits. Code that stores raw pointers in TLS and frees them in the destructor is safe.
Code that stores raw pointers to TLS data that it shares externally (e.g., a pointer to
a `thread_local CacheNode` stashed in a global index) is not safe — the pointer becomes
dangling when the pthread exits and the Worker is recycled.

---

## 5. Performance: thread creation and reuse

### 5.1 Cost of `pthread_create` in Emscripten

Each `pthread_create` maps to one JavaScript Web Worker. Worker creation is asynchronous
and expensive — it requires the browser/Node.js to:
1. Allocate a new VM isolate (or OS thread backing the Worker)
2. Load and parse the WASM module (mitigated by `WebAssembly.Module` sharing)
3. Initialize the Emscripten runtime in the new Worker

Without a pre-warmed pool, `pthread_create` may not start the thread before the calling
code returns to the event loop. With `PTHREAD_POOL_SIZE=8`, Emscripten pre-creates 8
Workers before `main()` runs. `pthread_create` then takes a Worker from the pool and
dispatches to it without waiting for Worker startup — startup latency is eliminated for
the first 8 concurrent threads.

Rule: never create threads in a hot path. Thread creation is a one-time cost per logical
task, not a per-event cost.

### 5.2 Thread pool reuse vs create-per-task

The Konclude architecture creates threads once at startup (one per `CThread` subclass)
and reuses them for the lifetime of the session. This is the correct approach in WASM.
Avoid designs that create and join a thread per reasoning request.

If a thread must be torn down between requests (e.g., to reset state), prefer sending a
"reset" event to the persistent thread rather than destroying and recreating it. Joins
across logical calls drain the semaphore (Section 3.3) and restart from a clean state.

### 5.3 Spinning vs blocking for short-lived tasks

Spinning (busy-waiting on an atomic flag) avoids the wakeup latency of a futex but burns
CPU continuously. In WASM, spinning on a Worker burns a full hardware thread and may
starve other Workers sharing the same CPU core.

Guidelines:
- Spin for at most a few hundred iterations (nanosecond-scale expected wait) before
  falling back to a futex-based block
- Never spin in a Worker that might need to process proxy calls from the main thread
- Never spin in the Emscripten main thread (blocks the JS event loop)

The KPSet classifier's internal test runners use spin-wait for classification probes
(very short waits). This is acceptable because these run exclusively on Worker threads
with `PTHREAD_POOL_SIZE=8` providing dedicated cores.

### 5.4 Wakeup latency comparison

From fastest to slowest in WASM/Node.js worker context:

1. **Busy-wait on `std::atomic`**: sub-microsecond polling cycle, 100% CPU utilisation
2. **`Atomics.wait` + `Atomics.notify`** (futex): ~10–100 µs wakeup latency in Node.js
3. **`sem_post`/`sem_wait`** (musl → futex): same underlying mechanism as (2), similar
   latency
4. **`pthread_cond_signal`/`pthread_cond_wait`** (musl → futex + mutex unlock sequence):
   adds one extra mutex acquire on the woken thread; ~15–150 µs total
5. **`pthread_create` (new worker from pool)**: ~1–5 ms in Node.js even from pool

For the reasoning workloads in this project (millisecond-to-second latency), options
(2)–(4) are all equivalent. The gap matters only for fine-grained parallel algorithms
(e.g., KPSet's test-and-set inner loop) where the per-probe latency must be under 10 µs.

---

## 6. Common pitfalls

### 6.1 Capturing raw pointers in lambdas/events posted to threads

Symptom: correct results in serial mode, sporadic wrong results or crashes when async
event posting is enabled.

Pattern that fails:

```cpp
// Caller stack:
SomeObject obj = buildObject();
workerThread->postEvent([&obj]() { use(obj); }); // captures reference to local!
// obj is destroyed when this scope exits; lambda executes later on worker thread
```

Rule: events posted to threads must own their data. Options:
- Copy the value into the lambda capture by value
- Store in a `shared_ptr` and capture the `shared_ptr`
- Allocate on the heap and document the ownership transfer

When the event is posted as a raw pointer to an object on the caller's stack, and the
caller returns before the worker dequeues the event, the pointer is dangling. WASM does
not protect against this — the memory remains accessible but contains the next frame's
data, producing silent corruption.

### 6.2 Singleton caches keyed by raw pointer — reuse detection

Pattern: a cache maps `SomeClass* key → CachedResult* value`. The key is a pointer
to a long-lived object. If the object is freed and a new object is allocated at the same
address, the cache returns a stale result for the new object.

This is the raw-pointer singleton cache hazard documented in
`project_ontology_lifetime_singleton_cache.md`. In WASM with mimalloc, the allocator is
aggressive about reusing freed addresses, making this hazard more likely than in native
builds with ASLR and a less aggressive allocator.

Mitigations:
- Clear the relevant cache entries during object destruction (destructor must be called)
- Use a monotonically increasing generation counter as part of the key
- Replace raw pointer keys with `std::shared_ptr` (pointer + control block address forms
  a unique key even after reuse)

### 6.3 Unguarded iteration of a linked list while another thread appends

Pattern: a linked list stores registered observers or role linkers. Thread A iterates the
list from `head` to `tail`. Thread B appends a new node by writing `tail->next = newNode`
and then `tail = newNode`. If Thread A reads `tail->next` between the two writes on
Thread B, it sees the new node but with a null `next` — iteration terminates prematurely.

The saturation role-linker pattern in Konclude (`getIndirectSuperRoleList()`) is
documented as safe because the list is fully constructed during preprocessing and frozen
before saturation begins. Appending to any list that is concurrently iterated in
saturation requires an explicit memory barrier (`release` on append, `acquire` on
`next` load) or a read-write mutex.

### 6.4 Recursive lock hazard on `mDirectUpdateSyncMutex`

A non-recursive `pthread_mutex_t` (type `PTHREAD_MUTEX_NORMAL` or `PTHREAD_MUTEX_DEFAULT`)
will deadlock immediately if the same thread attempts to lock it twice. A `PTHREAD_MUTEX_RECURSIVE`
allows re-entry but increments a lock count that must be decremented by an equal number of
unlocks — forgetting one unlock leaves the mutex permanently locked from other threads'
perspectives.

If `mDirectUpdateSyncMutex` is locked in a function that may call back into the same
function (directly or via a callback chain), it must be declared `PTHREAD_MUTEX_RECURSIVE`.
Alternatively, refactor to use a non-reentrant guard: extract the mutex-protected section
into a private method, lock once in the public method, and call only the private method
from within the lock.

The `pthread_mutex_trylock` pattern can detect accidental re-entry in debug builds:

```cpp
if (pthread_mutex_trylock(&mMutex) == EBUSY) {
    // already locked by this thread — logic error
    assert(false && "recursive lock detected");
}
```

`PTHREAD_MUTEX_ERRORCHECK` type provides this detection automatically (returns `EDEADLK`
on re-entry) at a small overhead cost; useful during development.

### 6.5 Thread pool exhaustion deadlock (STRICT=2 saves from silent hang)

With `PTHREAD_POOL_SIZE_STRICT=2`, pool exhaustion throws rather than hanging. Without
it, the program silently blocks: `pthread_create` waits for a pool Worker to become
free, but all Workers are blocked waiting for results from the thread that `pthread_create`
is trying to start — a classic resource deadlock.

Diagnosis: if you see a WASM trap with a message about thread pool exhaustion, audit
the maximum concurrent thread count under the failing workload. Either:
- Increase `PTHREAD_POOL_SIZE` (costs memory)
- Ensure threads complete and are joined before new ones are created
- Redesign to queue work rather than creating a thread per work item

### 6.6 `pthread_mutex_lock` on main browser thread

Although `ALLOW_BLOCKING_ON_MAIN_THREAD=1` suppresses the Emscripten error, any mutex
contention on the main browser thread becomes a busy-wait loop in JS rather than a
kernel-level block. A long-held mutex in a worker will cause the main browser thread to
spin at 100% CPU, freeze the page, and prevent proxied calls from completing — which
may itself prevent the mutex-holding worker from making progress. Always release mutexes
quickly; never hold a mutex across a blocking I/O call or a `sem_wait`.

---

## Quick reference: decision matrix

| Situation | Recommended primitive |
|---|---|
| Independent counter across threads | `std::atomic<int64_t>` with `relaxed` |
| Single flag gating data visibility | `std::atomic<bool>` with `release`/`acquire` |
| Multi-variable invariant | `pthread_mutex_t` (non-recursive) |
| Work queue with persistent workers | `sem_t` (unnamed, `sem_init`) |
| Complex condition on queue | `pthread_cond_t` + `pthread_mutex_t` |
| Per-thread state | `thread_local` |
| Hot per-thread counters | `alignas(hardware_destructive_interference_size)` + `std::atomic` |
| Thread creation | From pool only; never in hot path |
| Debug re-entry detection | `PTHREAD_MUTEX_ERRORCHECK` in dev builds |
| stdio from worker threads | `fprintf` with `\n`; no `fflush` |

---

## Sources

- [Emscripten pthreads documentation](https://emscripten.org/docs/porting/pthreads.html)
- [Emscripten: Writing to stdout can deadlock with pthreads — Issue #20059](https://github.com/emscripten-core/emscripten/issues/20059)
- [Emscripten: Deadlock on exit if secondary threads write to stdout — Issue #15186](https://github.com/emscripten-core/emscripten/issues/15186)
- [Emscripten: flockfile causes deadlock across threads — Issue #5402](https://github.com/emscripten-core/emscripten/issues/5402)
- [Emscripten: Thread pool exhausted error — Issue #14336](https://github.com/emscripten-core/emscripten/issues/14336)
- [Emscripten: PTHREAD_POOL_SIZE_STRICT=0 does not call entry — Issue #16691](https://github.com/emscripten-core/emscripten/issues/16691)
- [Emscripten: Deadlock with PROXY_TO_PTHREAD — Issue #22442](https://github.com/emscripten-core/emscripten/issues/22442)
- [Pthread Implementation — emscripten-core/emscripten DeepWiki](https://deepwiki.com/emscripten-core/emscripten/6.1-pthread-implementation)
- [std::memory_order — cppreference.com](https://en.cppreference.com/cpp/atomic/memory_order)
- [std::hardware_destructive_interference_size — cppreference.com](https://en.cppreference.com/w/cpp/thread/hardware_destructive_interference_size.html)
- [Implementing a Thread-Safe Queue using Condition Variables — Just Software Solutions](https://www.justsoftwaresolutions.co.uk/threading/implementing-a-thread-safe-queue-using-condition-variables.html)
- [sem_wait(3) / sem_timedwait(3) — Linux manual page](https://man7.org/linux/man-pages/man3/sem_timedwait.3.html)
- [pthread_mutex_lock — POSIX specification](https://pubs.opengroup.org/onlinepubs/009604499/functions/pthread_mutex_lock.html)
- [Atomics.waitAsync — MDN](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Atomics/waitAsync)
- [LLVM: WebAssembly TLS local-exec model — D64537](https://reviews.llvm.org/D64537)
- [WebAssembly Shared-Everything Threads proposal](https://github.com/WebAssembly/shared-everything-threads/blob/main/proposals/shared-everything-threads/Overview.md)
