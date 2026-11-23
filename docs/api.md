# API reference

`rdf-reasoner-konclude` exposes one class, `RdfReasoner`, plus constants, error classes and two helpers. It reasons over **N3.js `Store`** objects with **RDF.js `Quad`** terms. Reasoning runs in a Web Worker (Node: a worker thread) around the Konclude WebAssembly kernel.

- [Concepts](#concepts)
- [Constructor](#constructor)
- [Properties](#properties)
- [Reasoning](#reasoning): `reason`, `classify`, `checkConsistency`, `materialize`, `classifyProperties`
- [Queries](#queries): `getUnsatisfiableClasses`, `isSatisfiable`, `isEntailed`, `isEntailedGraph`
- [Hypothetical reasoning](#hypothetical-reasoning): `whatIf`
- [Explanations](#explanations): `explain`, `explainEntailment`, `explainInconsistency`, `explainInconsistencyAxioms`, `explainInconsistencyLaconic`
- [Repair](#repair): `repair`, `assessEdit`, `weaken`
- [Validation](#validation): `validate`
- [Lifecycle](#lifecycle): `terminate`
- [Errors](#errors)
- [Constants](#constants)
- [Helpers](#helpers)
- [Result types](#result-types)

Options (defaults, cost, when to change) are in [options.md](options.md). SWRL is in [swrl.md](swrl.md). What OWL 2 DL constructs and tests are covered is in [owl2-conformance.md](owl2-conformance.md).

## Concepts

**Stores and graphs.** Every method takes a `Store`. Inferred triples are written *into the same store*, in a named graph (default `urn:konclude:inferred`, constant `INFERRED_GRAPH_IRI`). The graph is cleared before each call that writes it. Asserted triples are everything else; the reasoner reads the union of all graphs except its own inferred, hypothetical and explanation graphs and the ones you list in `excludeGraphs`. Named graphs are dropped when the ontology is sent to the kernel.

**Self-invalidating calls.** Every call hands the store's current content to the kernel. The kernel compares it with what it holds (order, duplicates and Store identity do not matter) and rebuilds only when the content changed. Repeating a call on unchanged content is cheap; changing a triple invalidates cached results. Blank-node labels count as content.

**Serialization.** Calls on one instance are queued: concurrent calls never interleave. Create **one** `RdfReasoner` per application or per test file; each instance owns a Worker with its own thread pool.

**Open world.** OWL 2 DL is open-world. `isEntailed` answers `true` (entailed), `false` (**not entailed**, which does not mean refuted) or `null` (not decided: unsupported shape, inconsistent ontology, aborted check). Classes absent from the taxonomy are treated as satisfiable.

**Inconsistent ontologies.** Reasoning methods return empty results on an inconsistent ontology without a signal, unless you pass `failOnInconsistent: true` (then `InconsistentOntologyError`). Use `checkConsistency` first if unsure.

**Input rewrites.** Before the ontology reaches the kernel some RDF constructs are rewritten into equivalent forms the kernel's mapper understands (negative property assertions, `owl:bottomDataProperty`, OWL 1 style boolean class constructors on named classes, disjoint data properties, `owl:hasKey`, canonical form of `rdf:XMLLiteral`). This applies on every call and is deterministic, so it never causes extra rebuilds. Inferred triples are mapped back to the original IRIs.

## Constructor

```typescript
const reasoner = new RdfReasoner(options?: RdfReasonerOptions);
await reasoner.ready; // resolves when the WASM module is loaded
```

| Option | Default | Meaning |
|---|---|---|
| `workerUrl` | resolved from `import.meta.url` | URL of the worker script |
| `worker` | | a pre-constructed Worker (use when your bundler cannot analyse `new Worker(url)`) |
| `workerFactory` | | creates a fresh Worker; used for the first one and for restarts after a stall; takes precedence over `worker`/`workerUrl` |
| `onTrace` | | callback for trace/log lines of the WASM worker (main-thread output only) |
| `stallTimeoutMs` | `600000` | idle watchdog: a call with no progress this long rejects with `ReasonerStalledError` (the worker is restarted and the call retried once first) |
| `recycleHeapBytes` | 2 GiB | the Worker is replaced when its heap exceeds this, only when changed content arrives |
| `excludeGraphs` | none | graphs that never count as axioms |
| `illTypedLiterals` | `"report"` | `"report"`, `"error"` or `"ignore"`; see [options.md](options.md#ill-typed-literals) |

`ready: Promise<void>` rejects when the module fails to load.

## Properties

| Property | Type | Meaning |
|---|---|---|
| `ready` | `Promise<void>` | module loaded |
| `illTypedLiterals` | `"report" \| "error" \| "ignore"` | mutable at any time |
| `lastLiteralIssues` | `{ issues: LiteralIssue[]; total: number }` | numeric/boolean literals of the last synced store outside their datatype. `LiteralIssue`: `{ subject, predicate, lexical, datatype, reason: "ill-typed" \| "out-of-range" \| "beyond-kernel-integers", detail }` |
| `lastSwrl` | `{ rules, unsupported: string[], rounds, derived, applied }` | result of the last `materialize` ([swrl.md](swrl.md#api)) |

## Reasoning

All return a `Promise`; those that write inferred triples resolve to `void` (or the delta, see `materialize`).

### `reason(store, opts?)`

Deprecated entry point (`mode: "classify" | "consistency" | "full"`); prefer the methods below. Writes inferred triples to `opts.inferredGraph`.

### `classify(store, opts?: StoreReasoningOptions): Promise<void>`

TBox reasoning: writes the inferred class hierarchy (`rdfs:subClassOf`, `owl:equivalentClass`) and unsatisfiable classes (`owl:Nothing`) to the inferred graph. No ABox realization. Options: `inferredGraph`, `failOnInconsistent`, `explanations`, **`closure`** (write the transitive closure instead of the reduced hierarchy, default `false`).

### `checkConsistency(store): Promise<boolean>`

`true` when the ontology has a model. Runs only the kernel's consistency step (no classification). Writes nothing. Be aware: the kernel's consistency step alone can miss an individual that belongs to an unsatisfiable class (W3C `description-logic-008` family); `materialize` catches it afterwards.

### `materialize(store, opts?: MaterializeStoreOptions): Promise<void | { delta }>`

ABox realization: writes inferred `rdf:type` assertions (all types, not only the most specific), property assertions (role closure incl. super-properties and inverses), `owl:sameAs` (symmetric and transitive), and data-property values through `rdfs:subPropertyOf` / equivalent properties. Individuals are recognised from any `rdf:type <class>` assertion; `owl:NamedIndividual` is not required.

| Option | Default | |
|---|---|---|
| `inferredGraph` | `urn:konclude:inferred` | graph that receives the triples |
| `includeClassHierarchy` | `false` | also write `subClassOf` / `equivalentClass` |
| `closure` | `false` | with `includeClassHierarchy`: write the transitive closure |
| `swrl` | `true` | apply the store's DL-safe SWRL rules ([swrl.md](swrl.md)) |
| `returnDelta` | `false` | resolve to `{ delta: { added, removed } }` against the previous inferred state |
| `explanations` | `false` | also build the justification graph |
| `failOnInconsistent` | `false` | reject with `InconsistentOntologyError` |

Also rejects with `InconsistentOntologyError` when an asserted individual belongs to an unsatisfiable class (independent of `failOnInconsistent`), or when SWRL rule consequences make the ontology inconsistent.

### `classifyProperties(store, opts?: ClassifyPropertiesStoreOptions): Promise<void>`

Property hierarchy: writes `rdfs:subPropertyOf` (equivalents as mutual subproperties). Options: `inferredGraph`, `failOnInconsistent`, `explanations`, `closure`.

## Queries

### `getUnsatisfiableClasses(store, opts?): Promise<string[]>`

IRIs of the classes equivalent to `owl:Nothing` (`owl:Nothing` itself excluded). Classes absent from the taxonomy are not listed.

### `isSatisfiable(store, classIRI, opts?): Promise<boolean>`

`false` if the class is equivalent to `owl:Nothing`; `true` for any class absent from the taxonomy. `owl:Nothing` is always unsatisfiable (no kernel call).

### `isEntailed(store, axiom: Quad, opts?): Promise<boolean | null>` and `isEntailed(store, axioms: Quad[], opts?): Promise<(boolean | null)[]>`

Is the axiom, given as a triple, entailed? Reasoning is triggered at most once per required operation, so a batch is cheaper than separate calls.

| Axiom (as triple) | How it is decided |
|---|---|
| `A rdfs:subClassOf B`, `A owl:equivalentClass B` | classification; reachability over the reduced hierarchy (chains, reflexive, `Thing`, unsatisfiable classes below everything) |
| `a rdf:type C` | realization |
| `p rdfs:subPropertyOf q`, `p owl:equivalentProperty q` | property classification; for object properties a `false` is re-checked with a refutation probe |
| `a owl:sameAs b` | realization; symmetric, transitive, reflexive |
| `A owl:disjointWith B` | probe classes (one batch) |
| `a P o` with `P` a declared object or data property | refutation: `a : not (P value o)` inconsistent |
| `P rdfs:range D`, `P rdfs:domain C` | refutation probe (also datatype ranges: `p range byte` entails `p range short`) |
| `P rdf:type owl:TransitiveProperty` ... (symmetric, asymmetric, reflexive, irreflexive, functional, inverse functional) | probe with fresh individuals |
| `X rdf:type owl:Class` ... (declarations) | always `true` |
| any other predicate | `null` and a console warning |

`null` also for an inconsistent ontology (a vacuous `true` would say nothing). Options: `inferredGraph`, `failOnInconsistent`.

### `isEntailedGraph(store, conclusion: Quad[] | Store, opts?): Promise<boolean | null>`

Is a small RDF **graph** entailed? The conclusion may contain blank nodes and annotation triples (the shape of W3C OWL 2 entailment tests). It is a conjunction; every part must be entailed.

- triples of named terms: as `isEntailed`;
- `s p _:x` where the blank node starts a tree (types and further properties; no sharing, no cycles): decided by a refutation probe of `s : ∃p.D`;
- annotation triples: `true` when found in the store, also through `owl:sameAs`, equivalent classes and equivalent properties of the subject; absence is `null`, never `false`;
- anything else (shared blank nodes, cycles, free-standing blank nodes, anonymous class expressions as a type): `null`.

Returns `false` when a part is not entailed, `null` when undecided. An unsound `true` is never returned for an unrecognised shape.

## Hypothetical reasoning

### `whatIf(store, additions: Quad[], opts?: WhatIfOptions): Promise<{ added: Quad[]; removed: Quad[] }>`

Materialize over `store ∪ additions \ opts.removals` without touching the store's base triples or the inferred graph. `added` / `removed` are relative to the current inferred graph. `opts.outputGraph` (must differ from the inferred and hypothetical graphs) also writes the hypothetical inferences to the store. `failOnInconsistent` applies to the hypothetical ontology.

## Explanations

All take `ExplainOptions` (or an extension): `maxJustifications` (default 1), `axiomFilter(q)`, `inferredGraph`, `timeout` (default 180000 ms, `0` = none; on timeout the justifications found so far are returned). Justifications are minimal sets of axiom *units* (a restriction is one unit), computed by QuickXplain plus a hitting-set tree. Inferred triples must be excluded (`inferredGraph`), otherwise an inferred triple would explain itself.

| Method | Returns |
|---|---|
| `explain(store, axiom: Quad, opts?)` | `Quad[][]` minimal subsets of the base quads that each alone entail the axiom; `[]` if not entailed; throws for unsupported predicates (unlike `isEntailed`) |
| `explainEntailment(store, s, p, o, opts?: ExplainEntailmentOptions)` | `EntailmentResult`: `isEntailed` (`null` when inconsistent), `justifications`, `ontologyInconsistent`, `vacuous`, `justificationUnavailable`, `reason`. Option `justificationMode`: `"fast"` (cheap sound candidates first; may set `justificationUnavailable`) or `"exact"` (always minimal). Supports `subClassOf`, `type`, property assertions of declared properties |
| `explainInconsistency(store, opts?)` | `Quad[][]` minimal inconsistent sub-ontologies (MIPS); `[]` if consistent |
| `explainInconsistencyAxioms(store, opts?)` | `AxiomJustification[]`: justifications grouped into OWL axioms (`axioms`), declarations separate (`context`) |
| `explainInconsistencyLaconic(store, opts?: LaconicExplainOptions)` | per justification the laconic parts that drive the clash (`laconicMaxAxioms` default 20, `laconicMaxParts` default 40) |

For `classify` / `materialize` / `classifyProperties` the `explanations: true` option additionally writes a justification graph (`urn:konclude:explanations`, vocabulary `KJ_*`).

## Repair

Repairs never mutate your store. After them the reasoner's own state is on a copy, so your next normal call reloads once (about 0.6 s on PMDco).

### `repair(store, opts?: RepairOptions): Promise<RepairResult>`

Complete sets of axioms whose removal restores consistency. Options: `justifications` (seed from `explainInconsistencyAxioms`), `maxJustifications` (3), `maxRepairs` (10), `maxRounds` (10), `cost(axiom)` (lower = preferred to remove), `verify` (true), `timeout` (300000), `inferredGraph`. Result: `{ consistent, justifications, repairs: [{ remove: Axiom[], covers, verifiedConsistent, minimal }], incomplete, reason? }`.

### `assessEdit(store, edit: Edit, opts?): Promise<EditAssessment>`

What does a proposed edit (`{ remove?: Quad[], add?: Quad[] }`) cost? Reports whether the result is consistent and which asserted class-disjointness pairs are no longer entailed (`lostDisjointPairs`, `null` when the edited ontology is inconsistent). Options: `pairs`, `deriveFromHierarchy`, `timeout` (180000), `inferredGraph`.

### `weaken(store, culprit: Axiom, opts?): Promise<WeakenResult>`

Offers weaker replacements for a culprit `rdfs:subClassOf` axiom instead of deleting it (generalize a conjunct, drop a conjunct, delete), every one verified on a copy. `opts.alsoRemove` lists the other axioms of the repair being applied together. Result `weakenings` ordered most specific first, `reason` for unsupported axioms or deadlines.

## Validation

### `validate(store, opts?: ValidateOptions): Promise<ValidationResult>`

Consistency, unsatisfiable classes and justifications in one call: `{ consistent, errors: Quad[][], warnings: [{ classIRI, justifications }] }`. Options: `maxJustificationsPerError` (1), `maxJustificationsPerWarning` (1; `0` skips the search and returns only the class list), `axiomFilter`, `timeout`, `inferredGraph`.

## Lifecycle

### `terminate(): void`

Terminates the Worker and rejects pending calls. Always call it when done, or use TypeScript 5.2 `using`:

```typescript
{
  using reasoner = new RdfReasoner();
  await reasoner.ready;
  await reasoner.classify(store);
} // terminated here
```

A `FinalizationRegistry` is only a safety net. Creating and terminating many Workers in one process exhausts the thread pool: share one instance.

## Errors

| Class | Thrown when |
|---|---|
| `InconsistentOntologyError` | `failOnInconsistent: true` and the ontology is inconsistent; `materialize` finds an individual in an unsatisfiable class; SWRL consequences make the ontology inconsistent |
| `ReasonerStalledError` | a call made no progress for `stallTimeoutMs`, after one automatic worker restart and retry. Properties: message with the method and idle time |
| `InvalidLiteralError` | `illTypedLiterals: "error"` and a literal is outside its datatype. Property `issues: LiteralIssue[]` |

Kernel traps (for example out of memory) reject the call with an `Error`; the next call recreates the Worker.

## Constants

| Constant | Value | Use |
|---|---|---|
| `INFERRED_GRAPH_IRI` | `urn:konclude:inferred` | default graph for inferred triples |
| `HYPOTHETICAL_IRI` | `urn:konclude:hypothetical` | graph of what-if triples (excluded from the digest) |
| `EXPLANATION_GRAPH_IRI` | `urn:konclude:explanations` | justification graph |
| `KJ_NS`, `KJ_JUSTIFICATION`, `KJ_JUSTIFIES`, `KJ_AXIOM` | `urn:konclude:justification#...` | vocabulary of the justification graph |

The SWRL consequences carry the graph `urn:konclude:swrl` in the delta of `materialize`.

## Helpers

- **`createManagedStore(store): Store`**: wraps a Store so that writes to the inferred graph throw `RangeError`. Use it to protect inferred triples from accidental edits.
- **`createInlineWorker(koncludeModuleUrl): Worker`**: runs the WASM module in the *current* thread instead of spawning a nested Worker. Use it when your code already runs inside a Web Worker (nested workers are fragile or unsupported under the Vite dev server and some browsers): `new RdfReasoner({ worker: createInlineWorker(url) })`.

## Result types

Exported types: `StoreReasoningOptions`, `MaterializeOptions`, `MaterializeStoreOptions`, `ClassifyPropertiesStoreOptions`, `InferenceDelta`, `WhatIfOptions`, `InconsistencyGuardOptions`, `ExplainOptions`, `ExplainEntailmentOptions`, `LaconicExplainOptions`, `LaconicPart`, `LaconicJustification`, `EntailmentResult`, `Axiom`, `AxiomJustification`, `RepairOptions`, `Repair`, `RepairResult`, `Edit`, `DisjointPair`, `AssessEditOptions`, `EditAssessment`, `WeakenOptions`, `Weakening`, `WeakenResult`, `ValidateOptions`, `ValidationResult`, `ClassWarning`, `RdfReasonerOptions`, `LiteralIssue`, `ReasoningOptions` and `ReasoningResult` (reserved, used by the deprecated `reason()`).

Field-level documentation of each type is in its TSDoc comment in `ts/types.ts`; the published `dist/index.d.ts` carries the same comments.
