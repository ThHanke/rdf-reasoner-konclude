# rdf-reasoner-konclude

[![npm version](https://img.shields.io/npm/v/rdf-reasoner-konclude)](https://www.npmjs.com/package/rdf-reasoner-konclude)
[![license](https://img.shields.io/badge/license-LGPL--3.0--or--later-blue)](LICENSE)

OWL-DL tableau reasoning via [Konclude](https://github.com/konclude/Konclude) compiled to WebAssembly, with an async TypeScript API using RDF.js Quad types.

## Installation

```bash
npm install rdf-reasoner-konclude n3
```

`n3` is a required peer dependency (used for NTriples serialization/deserialization).

## Node.js quick-start

```typescript
import { RdfReasoner, INFERRED_GRAPH_IRI } from 'rdf-reasoner-konclude';
import { Store, Parser } from 'n3';

// Load your ontology into an N3 Store
const store = new Store();
const parser = new Parser({ format: 'Turtle' });
parser.parse(`
  @prefix owl: <http://www.w3.org/2002/07/owl#> .
  @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
  :A rdfs:subClassOf :B .
  :B rdfs:subClassOf :C .
`, (err, quad) => { if (quad) store.addQuad(quad); });

const reasoner = new RdfReasoner();
await reasoner.ready;

await reasoner.reason(store);

// Inferred triples are written into the INFERRED_GRAPH_IRI named graph
const inferred = store.getQuads(null, null, null, INFERRED_GRAPH_IRI);
console.log(inferred.map(q => `${q.subject.value} → ${q.object.value}`));
// e.g. [ ':A → :C' ]  (transitive subClassOf)

reasoner.terminate();
```

No Worker setup needed — Node.js 18+ picks up the `"node"` export condition which installs a `worker_threads` shim automatically.

## Browser / Vite quick-start

```typescript
import { RdfReasoner, INFERRED_GRAPH_IRI } from 'rdf-reasoner-konclude';
import { Store } from 'n3';

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
await reasoner.ready;              // resolves when WASM module is loaded

await reasoner.reason(store);      // classify + write inferred triples into store
await reasoner.classify(store);    // alias for reason(store)
const ok = await reasoner.checkConsistency(store); // returns boolean

reasoner.terminate();              // shut down the Worker
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
import { INFERRED_GRAPH_IRI } from 'rdf-reasoner-konclude';
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
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
}
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
module.exports = { experiments: { asyncWebAssembly: true } }
```

## Performance

Benchmarked on an 8-core Linux host. Native = Konclude v0.7.0 binary; TS = Node.js 20 via this package. Threads: 8 (both native and WASM pthreads).

| Ontology | Expressivity | NTriples | Native classify | TS total | Ratio |
| --- | --- | --- | --- | --- | --- |
| LUBM schema | SHI | 307 | 35 ms | 266 ms | ~7.3× |
| GALEN | SHIF | 30 817 | 225 ms | 941 ms | ~4.2× |
| Roberts family | SROIQ | 3 866 | 1 801 ms | 2 603 ms | ~1.4× |
| LUBM schema + data | SHI | 100 850 | 160 ms | 2 104 ms | ~13× |

TS total includes NTriples serialization/deserialization (the main JS overhead).
The WASM classify step alone is within 1.4×–7.3× of native. Run `npm run bench`
to reproduce (requires a built WASM binary — see [Build from source](#build-from-source)).

## How it works

```text
main thread
  RdfReasoner.reason(store)
    → serialize Store quads to NTriples (n3.js Writer)
    → postMessage to Worker

Worker (pthreads WASM)
  → KoncludeReasoner::loadNTriples()     // NTriples → librdf model (Raptor2)
  → mapTriples()                         // librdf → OWL expression model
  → KoncludeReasoner::classify()         // OWL-DL tableau (KPSet, parallel)
  → KoncludeReasoner::getInferredNTriples()
    → postMessage result back

main thread
  → parse NTriples → Quad[] (n3.js Parser)
  → write into store[INFERRED_GRAPH_IRI]
```

The WASM binary is compiled from Konclude's C++ tableau engine with Qt removed
(replaced by `std::` shims) and pthreads enabled. The KPSet classifier requires
real threads — cooperative dispatch deadlocks.

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

> Liebig, T., Jaeger, M., Möller, R., & Möller, B. (2014). *Konclude: System Description.*
> Web Semantics, 27–28, 78–85. doi:10.1016/j.websem.2014.06.003

## Acknowledgements

Konclude was developed at the Institute of Artificial Intelligence, University
of Ulm, by Thorsten Liebig, Murat Özcep, Stefan Wandelt, and others. All
credit for the reasoning algorithm belongs to the Konclude authors. This
package is an independent WebAssembly port developed with AI assistance from
[Claude](https://anthropic.com) (Anthropic).
