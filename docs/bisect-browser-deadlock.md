# Browser WASM pthread deadlock bisection

## Context

v0.7.0 has a browser-specific deadlock: all reasoning ops (classify, checkConsistency, materialize) hang in browser Chromium while Node.js works fine. Worker posts `ready` (WASM loads), but the first reasoning call never returns.

Root cause theory: Emscripten `pthread_create` from within a pthread posts `{cmd:"spawnThread"}` to the main thread. If the main thread is blocked in WASM (futex/Atomics.wait via `waitSynchronization()` or `pthread_cond_wait`), it can't process the message → child thread never starts → deadlock. Node works because `worker_threads` creates threads directly.

Memory saved: `project_browser_pthread_deadlock.md`

## Goal

Find exactly which commit broke browser WASM by bisecting. The browser tests are in `tests/browser/worker.spec.ts`. The simplest test:

```bash
npx playwright test tests/browser/worker.spec.ts --grep "checkConsistency" --timeout 30000
```

If it hangs (30s timeout), the WASM is broken for browser.

## Pre-this-week baseline

`b84df5e` is the last commit before this week's changes. The 4 WASM-rebuilding commits this week are:

1. `430c1df` — fix: resolve ALIF+ FP/IFP 1-filler hang (patches 020-021)
2. `0e9fdfd` — fix: eliminate Roberts nondeterminism (sync BackendAssCache writes)
3. `6a52a98` — fix: disable SatExpCache (mode-switching fix)
4. `3706aef` — chore(release): bump to v0.7.0

## Strategy

### Step 1: Verify baseline works

Check out `b84df5e`, rebuild WASM, run browser test. If it passes, we know the regression is in one of the 4 WASM commits above. If it fails, the bug predates this week.

```bash
git stash -u  # save any local changes
git checkout b84df5e
# rebuild WASM: make build-wasm
# IMPORTANT: after docker build, fix ownership then patch:
#   npm run build  (includes patch-wasm in postbuild)
npx playwright test tests/browser/worker.spec.ts --grep "checkConsistency" --timeout 30000
```

### Step 2: If baseline passes, bisect the 4 WASM commits

Test each WASM-rebuilding commit in order. For each:

```bash
git checkout <commit>
# Rebuild WASM (make build-wasm), then npm run build
npx playwright test tests/browser/worker.spec.ts --grep "checkConsistency" --timeout 30000
```

The first one that fails is the culprit.

### Step 3: Compare with npm v0.6.9

As a cross-check, pull the published v0.6.9 WASM from npm and test it in the browser harness:

```bash
mkdir /tmp/konclude-069 && cd /tmp/konclude-069
npm pack rdf-reasoner-konclude@0.6.9
tar xzf rdf-reasoner-konclude-0.6.9.tgz
# Copy its dist/konclude.wasm and dist/konclude.mjs into the repo's dist/
# Then npm run patch-wasm && npm run build && run browser test
```

### Step 4: Once culprit found

Diff the C++ changes in that commit. The fix likely involves one of:

- Removing `stopThread(true)` calls that `pthread_join` from within a pthread
- Adding `PROXY_TO_PTHREAD` to Emscripten flags (moves WASM main to dedicated pthread, freeing real main for message dispatch)
- Restructuring thread creation to happen on the main thread before it blocks

## Known blocking calls in KoncludeReasoner.cpp

| Line | Call | Context | When |
|------|------|---------|------|
| ~157 | `rt->stopThread(true)` | `stopAndClearRealizers` | reset/destroy |
| ~204 | `mSatNodeExpCache->stopThread(true)` | `initializeManager` | first call (manager pthread) |
| ~216 | `mSatExpCache->stopThread(true)` | `initializeManager` | first call (manager pthread) |
| ~241 | `mBackendAssCache->stopThread(true)` | `threadStopped` | manager thread exit |
| ~246 | `mCompConsCache->stopThread(true)` | `threadStopped` | manager thread exit |
| ~251 | `mOccStatsCache->stopThread(true)` | `threadStopped` | manager thread exit |
| ~2012 | `waitSynchronization()` | `runPipeline` | every reasoning call (main thread) |

## Important build notes

- WASM rebuild: `docker compose run --rm build` (~20-30min, uses ccache)
- After rebuild: `npm run build` (includes `npm run patch-wasm` in postbuild)
- **ccache gotcha**: if you change `src/KoncludeReasoner.cpp`, you must delete the cached object inside Docker:

  ```bash
  docker compose run --rm build bash -c "
    rm -f /src/build/src/CMakeFiles/konclude_wasm.dir/KoncludeReasoner.cpp.o
    rm -f /src/build/src/CMakeFiles/konclude_wasm.dir/KoncludeReasoner.cpp.o.d
    cd /src/build && cmake --build . -j4
  "
  ```

- dist/ becomes root-owned after Docker build — don't chown (user preference), just `npm run build` handles it
