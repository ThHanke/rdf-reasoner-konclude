---
title: "feat: Docker CLI for file-based OWL reasoning + repo DX improvements"
type: feat
status: active
date: 2026-05-13
---

# feat: Docker CLI for file-based OWL reasoning + repo DX improvements

## Overview

Add an `owl-reason` CLI to the npm package and a slim Docker runtime image for users who want file-based OWL-DL reasoning without writing JavaScript — like ROBOT from OBO. Also improve repo DX: permission allowlist, Makefile, and CLAUDE.md command reference.

## Problem Frame

The package only exposes a JS/TS library API. Users who want command-line reasoning over local files have no path without writing a wrapper. A Docker CLI image removes this barrier. The repo DX improvements reduce friction for iterative Claude-assisted development (fewer approval prompts, named Makefile targets, documented commands).

## Requirements Trace

- R1. `owl-reason` binary: `--input`, `--output`, `--mode`, `--format`, `--help`, `--version`
- R2. Input formats: Turtle (.ttl), N-Triples (.nt), N-Quads (.nq), TriG (.trig) — all N3.js native
- R3. Output formats: same; default N-Triples
- R4. Stdin/stdout pipe support: omit `--input` for stdin, omit `--output` for stdout
- R5. Exit codes: 0 = success/consistent, 1 = inconsistent (consistency mode), 2 = error
- R6. README documents Docker usage via stock `node:22-slim` + `npx` (no custom image needed)
- R7. Permission allowlist in `.claude/settings.json`
- R8. Makefile with named targets: `build`, `test`, `build-wasm`, `smoke`, `reason`, `shell`, `patches`
- R9. CLAUDE.md updated with dev command reference

## Scope Boundaries

- No OWL/XML input (no rdfxml parser dep in v1)
- No streaming I/O (batch: load full graph → reason → write)
- No custom Docker image (stock node:22-slim + npx is sufficient)
- No subcommand style (`owl-reason reason ...`) — flag-based only

## Context & Research

### Relevant Code and Patterns

- `ts/index.ts`: `RdfReasoner` — primary API; Worker lifecycle
- `ts/index.node.mjs`: Node.js export shim — sets up `worker_threads` polyfill; CLI must use this path
- `ts/worker.ts`: N3.js serialization patterns (Writer/Parser)
- `ts/types.ts`: `INFERRED_GRAPH_IRI`, `StoreReasoningOptions`
- `tests/smoke/smoke.mjs`: existing Node.js `RdfReasoner` usage pattern to follow
- `docker-compose.yml`: existing services (`build`, `smoke-test`, `shell`) — add `reason` service
- `package.json`: no `bin` field yet; `n3` is peerDep only
- `tests/fixtures/`: test ontology files (.ttl, .nt) available for CLI test scenarios

### Institutional Learnings

- Node.js WASM pthreads work natively — SharedArrayBuffer available; no COOP/COEP needed in Docker
- N3.js is the correct serialization layer (already used in worker.ts)
- Worker import must go through `index.node.mjs` in Node.js to get the `worker_threads` polyfill

## Key Technical Decisions

- **CLI import path**: `dist/cli.js` must import `RdfReasoner` via the `index.node.mjs` path (not raw `index.js`) to get `worker_threads` shim. Simplest approach: `ts/cli.ts` imports from `'./index.ts'` at TS level; postbuild step rewrites that import to `'./index.node.mjs'` in compiled `dist/cli.js`.
- **n3 as direct dep**: Move `n3` from `peerDependencies` to `dependencies`. CLI cannot function without it; Docker image has no peer resolution. Acceptable breaking change at 0.1.x pre-stable.
- **Shebang**: Postbuild script prepends `#!/usr/bin/env node` to `dist/cli.js` and `chmod +x` — tsc strips shebangs by default.
- **Runtime Dockerfile**: Separate `Dockerfile.cli` (not a stage of existing `Dockerfile`). Existing `Dockerfile` is Emscripten build env; do not entangle with runtime image.
- **Arg parsing**: `node:util parseArgs` — built-in, zero deps, sufficient for v1 flag set.
- **Permission allowlist**: `.claude/settings.json` (project-level, committed).

## Open Questions

### Resolved During Planning

- CLI framework: `node:util parseArgs`, no yargs/commander
- Format detection: from file extension; `--format` overrides; default `nt` for stdin
- n3 dep placement: move to `dependencies`

### Deferred to Implementation

- Exact TypeScript import wiring for `RdfReasoner` in Node.js (postbuild rewrite vs. plain `.mjs` wrapper) — implementer picks simpler path after seeing tsc output
- N3.js streaming vs. batch: start batch; revisit if memory is a problem on large ontologies

## Output Structure

```
ts/
└── cli.ts              # new CLI entry
dist/
└── cli.js              # compiled + shebang via postbuild
Makefile                # new task runner
.claude/
└── settings.json       # permission allowlist (new or updated)
```

## Implementation Units

- [x] **Unit 1: CLI TypeScript entry point**

**Goal:** Implement `ts/cli.ts` — file/stdin input, reasoning, file/stdout output, correct exit codes.

**Requirements:** R1, R2, R3, R4, R5

**Dependencies:** None (uses existing `RdfReasoner` + n3)

**Files:**
- Create: `ts/cli.ts`
- Test: `tests/unit/cli.test.ts`

**Approach:**
- `parseArgs` from `node:util` for flags: `--input`, `--output`, `--mode` (`classify`|`consistency`; default `classify`), `--format` (`nt`|`ttl`|`nq`|`trig`; default `nt`), `--version`, `--help`
- Read: `fs.readFileSync` if `--input` given; else drain stdin to Buffer
- Detect format from file extension when `--format` not given; fallback `nt` for stdin
- Parse with N3.js `Parser` → `n3.Store`
- `classify`: call `reasoner.reason(store)` → write quads from `INFERRED_GRAPH_IRI` via N3.js `Writer` to output file or stdout
- `consistency`: call `reasoner.checkConsistency(store)` → print `consistent` or `inconsistent`; exit 1 if inconsistent
- Call `reasoner.terminate()` before exit
- Errors (file not found, parse error, WASM error) → stderr + exit 2

**Patterns to follow:**
- `tests/smoke/smoke.mjs` — Node.js `RdfReasoner` usage
- N3.js patterns in `ts/worker.ts`

**Test scenarios:**
- Happy path: `--input tests/fixtures/pizza.ttl` → stdout contains expected subclass triples; exit 0
- Happy path: `--input tests/fixtures/lubm.nt --output /tmp/out.nt` → file written with ≥1 triple; exit 0
- Happy path consistency/consistent: `--input tests/fixtures/lubm.nt --mode consistency` → stdout `consistent`; exit 0
- Happy path consistency/inconsistent: inconsistent fixture → stdout `inconsistent`; exit 1
- Edge case: `--format nt` on Turtle file → parse error → stderr message; exit 2
- Edge case: nonexistent file path → stderr message; exit 2
- Edge case: empty stdin with no `--input` → exit 2 (empty graph error or empty output)
- Edge case: `--help` → usage printed; exit 0

**Verification:**
- `node dist/cli.js --input tests/fixtures/lubm.nt` outputs N-Triples to stdout; exit 0
- `node dist/cli.js --mode consistency --input tests/fixtures/lubm.nt` exits 0

---

- [x] **Unit 2: package.json + tsconfig + postbuild shebang**

**Goal:** Wire `owl-reason` bin entry; make n3 a direct dep; add shebang to compiled CLI.

**Requirements:** R1, R6

**Dependencies:** Unit 1 exists

**Files:**
- Modify: `package.json`
- Modify: `README.md` (Docker usage section)
- Modify: `tsconfig.json` (only if cli.ts is not already in compilation scope)

**Approach:**
- Add `"bin": { "owl-reason": "./dist/cli.js" }` to `package.json`
- Move `n3` from `peerDependencies` to `dependencies` — with `n3` as a direct dep, `npx rdf-reasoner-konclude` installs it automatically; no extra step needed
- Add `dist/cli.js` to `files` array if package.json has explicit files list
- Extend `scripts.postbuild`: prepend `#!/usr/bin/env node` to `dist/cli.js` and `chmod +x dist/cli.js`
- Confirm `tsconfig.json` `include` covers `ts/cli.ts` (should if `ts/**/*` glob used)
- Add "Docker usage" section to README showing stock `node:22-slim` + npx pattern (no custom image):

```bash
docker run --rm \
  -v $(pwd):/data \
  -w /data \
  node:22-slim \
  npx rdf-reasoner-konclude --input ont.ttl
```

**Patterns to follow:**
- Existing `scripts.postbuild` (already copies .mjs files)

**Test scenarios:**
- Test expectation: none — config changes; verified by build succeeding and `head -1 dist/cli.js` = `#!/usr/bin/env node`

**Verification:**
- `npm run build` completes without error
- `head -1 dist/cli.js` outputs `#!/usr/bin/env node`
- `node dist/cli.js --version` prints version from package.json

---

- [x] **Unit 3: Repo DX — Makefile, permission allowlist, CLAUDE.md**

**Goal:** Reduce friction for iterative development; fewer approval prompts; documented commands.

**Requirements:** R8, R9, R10

**Dependencies:** None (independent of CLI units)

**Files:**
- Create: `Makefile`
- Create or modify: `.claude/settings.json`
- Modify: `CLAUDE.md`

**Approach:**

*Makefile targets:*
- `build` — `npm run build` (TypeScript compilation only)
- `build-wasm` — `docker compose run --rm build` (full WASM rebuild, ~20–30 min)
- `test` — `npm test`
- `smoke` — `docker compose run --rm smoke-test`
- `reason` — `node dist/cli.js $(ARGS)` (usage: `make reason ARGS="--input ont.ttl"`)
- `shell` — `docker compose run --rm shell`
- `patches` — `npm run apply-patches`
- `fmt` — `trunk fmt`
- `lint` — `trunk check`

*Permission allowlist* (`.claude/settings.json` `allow` list):
- Read-only shell: `ls`, `find`, `grep`, `cat`, `head`, `tail`, `wc`, `diff`
- Git: `git status`, `git log`, `git diff`, `git show`
- Node/npm: `npm run build`, `npm run test`, `npm test`, `node *`, `npx *`
- Make: `make build`, `make test`, `make smoke`, `make lint`, `make fmt`, `make patches`
- Trunk: `trunk check`, `trunk fmt`
- Keep outside allowlist (ask first): `docker compose run --rm build` (heavy), `git push`, `rm -rf`, `sudo *`

*CLAUDE.md additions*:
- Add "Common Commands" section near top with Makefile target reference table
- Document Docker ownership issue: `dist/` becomes root-owned after `docker compose run build`; fix with `sudo chown -R $USER dist/`
- Document patch workflow: edit `vendor/konclude/`, `scripts/generate-patches.sh`, `make patches`
- Document incremental rebuild path (ccache makes repeated WASM builds fast)

**Test scenarios:**
- Test expectation: none — config/docs; verified by `make test` succeeding

**Verification:**
- `make build` succeeds
- `make test` runs vitest suite
- `.claude/settings.json` is valid JSON

## System-Wide Impact

- **API surface parity:** CLI is a consumer of existing `RdfReasoner` API; no TS API changes
- **n3 dep promotion:** Moving n3 from peerDep to dep means library users no longer need to install it separately. Acceptable at 0.1.x pre-stable; document in changelog.
- **Unchanged invariants:** Worker lifecycle, WASM binary, `RdfReasoner` class API — all untouched
- **Known limitation:** `checkConsistency()` currently always returns `true` (bug tracked in publish plan Unit 8). CLI consistency mode works correctly once that fix lands; document in `--help` output until then.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `ts/cli.ts` Node.js Worker import path | Follow `smoke.mjs` pattern; use `index.node.mjs` import; postbuild rewrite if needed |
| n3 dep promotion breaks tree-shaking for library consumers | Acceptable at 0.1.x; note in CHANGELOG |
| Shebang stripped by tsc | Postbuild script; verify with `head -1 dist/cli.js` in CI |
| Docker runtime image too large | node:22-slim keeps total ~350 MB; acceptable for CLI |
| `checkConsistency()` broken until publish-plan Unit 8 | Document limitation in CLI `--help`; CLI otherwise works for classify mode |

## Sources & References

- Related plan: [docs/plans/2026-05-12-008-feat-package-publish-plan.md](docs/plans/2026-05-12-008-feat-package-publish-plan.md)
- Smoke test pattern: [tests/smoke/smoke.mjs](tests/smoke/smoke.mjs)
- Node.js Worker shim: [ts/index.node.mjs](ts/index.node.mjs)
- Existing Docker services: [docker-compose.yml](docker-compose.yml)
