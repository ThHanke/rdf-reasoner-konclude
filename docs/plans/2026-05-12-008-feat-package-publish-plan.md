---
id: 2026-05-12-008
title: Package DX, Documentation, and npm Publish
status: active
origin: docs/brainstorms/2026-05-12-007-feat-package-publish-requirements.md
created: 2026-05-12
---

# Package DX, Documentation, and npm Publish

## Problem Frame

The Konclude WASM port is functionally complete and benchmarked. Four blockers
prevent any developer from using it today: Node.js breaks without a Worker
polyfill; browser pthreads require undocumented COOP/COEP headers; the README
describes a deprecated API; and the package is unpublished.

Additionally, six completed plan docs in `docs/plans/` add noise for contributors
and must be removed before the first push to origin.

*(see origin: docs/brainstorms/2026-05-12-007-feat-package-publish-requirements.md)*

---

## Key Decisions

### D1 — Node.js compat via `"node"` export condition + `dist/index.node.mjs`

`package.json` `exports["."]` gains a `"node"` condition pointing to
`dist/index.node.mjs`. That file installs `NodeWorkerShim` into
`globalThis.Worker` (if absent) then re-exports everything from `./index.js`.
Node.js and bundlers in SSR mode pick this up automatically. Vite in browser
mode uses the `"browser"` or `"import"` condition — verified: Vite does **not**
activate `"node"` for client builds. The shim code never ships to browser bundles.

**Why not constructor injection:** keeps public `RdfReasoner` API identical
across environments; no extra argument needed.

### D2 — `dist/worker-node.mjs` as static source file

`ts/worker-node.mjs` is a static `.mjs` file (not compiled by tsc) that
polyfills `globalThis.self` for Node.js v20 worker threads then imports
`./worker.js`. A `postbuild` npm script copies it to `dist/`. The `files`
array must include `dist/worker-node.mjs`.

### D3 — LICENSE = MIT, NOTICE = LGPL third-party notice

The existing `LICENSE` file (currently Apache 2.0 — a mistake) is replaced
with MIT. A new `NOTICE` file carries the LGPLv3 third-party notice for the
WASM binary, plus acknowledgement of Claude (Anthropic) for the port. Both
files are included in `files` in `package.json`.

### D4 — 0.1.0, Store API as primary in all docs

Pre-stable. Deprecated `Iterable<Quad>` overloads mentioned briefly under a
"Deprecated" subsection. All examples use `reason(store)`.

### D5 — Cleanup before first push

Six completed plan docs deleted in one commit before any push to origin. The
commit message notes they are archived in git history.

---

## Implementation Units

### Unit 1 — Repository cleanup

**Files changed:**
- `docs/plans/2026-05-04-001-feat-konclude-wasm-npm-port-plan.md` — deleted
- `docs/plans/2026-05-06-002-fix-feat-wasm-correctness-pthreads-plan.md` — deleted
- `docs/plans/2026-05-12-003-refactor-remove-diagnostic-prints-plan.md` — deleted
- `docs/plans/2026-05-12-004-feat-comparative-benchmark-harness-plan.md` — deleted
- `docs/plans/2026-05-12-005-refactor-wasm-performance-optimization-plan.md` — deleted
- `docs/plans/2026-05-12-006-feat-n3-store-integration-plan.md` — deleted
- `CLAUDE.md` — remove the `docs/plans/` reference that names deleted files

**What to do:**
Delete all six files. Update the "Plan Documents" section of `CLAUDE.md` to
remove the now-dead links. Commit with message:
`chore: remove completed plan documents (archived in git history)`

No tests required.

---

### Unit 2 — LICENSE, NOTICE, and ACKNOWLEDGEMENTS

**Files changed:**
- `LICENSE` — replace Apache 2.0 with MIT (copyright 2026 Thomas Hanke)
- `NOTICE` — create: LGPLv3 third-party notice + Claude credit
- `package.json` — add `"NOTICE"` and `"LICENSE"` (already: `dist`, `NOTICE`) to
  `files`; confirm `"license": "MIT"`

**MIT LICENSE content** (use standard SPDX MIT template):
```
MIT License

Copyright (c) 2026 Thomas Hanke

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

**NOTICE content** (two sections):
1. Konclude LGPLv3 — `dist/konclude.wasm` contains the Konclude reasoning kernel
   (© University of Ulm, LGPLv3). Source + patches available at the GitHub repo.
   To recompile: `git clone --recurse-submodules` + `docker compose run build`.
2. Claude AI — this WebAssembly port was developed with AI assistance from
   Claude (Anthropic). The reasoning algorithm and all original Konclude source
   belong entirely to the Konclude authors.

**package.json** `files` array should be:
```json
"files": ["dist", "NOTICE", "LICENSE"]
```

No tests required.

---

### Unit 3 — Node.js compatibility

**Files created:**
- `ts/worker-node.mjs` — static ESM file, not compiled by tsc
- `ts/index.node.mjs` — static ESM file, not compiled by tsc (re-exports from dist)

**Files changed:**
- `package.json` — `exports`, `files`, `scripts.build`

#### `ts/worker-node.mjs`

Polyfills `globalThis.self` for Node.js v20 worker threads, then loads `./worker.js`:

```js
// worker-node.mjs — Node.js worker_threads polyfill for dist/worker.js
import { parentPort } from 'node:worker_threads';

globalThis.self = {
  postMessage: (data) => parentPort.postMessage(data),
  set onmessage(handler) {
    parentPort.on('message', (data) => handler({ data }));
  },
};

await import('./worker.js');
```

Note: `worker.js` sets `self.onmessage = handleMessage`. The setter wires
`parentPort.on('message', ...)` with `{ data }` wrapping to match `MessageEvent`.

#### `ts/index.node.mjs`

Sets up `NodeWorkerShim` into `globalThis.Worker` then re-exports from the
compiled `./index.js`:

```js
// index.node.mjs — Node.js entry via "node" export condition
import { Worker as NodeWorker } from 'node:worker_threads';

class NodeWorkerShim {
  constructor(url, _opts) {
    const rawPath = url instanceof URL ? url.pathname : String(url);
    const path = rawPath.replace(/worker\.js$/, 'worker-node.mjs');
    this._w = new NodeWorker(path);
    this._map = new Map();
  }
  postMessage(msg) { this._w.postMessage(msg); }
  addEventListener(type, fn) {
    let wrapped;
    if (type === 'message') wrapped = (data) => fn({ data });
    else if (type === 'error') wrapped = (err) => fn({ message: err?.message ?? String(err) });
    else wrapped = fn;
    if (!this._map.has(fn)) this._map.set(fn, new Map());
    this._map.get(fn).set(type, wrapped);
    this._w.on(type, wrapped);
  }
  removeEventListener(type, fn) {
    const wrapped = this._map.get(fn)?.get(type);
    if (wrapped) { this._w.off(type, wrapped); this._map.get(fn).delete(type); }
  }
  terminate() { this._w.terminate(); }
}

if (typeof globalThis.Worker === 'undefined') {
  globalThis.Worker = NodeWorkerShim;
}

export * from './index.js';
```

#### `package.json` changes

**exports:**
```json
"exports": {
  ".": {
    "types": "./dist/index.d.ts",
    "node": "./dist/index.node.mjs",
    "import": "./dist/index.js"
  },
  "./worker": {
    "types": "./dist/worker.d.ts",
    "import": "./dist/worker.js"
  },
  "./wasm": "./dist/konclude.wasm"
}
```

**scripts** — add `postbuild` to copy static `.mjs` files to `dist/`:
```json
"postbuild": "cp ts/worker-node.mjs dist/worker-node.mjs && cp ts/index.node.mjs dist/index.node.mjs"
```

**files:**
```json
"files": ["dist", "NOTICE", "LICENSE"]
```
(dist already includes worker-node.mjs and index.node.mjs after postbuild)

**Test scenarios** (`tests/unit/node-compat.test.ts` or integration test):
- `new RdfReasoner()` in a Node.js context (mock or real) does not throw
- `NodeWorkerShim.addEventListener('message', fn)` → wrapped with `{ data }`
- `NodeWorkerShim.addEventListener('error', fn)` → wrapped with `{ message }`
- `NodeWorkerShim.removeEventListener` removes correct wrapper
- `globalThis.Worker` is not set if it already exists (browser env safe)

Existing `tests/bench/ts-runner.mjs` exercises this end-to-end; after Unit 3,
`ts-runner.mjs` can remove its local `NodeWorkerShim` definition and import from
the package instead (optional cleanup, not required for publish).

---

### Unit 4 — README rewrite

**Files changed:**
- `README.md` — complete rewrite

**Content structure** (all sections required by R5–R8):

1. **Header + one-line description** — npm badge, version, license badge
2. **Installation** — `npm install rdf-reasoner-konclude n3`
3. **Node.js quick-start** (primary) — import, `new RdfReasoner()`, `await
   reasoner.ready`, `await reasoner.reason(store)`, read from
   `INFERRED_GRAPH_IRI` named graph. Show N3.js `Store` usage.
4. **Browser / Vite quick-start** — same API, note COOP/COEP requirement,
   link to Browser Deployment section
5. **API reference** — `RdfReasoner`, `INFERRED_GRAPH_IRI`, `StoreReasoningOptions`;
   mention deprecated `Iterable<Quad>` overloads briefly
6. **Browser deployment** — dedicated section (R7):
   - Why: pthreads → SharedArrayBuffer → requires COOP/COEP headers
   - Vite dev-server config snippet
   - nginx production snippet
   - Caddy production snippet
   - webpack 5 `asyncWebAssembly` note
7. **Performance** — benchmark table with TS total column and JS overhead note
   (R6); refresh from `npm run bench` output before finalising
8. **How it works** — brief architecture (Worker + WASM, NTriples wire format)
9. **Build from source** — retain current Docker build instructions
10. **Licence** — R8: dual licence explanation, link to `NOTICE` and `LICENSE`,
    written-offer for source → GitHub URL
11. **Acknowledgements** — Konclude authors, Claude (Anthropic)

**Key correctness requirements:**
- Node.js quick-start must work verbatim with Node.js 20, no extra steps
- Browser quick-start must note `n3` is a required peer dependency
- `INFERRED_GRAPH_IRI` must be shown as the named graph to query for results
- Repository URL: `https://github.com/ThHanke/rdf-reasoner-konclude`

**Vite COOP/COEP snippet:**
```js
// vite.config.js
export default {
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
}
```

**nginx snippet:**
```nginx
add_header Cross-Origin-Opener-Policy same-origin;
add_header Cross-Origin-Embedder-Policy require-corp;
```

**webpack 5 snippet:**
```js
// webpack.config.js
module.exports = { experiments: { asyncWebAssembly: true } }
```

No tests required (README is documentation).

---

### Unit 5 — package.json finalization

**Files changed:**
- `package.json`

**Changes:**
- `repository.url`: `"https://github.com/ThHanke/rdf-reasoner-konclude"` — **hard gate per R12**
- `version`: confirm `"0.1.0"` (already set)
- `license`: confirm `"MIT"` (already set)
- `publishConfig`: add `{ "access": "public" }` (required for scoped or first-time publish)
- `main`: keep `"./dist/index.js"` (CJS fallback for older tooling)
- Verify `engines.node: ">=18"` present

No tests required.

---

### Unit 6 — Pre-publish verification

**Steps (manual, not scripted):**

1. Fix `dist/` ownership if root-owned:
   ```bash
   sudo chown -R $USER dist/
   ```
2. Build TypeScript + copy static files:
   ```bash
   npm run build
   ```
   Verify `dist/` contains: `index.js`, `index.d.ts`, `worker.js`, `worker-node.mjs`,
   `index.node.mjs`, `konclude.mjs`, `konclude.wasm`
3. Smoke test Node.js compat (no Worker polyfill needed):
   ```bash
   node -e "import('rdf-reasoner-konclude').then(m => console.log(Object.keys(m)))"
   ```
   Or run the ts-runner bench: `node tests/bench/ts-runner.mjs`
4. `npm pack --dry-run` — verify tarball includes `dist/`, `NOTICE`, `LICENSE`
5. Verify repository URL resolves: `curl -I https://github.com/ThHanke/rdf-reasoner-konclude`

---

### Unit 7 — Publish and release

**Steps (manual, requires npm login + GitHub access):**

1. `npm login` (if not already authenticated)
2. `npm publish --access public`
3. Verify: `npm info rdf-reasoner-konclude` shows `0.1.0`
4. Create git tag:
   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```
5. Create GitHub release via `gh`:
   ```bash
   gh release create v0.1.0 \
     --title "v0.1.0 — Initial release" \
     --notes "$(cat <<'EOF'
   ## What's new

   First public release of rdf-reasoner-konclude — OWL-DL reasoning via Konclude
   compiled to WebAssembly.

   - `RdfReasoner` with `reason(store)`, `classify(store)`, `checkConsistency(store)`
   - Node.js ≥ 18 supported out of the box (no Worker polyfill required)
   - Browser support with Web Workers + SharedArrayBuffer (COOP/COEP headers required)
   - ~1.4×–7.3× of native Konclude classify time across tested ontologies
   - MIT licence (TypeScript wrapper) + LGPLv3 (WASM binary / Konclude kernel)

   See README for full API reference, COOP/COEP setup, and benchmark results.
   EOF
   )"
   ```

---

## Test Scenarios

| Unit | Scenario | Mechanism |
|------|----------|-----------|
| 3 | `new RdfReasoner()` works in Node.js 20, no manual Worker setup | `node tests/bench/ts-runner.mjs` |
| 3 | `NodeWorkerShim` message events wrapped as `{ data }` | Unit test |
| 3 | `NodeWorkerShim` error events wrapped as `{ message }` | Unit test |
| 3 | `globalThis.Worker` not overwritten if already defined | Unit test |
| 6 | `dist/` tarball includes all required files | `npm pack --dry-run` |
| 6 | Repository URL resolves | `curl -I` check |
| 7 | `npm info rdf-reasoner-konclude` returns `0.1.0` | Post-publish check |

---

## Sequencing

```
Unit 1 (cleanup) → Unit 2 (LICENSE/NOTICE) → Unit 3 (Node compat) →
Unit 4 (README) → Unit 5 (package.json) → Unit 6 (verify) → Unit 7 (publish)
```

Units 2–5 have no dependencies on each other and can be done in any order after
Unit 1. Unit 6 must follow all of 2–5. Unit 7 requires Unit 6 to pass.

---

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| `dist/` root-owned after Docker build | `sudo chown -R $USER dist/` before `npm run build` |
| Vite activates `"node"` condition in browser mode | Verified: Vite browser mode uses `browser`/`import` conditions only |
| `worker-node.mjs` not in npm tarball | Confirm `dist/` is in `files`; `npm pack --dry-run` check |
| Wrong repository URL at publish time | R12 hard gate — verify with `npm pkg get repository.url` before publish |
| `self` not defined in Node.js v20 worker thread | `worker-node.mjs` sets `globalThis.self` before importing `worker.js` |
