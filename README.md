# rdf-reasoner-konclude

[![npm version](https://img.shields.io/npm/v/rdf-reasoner-konclude)](https://www.npmjs.com/package/rdf-reasoner-konclude)
[![license](https://img.shields.io/badge/license-LGPL--3.0--or--later-blue)](LICENSE)

OWL-DL tableau reasoning via [Konclude](https://github.com/konclude/Konclude) compiled to WebAssembly, with an async TypeScript API using RDF.js Quad types.

## Installation

```bash
npm install rdf-reasoner-konclude
```

TypeScript users should also install the RDF.js type declarations:

```bash
npm install --save-dev @rdfjs/types
```

## CLI

Run OWL-DL reasoning on a local file — no JavaScript required:

```bash
# One-off via npx
npx rdf-reasoner-konclude --input ontology.ttl --output inferred.nt

# Or install globally
npm install -g rdf-reasoner-konclude
owl-reason --input ontology.ttl
```

| Flag       | Short | Description                                    | Default                        |
| ---------- | ----- | ---------------------------------------------- | ------------------------------ |
| `--input`  | `-i`  | Input RDF file (`.nt` `.ttl` `.nq` `.trig`)    | stdin                          |
| `--output` | `-o`  | Output file                                    | stdout                         |
| `--mode`   | `-m`  | `classify` \| `consistency`                    | `classify`                     |
| `--format` | `-f`  | Output format: `nt` \| `ttl` \| `nq` \| `trig` | auto from extension, else `nt` |

Input format is auto-detected from the file extension; `--format` overrides both input and output format.

Exit codes: `0` = success / consistent, `1` = inconsistent (consistency mode), `2` = error.

### Docker

No local Node.js needed — use the official image:

```bash
docker run --rm \
  -v $(pwd):/data \
  -w /data \
  node:22-slim \
  npx rdf-reasoner-konclude --input ont.ttl
```

## Node.js quick-start

```typescript
import { RdfReasoner, INFERRED_GRAPH_IRI } from "rdf-reasoner-konclude";
import { Store, Parser } from "n3";

// Load your ontology into an N3 Store
const store = new Store();
const parser = new Parser({ format: "Turtle" });
parser.parse(
  `
  @prefix owl: <http://www.w3.org/2002/07/owl#> .
  @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
  :A rdfs:subClassOf :B .
  :B rdfs:subClassOf :C .
`,
  (err, quad) => {
    if (quad) store.addQuad(quad);
  },
);

const reasoner = new RdfReasoner();
await reasoner.ready;

await reasoner.reason(store);

// Inferred triples are written into the INFERRED_GRAPH_IRI named graph
const inferred = store.getQuads(null, null, null, INFERRED_GRAPH_IRI);
console.log(inferred.map((q) => `${q.subject.value} → ${q.object.value}`));
// e.g. [ ':A → :C' ]  (transitive subClassOf)

reasoner.terminate();
```

No Worker setup needed — Node.js 18+ picks up the `"node"` export condition which installs a `worker_threads` shim automatically.

## Browser / Vite quick-start

```typescript
import { RdfReasoner, INFERRED_GRAPH_IRI } from "rdf-reasoner-konclude";
import { Store } from "n3";

const store = new Store(/* ... your quads ... */);
const reasoner = new RdfReasoner();
await reasoner.ready;

await reasoner.reason(store);

const inferred = store.getQuads(null, null, null, INFERRED_GRAPH_IRI);
```

The browser build requires COOP/COEP HTTP headers for `SharedArrayBuffer` (used by pthreads). See [Browser Deployment](#browser-deployment) for server configuration.

## API reference

### `RdfReasoner`

```typescript
const reasoner = new RdfReasoner();
await reasoner.ready; // resolves when WASM module is loaded

await reasoner.reason(store); // classify + write inferred triples into store
await reasoner.classify(store); // alias for reason(store)
const ok = await reasoner.checkConsistency(store); // returns boolean

reasoner.terminate(); // shut down the Worker
```

`reason(store)` and `classify(store)` write inferred triples into the
`INFERRED_GRAPH_IRI` named graph inside the store. The graph is cleared before
each call — do not store ontology triples there.

Named graphs in the input are dropped at the WASM boundary (NTriples wire
format is triple-only). Reasoning runs over the union of all graphs.

Options for `reason(store, opts)` and `classify(store, opts)`:

```typescript
interface StoreReasoningOptions {
  inferredGraph?: string; // IRI of the named graph for inferred triples
  // default: INFERRED_GRAPH_IRI
}
```

### `INFERRED_GRAPH_IRI`

```typescript
import { INFERRED_GRAPH_IRI } from "rdf-reasoner-konclude";
// "urn:konclude:inferred"
```

The default named graph where inferred triples are written by `reason(store)`.

### Deprecated overloads

`reason(quads: Iterable<Quad>)` and `classify(quads)` / `checkConsistency(quads)` accept a raw `Iterable<Quad>` and return `Promise<Quad[]>` / `Promise<boolean>`. These overloads are deprecated — use the `Store`-based API instead.

## Browser deployment

The WASM binary uses pthreads, which requires `SharedArrayBuffer`. Browsers
block `SharedArrayBuffer` unless the page is cross-origin isolated:

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

### Vite dev server

```js
// vite.config.js
export default {
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
};
```

### nginx (production)

```nginx
add_header Cross-Origin-Opener-Policy same-origin;
add_header Cross-Origin-Embedder-Policy require-corp;
```

### Caddy (production)

```caddyfile
header {
    Cross-Origin-Opener-Policy same-origin
    Cross-Origin-Embedder-Policy require-corp
}
```

### webpack 5

```js
// webpack.config.js
module.exports = { experiments: { asyncWebAssembly: true } };
```

## Performance

Benchmarked on an 8-core Linux host. Native = Konclude v0.7.0 Docker image; WASM Node.js = Node.js 20 via this package; WASM Browser = Chromium 135 via this package. All WASM runs use 8 threads. Median of 3 runs after 1 warmup.

| Ontology           | Expressivity | NTriples | Native ¹ | WASM Node.js ² | WASM Browser ² | Node ratio |
| ------------------ | ------------ | -------- | -------- | -------------- | -------------- | ---------- |
| LUBM schema        | SHI          | 307      | 34 ms    | 207 ms         | 202 ms         | ~6×        |
| GALEN              | SHIF         | 30 817   | 286 ms   | 968 ms         | 852 ms         | ~3.4×      |
| Roberts family     | SROIQ        | 3 866    | 2 118 ms | 38 769 ms      | 37 903 ms      | ~18×       |
| LUBM schema + data | SHI          | 100 850  | 1 017 ms | 1 672 ms       | 1 965 ms       | ~1.6×      |

¹ Native pipeline (OWL 2 XML parse + classify/realize). Native uses `classification` for
TBox-only ontologies and `realization` for ontologies with individuals (Roberts family,
LUBM + data) — matching WASM's operation selection. LUBM schema ratio is dominated by
fixed WASM startup cost (pthreads pool init) on a tiny 307-triple ontology.

² WASM timing covers binary buffer encode (Quads → buffer) + `loadTripleBuffer` + realization
+ decode. Input RDF is pre-parsed into quads before the timing window — NTriples/Turtle parsing
is excluded, matching what your application pays after data is already loaded into a Store.
Node.js 20 and Chromium 135 are within ~12% of each other on most ontologies; Roberts family
(SROIQ with ABox realization) is effectively equal.

Run `npm run bench` to reproduce (requires a built WASM binary — see [Build from source](#build-from-source)).

### What each fixture tests

**LUBM schema** (SHI, TBox-only) — a shallow university-domain ontology: 49 classes, 25 object
properties, 36 subclass edges, one transitive property. No individuals. Konclude runs pure
classification; actual tableau work is trivial. The 207 ms is almost entirely pthread pool
startup on a 307-triple ontology.

**GALEN** (SHIF, TBox-only) — a medical terminology ontology: 4 740 classes, 413 object
properties, 150 functional properties, 26 transitive properties, and 3 446 existential
restrictions (`someValuesFrom`) cross-connected to 3 237 subclass edges. No individuals.
The dense restriction graph drives TBox saturation — constraints propagate across thousands
of interleaved concept/role pairs. SHIF adds functional property reasoning on top. This is
pure classification load.

**Roberts family** (SROIQ, TBox + ABox) — a genealogy ontology: 171 classes, 80 object
properties, 405 named individuals, 11 symmetric properties, 8 transitive properties, and
24 property chain axioms (`owl:propertyChainAxiom`). SROIQ is the full OWL 2 DL
expressiveness. The 405 individuals trigger ABox realization — Konclude computes the type
of every individual under every applicable concept while propagating role chains across the
family tree. Role chains require joining property paths, which multiplies the search space.
This is why 3 866 triples takes 38 s.

**LUBM schema + data** (SHI, TBox + ABox) — the same shallow TBox combined with ~25 000
individuals (students, professors, courses across multiple universities). SHI has no property
chains or nominals, so ABox realization is type propagation only: each individual is
classified under the existing concept hierarchy. Cost scales roughly linearly with individual
count rather than combinatorially, hence the 1.6× native ratio despite 25 000 instances.

## How it works

```text
main thread
  RdfReasoner.reason(store)
    → encode Store quads to binary buffer (zero-copy, no NTriples serialization)
    → postMessage to Worker

Worker (pthreads WASM, 8 threads)
  → KoncludeReasoner::loadTripleBuffer()   // binary buffer → librdf model (Raptor2)
  → mapTriples()                           // librdf → OWL expression model
  → KoncludeReasoner::realization()        // OWL-DL tableau + ABox (KPSet, 8 pthreads)
  │    or KoncludeReasoner::classification() // TBox-only (no individuals)
  → KoncludeReasoner::getInferredTripleBuffer()
    → postMessage result back (zero-copy ArrayBuffer transfer)

main thread
  → decode binary buffer → Quad[]
  → write into store[INFERRED_GRAPH_IRI]
```

The WASM binary is compiled from Konclude's C++ tableau engine with Qt removed
(replaced by `std::` shims) and pthreads enabled. The KPSet classifier requires
real threads — cooperative dispatch deadlocks. Method names mirror the native
Konclude CLI commands (`classification`, `realization`, `consistency`).

## Build from source

Requires Docker. First build (Raptor2 + librdf cross-compile + kernel) takes
roughly 20–30 minutes. Subsequent runs use ccache and skip already-built libs.

```bash
# 1. Populate submodule and pre-apply Qt-removal patches
git submodule update --init
bash scripts/apply-patches.sh

# 2. Cross-compile Raptor2/librdf for WASM and build the kernel
docker compose run --rm build

# 3. Verify
docker compose run --rm smoke-test

# 4. Compile TypeScript
npm run build
```

Incremental rebuild (Raptor/librdf already built):

```bash
docker compose run --rm build
```

Interactive shell:

```bash
docker compose run --rm shell
```

## Licence

The TypeScript wrapper and build scripts in this repository are licensed under
**LGPL-3.0-or-later**. See [LICENSE](LICENSE).

The WASM binary (`dist/konclude.wasm`) contains the Konclude reasoning kernel,
which is © University of Ulm and also released under **LGPLv3**.

As required by LGPLv3 §4, complete Konclude source with all applied
modifications is available at:

<https://github.com/ThHanke/rdf-reasoner-konclude>

Clone with `--recurse-submodules` to obtain `vendor/konclude/` (Konclude source)
and `patches/` (every modification). To recompile: `docker compose run --rm build`.

See [NOTICE](NOTICE) for full third-party notices.

> Steigmiller, A., Liebig, T., & Glimm, B. (2014). _Konclude: System Description._
> Journal of Web Semantics, 27–28, 78–85. doi:10.1016/j.websem.2014.06.003

## Acknowledgements

[Konclude](https://github.com/konclude/Konclude) was developed by
[Andreas Steigmiller](https://github.com/andreas-steigmiller) at the Institute
of Artificial Intelligence, University of Ulm. The system description paper
(cited above) has co-authors Thorsten Liebig and Birte Glimm, also from the
University of Ulm. All credit for the reasoning algorithm belongs to Andreas
Steigmiller. This package is an independent WebAssembly port developed with AI
assistance from [Claude](https://anthropic.com) (Anthropic).
