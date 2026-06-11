---
title: "fix: route WASM stderr via postMessage instead of console.error in worker"
type: fix
status: active
date: 2026-06-11
---

# fix: route WASM stderr via postMessage instead of console.error in worker

## Context

The published npm dist v0.3.1 contains `dist/worker.js` with:

```js
const initPromise = createKoncludeModule({
  print: () => {},
  printErr: (msg) => console.error(msg)   // ← wrong
})
```

`console.error` is a side-channel from a Worker context — it bypasses the structured
`postMessage` protocol, behaves inconsistently across environments (browser vs Node.js
workers), and cannot be intercepted or suppressed by the caller. Best practice: all
Worker output must flow through `self.postMessage`.

The local source `ts/worker.ts` already uses the correct form:

```ts
printErr: (msg: string) => self.postMessage({ type: "log", msg })
```

The ontosphere repo works around the dist gap via `patch-package`
(`patches/rdf-reasoner-konclude+0.3.1.patch`). The goal of this plan is to eliminate
that workaround by publishing a corrected dist.

## Why it cannot be configured from outside the worker

`createKoncludeModule()` is called **eagerly at worker module load time** — the WASM
boots before the main thread can send any message. There is no init-time data channel
from `RdfReasoner` to the worker, so `printErr` cannot be injected after the fact.
The only correct fix is to ship the right default in the dist.

For future true configurability (e.g. `new RdfReasoner({ onLog })`) a `configure`
protocol message sent before the first command would be required — that is explicitly
**out of scope** for this plan. The structured-postMessage default is sufficient.

## Scope

- Fix `ts/worker.ts` `printErr` default → `self.postMessage({ type: "log", msg })`
  (already correct in local source; this plan is about verifying, rebuilding, publishing)
- Verify `ts/index.ts` message router handles `{ type: "log" }` gracefully (discard or forward)
- Bump version to `0.3.2`, rebuild dist, publish to npm
- Update ontosphere `package.json` to `^0.3.2`
- Delete `patches/rdf-reasoner-konclude+0.3.1.patch` from ontosphere
- Verify `npm install` in ontosphere no longer applies any patch for this package

Out of scope: configurable `onLog` callback, changes to the Konclude C++ kernel,
changes to any other part of the TypeScript API.

## Implementation steps

### 1. Verify local source is already correct

```bash
grep "printErr" ts/worker.ts
# Expected: printErr: (msg: string) => self.postMessage({ type: "log", msg })
```

### 2. Verify log message is silently discarded in main thread

In `ts/index.ts`, the message router should handle or ignore `{ type: "log" }`.
If the router falls through to an unhandled-message warning, add an explicit discard:

```ts
case "log":
  // WASM stderr — silently discard (caller can intercept via onLog if needed)
  break;
```

### 3. Bump version

```bash
npm version patch   # 0.3.1 → 0.3.2
```

### 4. Rebuild dist

```bash
npm run build       # rebuilds ts/ → dist/
```

Verify `dist/worker.js` contains `self.postMessage` not `console.error`:

```bash
grep "printErr" dist/worker.js
# Expected: printErr: (msg) => self.postMessage({ type: "log", msg })
```

### 5. Run tests

```bash
npm test
npm run test:browser   # if available
```

### 6. Publish

```bash
npm publish
```

### 7. Update ontosphere

In `/home/hanke/ontosphere`:

```bash
npm install rdf-reasoner-konclude@0.3.2
```

Delete the now-redundant patch:

```bash
rm patches/rdf-reasoner-konclude+0.3.1.patch
```

Update `scripts/copy-konclude-assets.mjs` if the patch comment references the old version.

Run `npm install` once more to confirm `patch-package` no longer applies anything for
`rdf-reasoner-konclude` (it should log nothing for that package).

## Verification

1. `npm test` in rdf-reasoner-konclude passes
2. `npx vitest run` in ontosphere passes (265 tests)
3. In browser devtools, running reasoning on the inconsistency fixture produces no
   `console.error` output from the worker; Konclude progress lines appear only as
   structured messages (or not at all if discarded)
4. `patches/` directory in ontosphere contains no file matching `rdf-reasoner-konclude*`
