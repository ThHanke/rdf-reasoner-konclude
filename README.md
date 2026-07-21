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

// TBox: class hierarchy (rdfs:subClassOf, owl:equivalentClass)
await reasoner.classify(store);

// ABox: individual type entailments (rdf:type)
await reasoner.materialize(store);
await reasoner.materialize(store, { includeClassHierarchy: true }); // TBox + ABox

// Property hierarchy (rdfs:subPropertyOf)
await reasoner.classifyProperties(store);

// Consistency
const ok = await reasoner.checkConsistency(store); // true = consistent

// Entailment queries (post-reasoning)
const entailed = await reasoner.isEntailed(store, quad);
const results = await reasoner.isEntailed(store, [quad1, quad2]);

// Hypothetical reasoning
const { added, removed } = await reasoner.whatIf(store, [newAxiom]);

// Explanation / justification
const justs = await reasoner.explain(store, quad, { maxJustifications: 3 });
const inconsJusts = await reasoner.explainInconsistency(store);

// Satisfiability
const classes = await reasoner.getUnsatisfiableClasses(store);
const ok2 = await reasoner.isSatisfiable(store, "http://example.org/MyClass");

// Combined diagnostic
const report = await reasoner.validate(store);
// report.consistent, report.errors (Quad[][]), report.warnings (ClassWarning[])

reasoner.terminate(); // shut down the Worker
```

`classify(store)`, `materialize(store)`, and `classifyProperties(store)` write
inferred triples into the `INFERRED_GRAPH_IRI` named graph inside the store.
The graph is cleared before each call — do not store ontology triples there.

Named graphs in the input are dropped at the WASM boundary (NTriples wire
format is triple-only). Reasoning runs over the union of all graphs.

Options for `classify(store, opts)`, `materialize(store, opts)`, and `classifyProperties(store, opts)`:

```typescript
// classify, classifyProperties
interface StoreReasoningOptions {
  inferredGraph?: string; // default: INFERRED_GRAPH_IRI
}

// materialize
interface MaterializeStoreOptions {
  inferredGraph?: string; // default: INFERRED_GRAPH_IRI
  includeClassHierarchy?: boolean; // also emit subClassOf/equivalentClass; default false
}
```

Options for the Phase 2 axiom-work methods:

```typescript
// isEntailed: no options

// whatIf
interface WhatIfOptions {
  removals?: Quad[]; // quads to remove from the base ontology
  outputGraph?: string; // named graph for hypothetical inferences
}

// explain / explainInconsistency
interface ExplainOptions {
  maxJustifications?: number; // default: 1
  axiomFilter?: (q: Quad) => boolean; // restrict candidate axiom set
}

// validate
interface ValidateOptions {
  maxJustificationsPerError?: number; // default: 1
  maxJustificationsPerWarning?: number; // default: 1  (pass 0 for IRI-only scan)
  axiomFilter?: (q: Quad) => boolean;
}
```

Return types for the Phase 2 axiom-work methods:

```typescript
// Return types
isEntailed(store, axiom: Quad):    Promise<boolean | null>
isEntailed(store, axioms: Quad[]): Promise<(boolean | null)[]>
whatIf(store, additions):          Promise<{ added: Quad[], removed: Quad[] }>
explain(store, axiom):             Promise<Quad[][]>          // [] if not entailed; throws for unsupported predicate
explainInconsistency(store):       Promise<Quad[][]>          // [] if consistent
validate(store):                   Promise<ValidationResult>
// where:
interface ValidationResult {
  consistent: boolean;
  errors:     Quad[][];       // MIPS; non-empty only when consistent === false
  warnings:   ClassWarning[]; // one per unsatisfiable class
}
interface ClassWarning {
  classIRI:       string;
  justifications: Quad[][];
}
```

### `INFERRED_GRAPH_IRI`

```typescript
import { INFERRED_GRAPH_IRI } from "rdf-reasoner-konclude";
// "urn:konclude:inferred"
```

The default named graph where inferred triples are written.

### Deprecated overloads

`reason(quads)`, `classify(quads)`, `checkConsistency(quads)`, and `materialize(quads)` accept a raw `Iterable<Quad>` and return `Promise<Quad[]>` / `Promise<boolean>`. These overloads are deprecated — use the `Store`-based API instead.

## Common workflows

All examples assume a single `RdfReasoner` instance:

```typescript
import { RdfReasoner, INFERRED_GRAPH_IRI } from "rdf-reasoner-konclude";
import { Store, Parser, DataFactory } from "n3";

const reasoner = new RdfReasoner();
await reasoner.ready;
```

### TBox only: classify a class hierarchy

Use `classify(store)` when the ontology has no named individuals. Returns
`rdfs:subClassOf` and `owl:equivalentClass` entailments.

```typescript
await reasoner.classify(store);
const subClasses = store.getQuads(
  null,
  "http://www.w3.org/2000/01/rdf-schema#subClassOf",
  null,
  INFERRED_GRAPH_IRI,
);
```

### ABox: derive individual types

Use `materialize(store)` when the ontology includes named individuals. Returns
`rdf:type` entailments for every individual that can be classified under the
TBox. Classification runs internally as part of realization — no separate call
needed.

```typescript
await reasoner.materialize(store);
const types = store.getQuads(
  null,
  "http://www.w3.org/1999/02/22-rdf-syntax-ns#type",
  null,
  INFERRED_GRAPH_IRI,
);
```

To also receive the class hierarchy in the same call:

```typescript
await reasoner.materialize(store, { includeClassHierarchy: true });
```

### Property hierarchy

Use `classifyProperties(store)` to infer `rdfs:subPropertyOf` entailments.
Requires `owl:ObjectProperty` / `owl:DatatypeProperty` declarations in the
ontology.

```typescript
await reasoner.classifyProperties(store);
const subProps = store.getQuads(
  null,
  "http://www.w3.org/2000/01/rdf-schema#subPropertyOf",
  null,
  INFERRED_GRAPH_IRI,
);
```

### Combine class hierarchy + property hierarchy

`INFERRED_GRAPH_IRI` is cleared by each call, so write results to separate
named graphs if you need both at once:

```typescript
await reasoner.classify(store, { inferredGraph: "urn:myapp:class-inferred" });
await reasoner.classifyProperties(store, {
  inferredGraph: "urn:myapp:prop-inferred",
});
```

Or if storing them together is fine, call in sequence and read after both:

```typescript
await reasoner.classify(store);
const classTriples = store.getQuads(null, null, null, INFERRED_GRAPH_IRI);

await reasoner.classifyProperties(store); // clears + repopulates INFERRED_GRAPH_IRI
const propTriples = store.getQuads(null, null, null, INFERRED_GRAPH_IRI);
```

### Consistency checking

```typescript
const consistent = await reasoner.checkConsistency(store);
if (!consistent) {
  console.error("Ontology is inconsistent");
}
```

### Incremental ontology evolution

The reasoner resets and re-loads the full store on every call. To reason over
an evolving ontology, mutate the store and call again:

```typescript
await reasoner.classify(store);
// → first inference written to INFERRED_GRAPH_IRI

// Add new axioms
store.addQuad(
  DataFactory.quad(
    DataFactory.namedNode("http://example.org/Cat"),
    DataFactory.namedNode("http://www.w3.org/2000/01/rdf-schema#subClassOf"),
    DataFactory.namedNode("http://example.org/Animal"),
  ),
);

// Re-reason: INFERRED_GRAPH_IRI is cleared and fully repopulated
await reasoner.classify(store);
```

Concurrent calls on the same `RdfReasoner` instance are serialized
automatically — queued calls run in order, never interleaved.

### Checking if a specific entailment holds (`isEntailed`)

`isEntailed` supports `rdfs:subClassOf`, `owl:equivalentClass`, `rdf:type`, and
`rdfs:subPropertyOf`. Returns `null` for unsupported predicates.

```typescript
await reasoner.materialize(store);
const isAnimal = await reasoner.isEntailed(
  store,
  DataFactory.quad(
    DataFactory.namedNode("http://example.org/Fido"),
    DataFactory.namedNode("http://www.w3.org/1999/02/22-rdf-syntax-ns#type"),
    DataFactory.namedNode("http://example.org/Animal"),
  ),
);
// true if Fido rdf:type Animal is entailed
```

### Hypothetical reasoning (`whatIf`)

`whatIf` reasons over a temporary store mutation without modifying the input store.

```typescript
const { added, removed } = await reasoner.whatIf(store, [newAxiom]);
// added/removed are deltas relative to the current INFERRED_GRAPH_IRI
```

### Explaining an entailment (`explain`)

`explain` returns minimal justifications — each is the smallest set of axioms
that alone entails the target. Returns `[]` if the axiom is not entailed.
Each BlackBox call issues multiple Worker round-trips; use `maxJustifications: 1`
for cheap first-justification lookups.

```typescript
const justs = await reasoner.explain(store, quad, { maxJustifications: 3 });
// justs: Quad[][] — each inner array is one minimal justification
```

### Explaining an entailment triple (`explainEntailment`)

`explainEntailment` explains why a specific triple is entailed by the ontology.
All 16 entailment types use native dep-chain cache or TS synthesis (~1ms).
BlackBox (5-13s) is available as opt-in via `justificationMode: "minimal"`.

```typescript
const result = await reasoner.explainEntailment(
  store,
  "http://example.org/alice",
  "http://www.w3.org/1999/02/22-rdf-syntax-ns#type",
  "http://example.org/Animal",
);
// result.isEntailed — true/false/null (null when ontology is inconsistent)
// result.justifications — Quad[][], each is a set of axioms explaining the entailment
```

**Supported entailment types:**

| Predicate | Method | Speed |
|-----------|--------|-------|
| `rdfs:subClassOf` | Native dep-chain cache | ~1ms |
| `rdf:type` (subClassOf chain) | Native (classification + asserted type) | ~1ms |
| `rdf:type` (realization) | Native (clash-path hook) | ~1ms |
| `rdf:type` (someValuesFrom) | Synthesized (restriction + role scan) | <1ms |
| `rdf:type` (minCardinality) | Synthesized (restriction + filler count) | <1ms |
| `owl:sameAs` (FP/IFP) | Synthesized (FP/IFP pattern scan) | <1ms |
| `owl:sameAs` (native) | Native (realization cache) | ~1ms |
| `owl:equivalentClass` | Native (bidirectional subClassOf) | ~1ms |
| `owl:disjointWith` | Native (classification cache) | ~1ms |
| `owl:equivalentProperty` | Synthesized (assertion scan) | <1ms |
| `rdfs:subPropertyOf` | Native (clash-path hook) | ~1ms |
| `rdfs:domain` / `rdfs:range` | Native (GCI in taxonomy) | ~1ms |
| `disjointUnionOf` → `subClassOf` | Synthesized (RDF list walk) | <1ms |
| `owl:oneOf` → `rdf:type` | Synthesized (member scan) | <1ms |
| Data property assertions | Asserted-triple lookup | <1ms |
| Object property assertions | Asserted-triple lookup | <1ms |

Full coverage matrix with test cases: [`docs/entailment-coverage.md`](docs/entailment-coverage.md)

**Options:**

- `justificationMode` — controls how justifications are computed:
  - `"causal"` (default): native dep chain + TS synthesis. Returns the causal
    proof path (~1ms). No BlackBox fallback.
  - `"minimal"`: BlackBox MIPS. Guaranteed smallest axiom set (5-13s per call).
- `objectIsClassLike: false` — treat the object as a non-class entity (e.g., literal).
  Enables data property explanation.
- `maxJustifications` — maximum number of justifications to return (default: 1).
  Only applies to the `"minimal"` mode; native/synthesis paths return at most one.

### Diagnosing an inconsistency (`explainInconsistency`)

Returns minimal inconsistent sub-ontologies (MIPS). Returns `[]` on consistent ontologies.

```typescript
const mips = await reasoner.explainInconsistency(store);
if (mips.length > 0) {
  console.log("Minimal inconsistent core:", mips[0]);
}
```

### Finding unsatisfiable classes (`getUnsatisfiableClasses`, `isSatisfiable`)

`owl:Nothing` is excluded from the output. Classes absent from the taxonomy
return `true` from `isSatisfiable` (open-world assumption).

```typescript
const unsatClasses = await reasoner.getUnsatisfiableClasses(store);
// ["http://example.org/EmptyClass", ...]

const ok = await reasoner.isSatisfiable(store, "http://example.org/MyClass");
// false if MyClass is equivalent to owl:Nothing in the ontology
```

### Full ontology validation (`validate`)

`validate` combines consistency checking, unsatisfiable-class detection, and
optional justification computation in a single call.

```typescript
const report = await reasoner.validate(store);
// report.consistent — true/false
// report.errors     — Quad[][], minimal inconsistent sub-ontologies (non-empty when inconsistent)
// report.warnings   — ClassWarning[], one per unsatisfiable class

// Cheap IRI-only scan (skip BlackBox justifications for warnings):
const quickReport = await reasoner.validate(store, {
  maxJustificationsPerWarning: 0,
});
```

`errors` are non-empty only when `consistent` is `false`. When `consistent` is
`true`, only `warnings` may be present. Callers should check `consistent` before
acting on `warnings`.

### Separate inferred graph per operation

The `INFERRED_GRAPH_IRI` graph is cleared before each call. If you need to
preserve results from a previous call while re-reasoning with a different
operation, use separate named graphs:

```typescript
await reasoner.classify(store, { inferredGraph: "urn:myapp:class-hierarchy" });
await reasoner.materialize(store, { inferredGraph: "urn:myapp:abox-types" });

// Both named graphs now coexist in the store
const classTriples = store.getQuads(
  null,
  null,
  null,
  "urn:myapp:class-hierarchy",
);
const typeTriples = store.getQuads(null, null, null, "urn:myapp:abox-types");
```

### Node.js and browser: same API

`RdfReasoner` is identical in both environments. Under Node.js the `"node"`
export condition in `package.json` loads `index.node.mjs`, which installs a
`NodeWorkerShim` over `node:worker_threads` that matches the browser `Worker`
interface. The worker dispatch code (`dist/worker.js`) and all protocol messages
are shared. No code changes are needed when porting between environments.

## OWL 2 DL coverage

Konclude implements the full OWL 2 DL tableau (expressivity SROIQ(D)). The sections below
document what has been verified to work, what is known not to work, and what the WASM port
does not yet surface as output.

### Consistency checking (`checkConsistency`)

Violation detection verified against native Konclude v0.7.0 ground truth:

| #   | Violation pattern                                         | Native             | WASM           | Status                             |
| --- | --------------------------------------------------------- | ------------------ | -------------- | ---------------------------------- |
| 1   | `owl:disjointWith` (direct)                               | inconsistent ✓     | inconsistent ✓ | **PARITY**                         |
| 2   | `owl:disjointWith` (via domain/range inference)           | inconsistent ✓     | inconsistent ✓ | **PARITY**                         |
| 3   | `owl:AsymmetricProperty` bidirectional assertion          | consistent ✗ (bug) | inconsistent ✓ | **PARITY (WASM surpasses native)** |
| 4   | `owl:IrreflexiveProperty` self-reference                  | consistent ✗ (bug) | inconsistent ✓ | **PARITY (WASM surpasses native)** |
| 5   | `owl:maxQualifiedCardinality` + `owl:differentFrom`       | inconsistent ✓     | inconsistent ✓ | **PARITY**                         |
| 6   | `owl:allValuesFrom` + `owl:disjointWith`                  | inconsistent ✓     | inconsistent ✓ | **PARITY**                         |
| 7   | `owl:ReflexiveProperty` + `ObjectComplementOf(HasSelf)`   | inconsistent ✓     | inconsistent ✓ | **PARITY**                         |
| 8   | `owl:InverseFunctionalProperty` + `DifferentIndividuals`  | inconsistent ✓     | inconsistent ✓ | **PARITY**                         |
| 9   | `owl:AllDisjointClasses` (3-way) + double membership      | inconsistent ✓     | inconsistent ✓ | **PARITY**                         |
| 10  | `DisjointObjectProperties` + `EquivalentObjectProperties` | consistent ✗ (bug) | inconsistent ✓ | **PARITY (WASM surpasses native)** |
| 11  | `owl:disjointUnionOf` + double membership                 | inconsistent ✓     | inconsistent ✓ | **PARITY**                         |
| 12  | `owl:NegativeObjectPropertyAssertion` contradiction       | inconsistent ✓     | inconsistent ✓ | **PARITY**                         |
| 13  | `DataAllValuesFrom xsd:minInclusive` (consistent case)    | consistent ✓       | consistent ✓   | **PARITY**                         |
| 14  | `DataAllValuesFrom xsd:minInclusive` (inconsistent case)  | inconsistent ✓     | inconsistent ✓ | **PARITY**                         |

**PARITY (WASM surpasses native v0.7.0)** means native Konclude v0.7.0 has a kernel bug for this
construct; this package fixes it via patches 011–012 (role axiom correctness, NPA builder fix).

`owl:AllDisjointClasses`, `owl:disjointUnionOf`, and `owl:NegativePropertyAssertion` all work in
`materialize()` — the JS layer expands list axioms to pairwise form before handing off to WASM.
The only known remaining gap is `owl:FunctionalProperty` + `owl:InverseFunctionalProperty` on the
same role with a single filler (ALIF+ precompute hang). This case is tracked in
`tests/integration/known-limitations.test.ts`.

### Classification (`classify`)

Verified working:

- `rdfs:subClassOf` — transitive closure, with `owl:equivalentClass` folding
- `owl:intersectionOf`, `owl:unionOf`, `owl:complementOf`
- `owl:someValuesFrom`, `owl:allValuesFrom`
- `owl:minCardinality`, `owl:maxCardinality`, `owl:exactCardinality`
- `owl:minQualifiedCardinality`, `owl:maxQualifiedCardinality`, `owl:qualifiedCardinality`
- `owl:ObjectProperty` with `rdfs:domain`, `rdfs:range`, `owl:inverseOf`
- `owl:TransitiveProperty`, `owl:FunctionalProperty`, `owl:InverseFunctionalProperty`
- `owl:ReflexiveProperty`, `owl:SymmetricProperty`
- `owl:propertyChainAxiom`

### ABox realization (`materialize`)

`materialize(store)` infers `rdf:type` entailments for named individuals under the
class hierarchy. Verified working on ontologies up to ~25 000 individuals (LUBM + data).

Input ABox axioms accepted:

- `rdf:type` assertions
- Object property assertions (`owl:ObjectProperty`)
- `owl:differentFrom` / `owl:AllDifferent`

### Known output gaps

| Feature                                   | Status                                    |
| ----------------------------------------- | ----------------------------------------- |
| `rdfs:subPropertyOf` (property hierarchy) | Available via `classifyProperties(store)` |
| `owl:sameAs` entailments                  | Emitted by `materialize()` ✓              |
| `owl:differentFrom` entailments           | Not emitted (accepted as input ✓)         |
| Data property assertions                  | Emitted by `materialize()` ✓              |

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

- decode. Input RDF is pre-parsed into quads before the timing window — NTriples/Turtle parsing
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
