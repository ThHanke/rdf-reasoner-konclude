---
title: "Emscripten pthread exit codes crash browser Worker — two-patch fix in dist/konclude.mjs"
date: 2026-05-13
category: docs/solutions/architecture-patterns/
module: wasm-browser-compat
problem_type: build_artifact_patch
component: tooling
severity: critical
applies_when:
  - Running the rdf-reasoner-konclude package in a browser (not Node.js)
  - Using any rdf-reasoner-konclude version built with Emscripten pthreads
  - After every `make build-wasm` that regenerates `dist/konclude.mjs`
tags:
  - wasm
  - emscripten
  - pthreads
  - browser
  - worker
  - patch
  - createRequire
  - onerror
---

# Emscripten pthread exit codes crash browser Worker — two-patch fix in `dist/konclude.mjs`

## Problem

`dist/konclude.mjs` (Emscripten-generated) has two issues that break browser use:

### Issue 1 — `createRequire` import (Node.js only)

The first two lines of the generated file are:

```js
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
```

`'module'` is a Node.js built-in. In browsers it doesn't exist, causing:
```
ReferenceError: createRequire is not defined
```

The `require()` call is only used inside the `ENVIRONMENT_IS_NODE` branch, which is never reached in a browser. The lines are entirely safe to strip.

### Issue 2 — pthread `worker.onerror` re-throws numeric exit codes

In the generated pthreads spawning block:

```js
worker.onerror = e => {
    var message = "worker sent an error!";
    err(`${message} ${e.filename}:${e.lineno}: ${e.message}`);
    throw e   // ← problem
};
```

When a pthread pool thread exits cleanly, Emscripten calls `exit()` which throws the exit-status code as an integer (e.g. `21102936`). Chrome wraps this in an `ErrorEvent` with `e.message = "uncaught exception: 21102936"`. The unconditional `throw e` propagates it:

1. Error event fires on the Konclude worker's `self`
2. `KoncludeReasoner.this._worker` fires an `error` event
3. All pending calls (`classify`, `getInferredNTriples`, etc.) are rejected
4. Reasoning fails even though classification completed successfully

The classification result is already committed in C++ by the time the thread exits. This is pure cleanup noise.

## Fix

`scripts/patch-konclude-mjs.sh` applies both patches after each WASM build:

**Patch 1:** Replace the static `import { createRequire }` with a conditional top-level await:
```js
// Before (crashes browsers — static import of Node.js built-in)
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// After (browser-safe: browsers see process.versions === undefined, skip the await)
const require = (typeof process === 'object' && process.versions && process.versions.node)
  ? (await import('module')).createRequire(import.meta.url) : undefined;
```
Top-level await is safe in all relevant environments (Node.js ≥14.8, Chrome ≥89, Firefox ≥89, Safari ≥15).

**Patch 2:** Replace `throw e` with a numeric-pattern guard:
```js
if (!/\b\d{5,}\b/.test(String(e.message || ""))) throw e
```

Five-or-more-digit numbers in `e.message` are Emscripten exit codes — suppress the throw for those, propagate everything else.

## Defense-in-depth in `ts/worker.ts`

`ts/worker.ts` also contains two matching safeguards that remain effective even if the patch script is not run:

1. **Global error handler** — `self.addEventListener("error", ...)` calls `event.preventDefault()` for "uncaught exception: N" patterns, preventing them from reaching the outer Worker.

2. **Classify try/catch** — the `classify` message handler wraps `reasoner.classify()` and swallows `isEmscriptenExitException` throws, returning `result = true` so the caller gets a success response.

## Workflow

After every `make build-wasm`:

```bash
sudo chown -R $USER dist/   # fix Docker root ownership
npm run patch-wasm           # apply both patches to dist/konclude.mjs
npm run build                # compile TypeScript
npm test                     # verify
```

The script is idempotent — safe to run multiple times.

## Why this can't be fixed upstream

Both issues are in Emscripten's code-generation templates, not in any source file we own. Fixing them requires either:
- A post-build patch (our approach)
- Patching Emscripten's JS template files in the Docker build image
- Upstream Emscripten fix (the `createRequire` issue is a known Emscripten bug for ESM output)
