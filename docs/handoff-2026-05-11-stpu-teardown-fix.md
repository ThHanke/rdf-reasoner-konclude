# Handoff: Fix STPU teardown crash

## Project overview

Port Konclude OWL-DL tableau reasoner kernel to WebAssembly. Exposes `KoncludeReasoner` (C++/Embind) with `loadNTriples()`, `classify()`, `getInferredNTriples()`. WASM built via Emscripten + CMake. Qt replaced via shims in `src/compat/QtCompat.h` and overrides in `src/compat/overrides/`.

## What works

- Build: `docker compose run --rm build` produces `dist/konclude.mjs` + `dist/konclude.wasm`
- Smoke test: `docker compose run --rm smoke-test` (runs `tests/smoke/smoke.mjs`)
- **PASS**: 3-class transitivity test
- **CRASH**: LUBM, GALEN, Roberts Family — all fail immediately after `classify()` returns

## The crash

```
RangeError: WebAssembly.Table.get(): invalid index 1919888947 into function table
  at invoke_ii
  at wasm-function[2885]   ← CSingleThreadTaskProcessorUnit::completeTask()
  at wasm-function[2938]   ← mCallbackExecuter->executeCallback() virtual dispatch
  at wasm-function[11616]  ← STPU event processing
```

`1919888947 = 0x72616E73 = "rans"` — freed memory (mimalloc debug pattern). `mCallbackExecuter` is a use-after-free.

## Root cause (confirmed)

**Race**: STPU thread fires the last task callback → that callback posts to the classifier thread → classifier unblocks `prepareOntology()` → `classify()` returns → JS calls `reasoner.delete()` → `~Impl()` deletes `mReasonerManager` → `mCallbackExecuter` is freed. Meanwhile STPU thread is still inside `completeTask()` and calls `mCallbackExecuter->executeCallback()` → crash.

Key code path:
- `src/KoncludeReasoner.cpp:296` — `mImpl->mReasonerManager->prepareOntology(...)` (blocks, returns when classified)
- `src/compat/overrides/CSingleThreadTaskProcessorUnit.cpp:508-558` — `completeTask()` iterates callbacks and calls `mCallbackExecuter->executeCallback()`
- `vendor/konclude/Source/Reasoner/Kernel/Calculation/CConfigDependedCalculationEnvironmentFactory.cpp:90` — creates `callbackExecuter`
- `vendor/konclude/Source/Reasoner/Kernel/Calculation/CConcurrentTaskCalculationEnvironment.cpp:47-50` — destructor deletes `mProcessorUnitList` (STPU) but NOT `mCallbackExecuter`; `mCallbackExecuter` is freed elsewhere (factory), possibly before STPU thread is joined

`~CThread()` does call `pthread_join` (line 76 in `src/compat/overrides/CThread.cpp`), but the join happens AFTER `mCallbackExecuter` is already freed — too late.

## The fix

**Add a quiesce wait in `classify()`**: after `prepareOntology()` returns, wait until the STPU thread has returned to its blocking state (no longer inside `completeTask()`). Only then return to JS.

### Approach A — idle semaphore in STPU (preferred)

In `src/compat/overrides/CSingleThreadTaskProcessorUnit.cpp`:

1. Add a static map: `static std::unordered_map<CSingleThreadTaskProcessorUnit*, QSemaphore*> sIdleSems;`
2. In constructor, insert `new QSemaphore(0)` into the map for `this`
3. In destructor, remove and delete from map
4. In `processingLoop()`, just BEFORE `mProcessingWakeUpSemaphore.acquire(1)` (line ~293), add: `sIdleSems[this]->release()`
5. Expose a free function: `QSemaphore* stpuGetIdleSemaphore(CSingleThreadTaskProcessorUnit*)`

In `src/KoncludeReasoner.cpp`, after `prepareOntology()` returns:
- Get the STPU via `WasmReasonerManagerThread` → expose `getCalculationManager()` accessor → cast to `CConcurrentTaskCalculationEnvironment*` → call `getSingleTaskProcessorUnit()`
- Wait: `stpuGetIdleSemaphore(stpu)->acquire()`

Or simpler: expose STPU from `WasmReasonerManagerThread::getStpu()` directly.

### Approach B — sleep (quick hypothesis test first)

In `src/KoncludeReasoner.cpp:296`, after `prepareOntology()` returns:
```cpp
usleep(10000); // 10ms — let STPU thread finish completeTask() and return to wait
```
If this makes LUBM pass, the race hypothesis is confirmed. Then replace with approach A.

## Key files

| File | Role |
|------|------|
| `src/KoncludeReasoner.cpp` | Main API — fix goes here (add quiesce after line 296) |
| `src/compat/overrides/CSingleThreadTaskProcessorUnit.cpp` | STPU override — add idle semaphore here |
| `src/compat/overrides/CThread.cpp` | CThread pthreads impl — already correct |
| `src/compat/QtCompat.h` | Qt shims — QSemaphore is real pthreads mutex+condvar |
| `emscripten.cmake` | Build flags — INITIAL_MEMORY=1073741824 (1GB, needed for Roberts) |
| `patches/001-all-wasm-changes.patch` | Vendor patches — applied at cmake configure time |
| `tests/smoke/smoke.mjs` | Smoke test — run all 4 ontologies |
| `docker-compose.yml` | `build` and `smoke-test` services |

## Architecture notes

- STPU = `CSingleThreadTaskProcessorUnit` — the Konclude task processor. Original Konclude code. Our override restores the semaphore-blocking (`mProcessingWakeUpSemaphore`) that the patch replaced with cooperative `processingLoop()` calls. The override IS needed for pthreads.
- `CThread` override: each CThread gets its own `pthread_t` with per-thread mutex/condvar event queue. `~CThread()` calls `stopThread(true)` → `pthread_join`.
- `QSemaphore` in `QtCompat.h`: backed by `pthread_mutex_t` + `pthread_cond_t` + counter.
- Build: Docker container with Emscripten 3.x. `scripts/build-raptor-wasm.sh` builds librdf/raptor first, then emmake builds Konclude kernel.

## How to build and test

```bash
# Build
docker compose run --rm build bash -c "emmake make -C build -j4 > /src/build.log 2>&1"
cat build.log

# Smoke test (all 4 ontologies)
docker compose run --rm smoke-test bash -c "node tests/smoke/smoke.mjs > /src/smoke.log 2>&1"
cat smoke.log
```

Expected output when fixed:
```
PASS: 3-class transitivity
PASS: LUBM
PASS: GALEN
PASS: Roberts Family
```

## What NOT to try

- Do NOT add `stopThread(true)` to STPU destructor — tried, caused regression (LUBM/GALEN failed too; thread exits before processing remaining events)
- Do NOT use cooperative single-thread dispatch (sGlobalEventQueue) — that model cannot solve the KPSet spin-wait deadlock for GALEN/Roberts
- Roberts Family needs 1GB INITIAL_MEMORY — do not reduce (needs ~596MB for tableau expansion)
