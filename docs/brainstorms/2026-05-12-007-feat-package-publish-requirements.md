---
date: 2026-05-12
topic: package-publish-dx
---

# Package DX, Documentation, and npm Publish

## Problem Frame

The Konclude WASM port is functionally complete and benchmarked. It is not yet
published. Four blockers prevent any developer from using it today:

1. **Node.js is broken out of the box.** `RdfReasoner` calls `new Worker(...)`,
   which does not exist in Node.js. The bench exposed a manual shim workaround;
   no end user should have to do this.
2. **Browser users on pthreads builds need COOP/COEP headers.** `SharedArrayBuffer`
   (required by Emscripten pthreads) is blocked by browsers unless the page is
   served with `Cross-Origin-Opener-Policy: same-origin` and
   `Cross-Origin-Embedder-Policy: require-corp`. Without these headers the WASM
   silently hangs during thread-pool init. This is a deployment constraint, not a
   code change, but it must be prominently documented.
3. **README describes the wrong API.** It shows the deprecated `reason(quads[])`
   path and still says "Phase 3 in progress."
4. **The package has never been published.** No npm release, no GitHub version
   tag, no installation instructions.

Additionally, the repo carries six completed plan documents that are noise to
future contributors and should be removed before the first public push.

## Requirements

### Runtime compatibility

- R1. `new RdfReasoner()` works in Node.js ≥ 18 without any user-side Worker
  polyfill. The package internally adapts `node:worker_threads` to the Web Worker
  interface when the global `Worker` is absent.
- R2. `new RdfReasoner()` works in browser environments that support Web Workers
  and `SharedArrayBuffer` (Firefox, Chrome, Safari current — when served with
  correct COOP/COEP headers). No change to the browser code path.
- R3. `new RdfReasoner()` works inside Vite and webpack 5 projects. The README
  documents any required config (COOP/COEP dev-server headers, webpack async WASM
  flag) so users are not surprised.
- R4. The Node.js worker entry polyfills the `self` global required by the
  compiled `worker.js`, so Node.js v20 (which does not expose `self` in worker
  threads) is fully supported.

### Documentation

- R5. README is rewritten as the primary user-facing document. It covers:
  installation (`npm install rdf-reasoner-konclude n3`); a working Node.js
  quick-start snippet; a working browser/Vite quick-start snippet; full API
  reference for `RdfReasoner`, `INFERRED_GRAPH_IRI`, and `StoreReasoningOptions`;
  and a note on the deprecated `Iterable<Quad>` overloads.
- R6. README states benchmark results (WASM classify times per ontology) and the
  JS-layer overhead (n3 serialization cost scales with quad count) so users can
  set performance expectations.
- R7. README has a dedicated **Browser deployment** section that prominently
  documents the required COOP/COEP headers, explains *why* they are needed
  (pthreads → `SharedArrayBuffer`), and gives a Vite dev-server config example
  and an nginx/Caddy production example.
- R8. README links to the LGPL notice (`NOTICE` file) and explains the dual
  licence: TypeScript wrapper is MIT, WASM binary is LGPLv3. The written-offer
  for source points to the GitHub repository URL, which must resolve (R12).

### Repository cleanup

- R9. All six completed plan documents in `docs/plans/` are deleted before the
  first push to origin. The commit message notes they are archived in git history.
- R10. `docs/brainstorms/` and `docs/solutions/` are kept — they contain
  decisions and solved-problem records that are still useful.

### Publishing and release

- R11. Package published to npm as `rdf-reasoner-konclude@0.1.0` with public
  access. The `dist/` root-ownership issue (Docker writes as root) is resolved
  before `npm publish` runs — either via `sudo chown` or a build step that
  outputs to a writable directory.
- R12. `package.json` `repository` field is updated to the real GitHub URL
  before any tag or publish. This is a hard gate: publish must not proceed with
  the placeholder URL because it is also the LGPLv3 written-offer for source.
- R13. Git tag `v0.1.0` pushed to origin. A GitHub release is created with a
  short changelog covering what is new in this release.

## Success Criteria

- `npm install rdf-reasoner-konclude n3` + README Node.js snippet → works on
  Node.js 20, no extra steps.
- README browser/Vite snippet → works in a Vite project after adding the
  documented COOP/COEP dev-server headers.
- `npm info rdf-reasoner-konclude` shows `0.1.0`.
- GitHub has a `v0.1.0` release tag pointing to the real repo.
- `git log --oneline docs/plans/` shows the removal commit; no plan files remain
  in the working tree.
- No deprecated API appears as primary in the README.
- LGPL `repository` URL in `package.json` resolves to the live GitHub repo.

## Scope Boundaries

- **No binary triple protocol.** The n3 serialization round-trip (main JS
  overhead) is a separate future plan. This release documents the cost.
- **No removal of deprecated `Iterable<Quad>` overloads.** Semver major; deferred
  to 1.0.
- **No GitHub Actions CI.** Not a blocker for publish.
- **No SPARQL integration or higher-level helpers.** Out of scope.
- **No automatic COOP/COEP injection.** The package does not attempt to set
  response headers; it documents the requirement.

## Key Decisions

- **Export condition `"node"` in `package.json`**: Selected automatically by
  Node.js and by bundlers that respect the `node` condition. Users always import
  from `rdf-reasoner-konclude` — no separate subpath. Verified that Vite does
  *not* activate the `node` condition in browser builds, so the Node.js shim code
  never ships to browser bundles. (Deferred to planning: confirm via Vite
  resolution order before finalising.)
- **0.1.0 not 1.0.0**: Pre-stable; API may shift before the binary-protocol
  optimisation (future plan) is merged.
- **Store API as primary, Quad[] as deprecated**: All docs use `reason(store)`.

## Dependencies / Assumptions

- `dist/` is populated by `docker compose run build` (WASM) + `npm run build`
  (TypeScript) before publish. Both must succeed.
- `dist/` is currently root-owned. `sudo chown -R $USER dist/` or equivalent
  is required before `npm run build` can write TypeScript output there.
- Real GitHub URL must be known before planning proceeds (R12 is a hard gate).

## Outstanding Questions

### Resolve Before Planning

- ~~What is the real GitHub repository URL?~~ **Resolved:** `https://github.com/ThHanke/rdf-reasoner-konclude`

### Deferred to Planning

- *(R1, R4 — technical)* Node.js compat mechanism: `"node"` export condition
  pointing to `dist/index.node.js` (sets up `NodeWorkerShim` before re-exporting
  `RdfReasoner`) vs. constructor injection. Choose whichever avoids global
  mutation and keeps the public API identical. Confirm Vite does not activate the
  `node` condition in browser mode before finalising.
- *(R4 — technical)* `dist/worker-node.mjs` must ship in the npm package.
  Determine whether it lives in `src/` as a static `.mjs` copied by a postbuild
  script, and verify it is included in the `files` array.
- *(R3, R7 — needs research)* Confirm minimum Vite version and webpack 5 config
  for the pthreads WASM + Worker combination. Verify COOP/COEP Vite dev-server
  config syntax before writing R7 docs.
- *(R11 — technical)* Decide on the `chown` strategy for the root-owned `dist/`:
  one-time manual step documented in CONTRIBUTING, or a Makefile/script target
  that runs before build.

## Next Steps

`-> /ce-plan`
