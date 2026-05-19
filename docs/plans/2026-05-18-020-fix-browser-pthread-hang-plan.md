---
title: "fix: Browser pthread on-demand worker hang — classify/checkConsistency timeout"
type: fix
status: active
date: 2026-05-18
---

# fix: Browser pthread on-demand worker hang

## Overview

Three Playwright browser tests time out (120 s) in headless Chromium:

- `reason(store): A→B→C chain infers A→C via realization`
- `checkConsistency(store): simple subclass chain is consistent`
- `reason(store): parse Turtle via n3.Parser, run classification`

The fourth test (`SharedArrayBuffer available`) passes. The tests call `RdfReasoner.reason()` or
`checkConsistency()` which forward to the Emscripten WASM module inside `dist/worker.js`. WASM
triggers KPSet's parallel classifier which spawns pthreads. In the browser those threads are
Emscripten Web Workers (`em-pthread`).

## Problem Frame

### What Emscripten does

Emscripten pre-allocates `pthreadPoolSize=8` workers at init time (`initMainThread →
loadWasmModuleToAllWorkers`). Each gets `{cmd:"load"}` and instantiates WASM from the shared
`WebAssembly.Module`.

When WASM C++ code calls `pthread_create`, `___pthread_create_js` proxies the call to the
Emscripten main thread (running inside `dist/worker.js`), which calls `spawnThread → getNewWorker
→ unusedWorkers.pop()`. If the pool is empty, `getNewWorker` must create workers on demand.

### Root cause identified in previous session

The Emscripten-generated `getNewWorker()` contained:

```js
getNewWorker(){
  if(PThread.unusedWorkers.length==0){
    if(!ENVIRONMENT_IS_NODE){return}   // ← browser bail-out; returns undefined
    ...
  }
  ...
}
```

When the pool is exhausted in a browser, `getNewWorker` returns `undefined` → `spawnThread`
returns `EAGAIN` (6) → KPSet spin-waits for a slot that never opens → permanent deadlock.

**Patch 6** (already applied) removes the `!ENVIRONMENT_IS_NODE` guard, allowing on-demand
worker creation in browsers.

### Current state after Patch 6

With Patch 6 applied, `[pool-grow]` diagnostic logs confirm 9 on-demand workers ARE created.
The 8 pre-allocated workers DO reach `[invoke]` (invokeEntryPoint). But the 9 on-demand workers
NEVER reach `[run-handler]` (the log added just before `invokeEntryPoint` in the `{cmd:"run"}`
handler). The test still times out.

Diagnostic logging currently in `dist/konclude.mjs`:

| Log tag | Location |
|---|---|
| `[pool-grow]` | `getNewWorker` when pool empty |
| `[pool-use]` | `getNewWorker` when pool has workers |
| `[invoke]` / `[invoke-done]` | `invokeEntryPoint` |
| `[run-handler]` | `{cmd:"run"}` handler (JUST added, not yet tested) |
| `[alloc-worker-err]` | `worker.onerror` in `allocateUnusedWorker` |

Additionally, `vite.browser-test.config.ts` has request-URL logging for `wasm`/`worker` requests.

`dist/worker.js` has `printErr: () => {}` (silences Emscripten `err()` on the outer worker), so
any `worker.onerror` events that fire `err()` on the main Emscripten thread are silenced.

The last test attempt exited with code 137 (SIGKILL/OOM), suggesting 17 simultaneous
`WebAssembly.Instance` creation attempts may spike memory beyond Chromium's limit.

### Worker lifecycle recap (pthread branch)

```
Worker created  →  self.onmessage=handleMessage  →  createWasm() adds runDep "wasm-instantiate"
→  run() blocked (runDependencies=1)

{cmd:"load"} arrives:
  handleMessage  →  self.onmessage = queuer   ← queues subsequent messages
  →  wasmModuleReceived(module)
  →  new WebAssembly.Instance(module, getWasmImports())   ← sync, uses shared wasmMemory SAB
  →  receiveInstance()  →  removeRunDependency("wasm-instantiate")
  →  dependenciesFulfilled()  →  run()
  →  ENVIRONMENT_IS_PTHREAD: startWorker(Module) = self.startWorker(Module)
  →  self.startWorker: posts {cmd:"loaded"}, drains messageQueue, restores self.onmessage=handleMessage

{cmd:"run"} arrives (either from messageQueue or live):
  handleMessage  →  [run-handler] log  →  invokeEntryPoint(start_routine, arg)
```

For on-demand workers: `{cmd:"load"}` and `{cmd:"run"}` are both queued before the worker
processes anything. `{cmd:"run"}` should be captured by the queuer and processed in `startWorker`.

**Unknown: why on-demand workers never reach `[run-handler]`.**  
The fix depends on what the diagnostic run shows.

## Scope Boundaries

- Only `dist/konclude.mjs` and `scripts/patch-konclude-mjs.sh` are patched (JS layer)
- No WASM rebuild (CMakeLists, C++ sources unchanged)
- Version bump from `0.1.0` → `0.2.0` and publish are in scope (blocked on tests passing)

### Deferred to Separate Tasks

- Reducing total thread count via KPSet algorithm changes: separate C++ effort
- `PTHREAD_POOL_SIZE` WASM build-flag change: requires 20–30 min rebuild, not needed if JS patch works

## Context & Research

### Relevant Code and Patterns

- `dist/konclude.mjs` — patched Emscripten glue; all fixes are in-file patches (idempotent script)
- `scripts/patch-konclude-mjs.sh` — Bash + Python3 patch script; each patch checks for before/after strings
- `tests/browser/diag2.spec.ts` — minimal diagnostic: 1-triple store → `checkConsistency`, 30s race
- `tests/browser/worker.spec.ts` — the three failing integration tests
- `vite.browser-test.config.ts` — Vite dev server with COOP/COEP headers + raw `konclude.mjs` serving

### Institutional Learnings

- `docs/solutions/` contains the detailed pthread concurrency architecture doc
- Patch 3 (`__emscripten_thread_free_data` no-op) and Patch 4 (`invokeEntryPoint` try-catch) exist
  to handle KPSet worker cleanup crashes — relevant if on-demand workers also crash on exit

### Key Emscripten Behaviours

- `loadWasmModuleToWorker` overwrites `worker.onerror` (replaces our `[alloc-worker-err]` handler)
  with one that calls `err()` (silenced by `dist/worker.js`'s `printErr:()=>{}`) then maybe throws
- `PTHREAD_POOL_SIZE_STRICT` is not present in the compiled output — on-demand creation is allowed
- `new WebAssembly.Instance(sharedModule, imports)` should be O(1) instantiation (shared compile);
  but 9 simultaneous calls may spike memory/CPU causing OOM or kill in headless Chrome

## Key Technical Decisions

- **Patch-only approach**: All fixes are JS-level patches applied by `patch-konclude-mjs.sh`. No WASM
  rebuild required. This keeps iteration fast and is consistent with Patches 1–6.
- **Diagnostic-first**: Run the `[run-handler]` test to determine exact failure point before applying any
  new patch. The correct patch differs significantly depending on failure mode.
- **Remove diagnostic logging before release**: All `console.log` debug markers must be removed from
  `dist/konclude.mjs` and the patch script must reproduce a clean state for future WASM rebuilds.

## Open Questions

### Deferred to Implementation

- **Exact failure mode**: Is it OOM (WebAssembly.Instance × 17), a messaging race, or something
  in `{cmd:"load"}/{cmd:"run"}` dispatch? — determined in Unit 1.
- **Correct pool size** (if fix is pre-allocation): Observed 8+9=17 total. Pool needs to be ≥17
  to avoid on-demand. Use 20 for margin. — confirmed by watching `[pool-grow]` count in Unit 1.
- **Whether Patch 6 stays**: If pre-allocation alone fixes the issue, Patch 6 is kept as a safety
  net (no on-demand will be triggered). If on-demand workers work reliably with the new patch, keep it.

## Implementation Units

- [ ] **Unit 1: Run `[run-handler]` diagnostic and determine exact failure mode**

**Goal:** Understand exactly where on-demand workers fail — before or inside `{cmd:"run"}` processing.

**Requirements:** Diagnose the hang to choose the correct fix

**Dependencies:** None (diagnostic logging already in place)

**Files:**
- Run: `tests/browser/diag2.spec.ts` (read-only)
- Read: `dist/konclude.mjs` (examine current state if needed)

**Approach:**

Run the diag2 test with a longer-than-OOM timeout and capture ALL output:

```bash
npx playwright test tests/browser/diag2.spec.ts \
  --reporter=list --timeout=60000 2>&1 | head -200
```

Read the console log output carefully. Classify the result:

| Observation | Meaning |
|---|---|
| Exit 137 (killed) | OOM: 17 simultaneous WASM instantiations exceed Chromium memory |
| No `[run-handler]` for on-demand workers, no error | Workers die during `{cmd:"load"}` (WASM instantiate throws, swallowed by silenced err()) |
| `[run-handler]` fires but no `[invoke]` | Worker hangs in `establishStackSpace` / `__emscripten_thread_init` |
| `[run-handler]` fires, `[invoke]` fires but no `[invoke-done]` | Thread function hangs |
| Hangs only after all 17 workers start | KPSet coordination deadlock, different root cause |

**Verification:** Enough log data to know which of Units 2a/2b/2c to execute.

---

- [ ] **Unit 2a: Fix — pre-allocate workers to avoid on-demand creation (apply if OOM or silent failure)**

**Goal:** Increase `pthreadPoolSize` so all workers KPSet needs are ready before classification starts,
eliminating simultaneous on-demand instantiation.

**Requirements:** Tests pass without OOM

**Dependencies:** Unit 1 confirms OOM or no-`[run-handler]` scenario

**Files:**
- Modify: `dist/konclude.mjs` (patch pthreadPoolSize literal)
- Modify: `scripts/patch-konclude-mjs.sh` (add Patch 7: pthreadPoolSize increase)

**Approach:**

Add Patch 7 to `patch-konclude-mjs.sh`:

- Before: `var pthreadPoolSize=8;`
- After: `var pthreadPoolSize=20;`

Rationale: KPSet uses 8 pool workers + spawns ~9 sub-threads = 17 total observed.
Pre-allocating 20 gives margin without needing on-demand allocation.

Workers load in parallel at `loadWasmModuleToAllWorkers` time (module init, before `classify()`).
The init is gated by `addRunDependency("loading-workers")` so `run()` waits for all workers.
20 workers instantiating WASM at startup is sequential relative to the main `classify()` call,
spreading the memory spike across startup instead of concentrating it mid-classification.

Patch structure (follows existing patch pattern in the script):

```bash
BEFORE_POOL='var pthreadPoolSize=8;'
AFTER_POOL='var pthreadPoolSize=20;'

if grep -qF "$BEFORE_POOL" "$DIST_FILE"; then
  python3 ... replace BEFORE_POOL with AFTER_POOL ...
  echo "patch-konclude-mjs: [APPLIED] increased pthreadPoolSize 8→20"
else
  echo "patch-konclude-mjs: [SKIP]    pthreadPoolSize already patched"
fi
```

**Test scenarios:**
- Happy path: `npm run patch-wasm` after a fresh WASM build re-applies all patches including Patch 7
- Happy path: Running tests shows no `[pool-grow]` logs (no on-demand workers needed)
- Edge case: Pool size string must match exactly (minified JS has no spaces around `=`)

**Verification:** `[pool-grow]` log never appears in test output; browser tests complete without timeout.

---

- [ ] **Unit 2b: Fix — silence/surface on-demand worker errors (apply if `[run-handler]` never fires, no OOM)**

**Goal:** Expose what `{cmd:"load"}` processing throws in on-demand workers, which is currently
swallowed by `dist/worker.js`'s `printErr:()=>{}` silencing.

**Requirements:** Determine the error so a targeted fix can be made

**Dependencies:** Unit 1 confirms no `[run-handler]` without OOM

**Files:**
- Modify: `dist/konclude.mjs` (temporary: add error capture around wasmModuleReceived call)

**Approach:**

In the `{cmd:"load"}` handler (after the `for(const handler...)` block):

Wrap `wasmModuleReceived(msgData.wasmModule)` in a try-catch that posts the error back to the
main thread as a `{cmd:"error", message:...}` message. The outer `worker.onmessage` handler in
`loadWasmModuleToWorker` can log it via `console.error` (not `err()`).

This is a TEMPORARY diagnostic patch. Once the error is identified, replace with the actual fix.

**Test scenarios:**
- Error path: WASM instantiation failure reason appears in Playwright console output
- Happy path: No error = on-demand worker loads silently but still hangs → Unit 2c

**Verification:** Playwright console shows a specific error for the on-demand worker failure.

---

- [ ] **Unit 2c: Fix — on-demand worker hangs after `[run-handler]` (apply if run-handler fires but invoke doesn't)**

**Goal:** Identify and fix what blocks `__emscripten_thread_init` or `__emscripten_thread_mailbox_await`
for on-demand workers specifically.

**Requirements:** Tests reach `invokeEntryPoint`

**Dependencies:** Unit 1 confirms `[run-handler]` fires; Unit 2a/2b not applicable

**Files:**
- Modify: `dist/konclude.mjs` (targeted patch around the blocking call)

**Approach:**

Add logging BETWEEN each call in the `{cmd:"run"}` handler:

```
[run-1] after establishStackSpace
[run-2] after __emscripten_thread_init
[run-3] after receiveObjectTransfer
[run-4] after threadInitTLS
[run-5] after mailbox_await ← likely hang point
[run-6] after __embind_initialize_bindings
```

`__emscripten_thread_mailbox_await(pthread_ptr)` uses `Atomics.wait` on the thread's semaphore
to wait for the main thread to release it after the spawn. If the main thread is blocked in
`Atomics.wait32` (WASM wait loop), it cannot release the semaphore → deadlock.

For on-demand workers created mid-classification (while main thread is in WASM wait loop), the
main thread processes proxy calls but may not process the `{cmd:"loaded"}` response from the
on-demand worker's `postMessage`. The `{cmd:"loaded"}` response is needed by `loadWasmModuleToWorker`
to mark the worker as loaded — but this is a JS-layer concern that doesn't affect WASM execution.

If `mailbox_await` is the hang: patch to add a timeout or no-op the await for on-demand workers
(since they were created without going through the normal TLS init path the await was designed for).

**Test scenarios:**
- Happy path: `[run-5]` log appears → `mailbox_await` is not the hang
- Error path: no `[run-5]` → mailbox hang confirmed, apply targeted patch

**Verification:** `[invoke]` appears for all on-demand workers.

---

- [ ] **Unit 3: Remove all diagnostic instrumentation**

**Goal:** Remove every temporary debug log and instrumentation added during this debugging session.

**Requirements:** Clean dist/konclude.mjs and vite config (no debug pollution in published package)

**Dependencies:** Unit 2a, 2b, or 2c completes and tests pass

**Files:**
- Modify: `dist/konclude.mjs`
- Modify: `vite.browser-test.config.ts`
- Delete: `tests/browser/diag2.spec.ts`

**Approach:**

Remove from `dist/konclude.mjs` using Python string replacement (as used by other patches):

| String to remove | Location |
|---|---|
| `console.log("[pool-grow] unusedWorkers empty, allocating");` | `getNewWorker` |
| `}else{console.log("[pool-use] pool has",PThread.unusedWorkers.length,"workers")}` | `getNewWorker` |
| `console.log("[invoke]",ptr,self.name\|\|"main");` | `invokeEntryPoint` |
| `console.log("[invoke-done]",ptr);` | `invokeEntryPoint` |
| `console.log("[invoke-unwind]",ptr);` | `invokeEntryPoint` (catch block) |
| `console.log("[run-handler]",msgData.pthread_ptr,self.name\|\|"?");` | `{cmd:"run"}` handler |
| `worker.onerror=e=>{console.error("[alloc-worker-err]",e.message,e.filename,e.lineno)};` | `allocateUnusedWorker` |
| Any `[run-1]`..`[run-6]` logs added in Unit 2c | `{cmd:"run"}` handler |

Remove from `vite.browser-test.config.ts`:
```ts
if (req.url && (req.url.includes('wasm') || req.url.includes('worker'))) {
  console.log('[vite-req]', req.url);
}
```

Delete `tests/browser/diag2.spec.ts`.

After cleanup, re-run `npm run patch-wasm` to verify the patch script is idempotent with the
new patches and produces a clean `dist/konclude.mjs`.

**Test scenarios:**
- Happy path: `npm run patch-wasm` on a freshly-built WASM outputs all `[APPLIED]` / `[SKIP]` lines, no errors
- Happy path: No debug tags appear in Playwright output for a clean test run
- Edge case: Verify `dist/worker.js` was not accidentally modified (it should still have `printErr:()=>{}`)

**Verification:**
- `grep -c 'pool-grow\|run-handler\|\[invoke\]\|vite-req' dist/konclude.mjs` = 0
- `tests/browser/diag2.spec.ts` does not exist
- `npm test` passes (unit tests)
- `npx playwright test` passes all 4 browser tests

---

- [ ] **Unit 4: Bump version and prepare release**

**Goal:** Bump `package.json` version to `0.2.0`, merge `v0.2.0` branch to `main`, push, publish to npm.

**Requirements:** All tests pass (Units 1–3 complete)

**Dependencies:** Unit 3 complete; clean test run

**Files:**
- Modify: `package.json` (version: `0.1.0` → `0.2.0`)

**Approach:**

1. `npm version 0.2.0 --no-git-tag-version` (or edit `package.json` directly)
2. `npm test` — confirm all Vitest tests pass
3. `npx playwright test` — confirm all 4 browser tests pass
4. Commit with message `chore: bump version to 0.2.0`
5. Use `finishing-a-development-branch` skill:
   - Current branch: `v0.2.0`
   - Base branch: `main`
   - Present options: merge locally / push PR / keep / discard

**Test scenarios:**
- Happy path: `npm version 0.2.0` does not trigger git tag (flag used)
- Happy path: `package.json` shows `"version": "0.2.0"` after edit
- Integration: `npm test` runs clean after version bump

**Verification:**
- `cat package.json | grep version` shows `0.2.0`
- Branch is merged to main (per finishing-a-development-branch choice)
- `npm publish` succeeds (if user requests it)

---

## System-Wide Impact

- **Interaction graph**: `dist/konclude.mjs` is the core Emscripten WASM glue; patches affect all
  browser and Node.js runtime paths. The `pthreadPoolSize` patch (Unit 2a) affects startup time
  and memory footprint (12 extra Workers instantiating at init).
- **Error propagation**: On-demand worker errors are currently silenced by `printErr:()=>{}` in
  `dist/worker.js`. After Unit 3, silencing remains (intentional — avoids console noise in production).
- **Unchanged invariants**: Node.js operation is unaffected — `ENVIRONMENT_IS_NODE=true` workers
  never hit the on-demand path that was broken in browsers. Patch 6 (remove `!ENVIRONMENT_IS_NODE`
  guard) changes Node.js behavior: on-demand allocation is now symmetric. Node.js tests must still pass.
- **Integration coverage**: Unit tests (`npm test`) do not exercise the browser Worker path. Browser
  tests are the only coverage for the pthread/Worker thread path. Both must pass before release.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| pthreadPoolSize=20 at startup spikes memory, browser tab killed | Try 16 first; if OOM, reduce to 12; KPSet needs at least as many as it requests on-demand (observed: 9) |
| Pre-allocating 20 workers significantly increases `RdfReasoner` init time | Acceptable for v0.2.0; document in README; users can `await reasoner.ready` |
| Patch 6 + larger pool = workers created but never used (wasted resources) | Patch 6 is a safety net; it fires only if pool depleted, which won't happen with pool=20 |
| Node.js tests break after pthreadPoolSize change | Run `npm test` explicitly; Node.js pre-allocation is fine, just slightly higher startup cost |
| `[run-handler]` test exits 137 again before diagnosis | Run with `--workers=1` and `--timeout=90000`; limit Playwright processes |

## Sources & References

- Related code: `dist/konclude.mjs` (minified Emscripten glue, all patches are in-file)
- Related code: `scripts/patch-konclude-mjs.sh` (all 6 existing patches + new Patch 7)
- Related code: `tests/browser/worker.spec.ts` (the three failing tests)
- Related code: `tests/browser/diag2.spec.ts` (temporary diagnostic, deleted in Unit 3)
- Emscripten pthread threading: `ENVIRONMENT_IS_PTHREAD`, `pthreadPoolSize`, `loadWasmModuleToAllWorkers`
- Docs: `docs/solutions/architecture-patterns/wasm-pthread-concurrency-architecture-2026-05-08.md`
