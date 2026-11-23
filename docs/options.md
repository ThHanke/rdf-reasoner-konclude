# Options reference: what is on, what is off, how to change it

Every option of `RdfReasoner` and of its methods in one place, with its default, what it does, what it costs, and when to change it. Options that **change behaviour or output** are marked **new** (added with the PR #18 adoption).

- [Defaults at a glance](#defaults-at-a-glance)
- [Opt-out features (on by default)](#opt-out-features-on-by-default)
- [Opt-in features (off by default)](#opt-in-features-off-by-default)
- [Safety and reporting](#safety-and-reporting)
- [Output shape](#output-shape)
- [Graph handling](#graph-handling)
- [Worker and resource options](#worker-and-resource-options)
- [Read-only status properties](#read-only-status-properties)
- [Methods whose answers changed](#methods-whose-answers-changed)
- [Recipes](#recipes)

## Defaults at a glance

| Option | Where | Default | Kind | Section |
|---|---|---|---|---|
| `swrl` **new** | `materialize` | `true` | opt-**out** | [SWRL](#swrl-materialize) |
| `illTypedLiterals` **new** | `new RdfReasoner({...})` and property | `"report"` | choose a mode | [Ill-typed literals](#ill-typed-literals) |
| `closure` **new** | `classify`, `classifyProperties`, `materialize` | `false` | opt-**in** | [Hierarchy closure](#hierarchy-closure) |
| `includeClassHierarchy` | `materialize` | `false` | opt-in | [Output shape](#output-shape) |
| `failOnInconsistent` | `classify`, `materialize`, `classifyProperties`, `isEntailed`, ... | `false` | opt-in | [Safety](#fail-on-inconsistent) |
| `returnDelta` | `materialize` | `false` | opt-in | [Output shape](#output-shape) |
| `explanations` | `classify`, `materialize`, `classifyProperties` | `false` | opt-in | [Output shape](#output-shape) |
| `inferredGraph` | most methods | `urn:konclude:inferred` | choose a graph | [Graph handling](#graph-handling) |
| `excludeGraphs` | constructor | none | choose graphs | [Graph handling](#graph-handling) |
| `stallTimeoutMs` | constructor | `600000` | tune | [Worker](#worker-and-resource-options) |
| `recycleHeapBytes` | constructor | 2 GiB | tune | [Worker](#worker-and-resource-options) |

## Opt-out features (on by default)

### SWRL (`materialize`)

```typescript
await reasoner.materialize(store); // DL-safe SWRL rules in the store are applied
await reasoner.materialize(store, { swrl: false }); // rules are ignored
```

- **Default: on.** If the store holds `swrl:Imp` rules, `materialize` applies them and writes the consequences to the inferred graph.
- **Cost:** none without rules, 1.0x for rules that never match, 2.5x when rules derive thousands of triples (one extra kernel round). Details: [swrl.md](swrl.md#cost).
- **Turn it off when** you want pure OWL reasoning (same result as before SWRL support), or when a rule set is large and you do not need its consequences in the result.
- **With `swrl: false`** the rules are still listed in `reasoner.lastSwrl` with `applied: false`, so an application can say "N rules were not applied".
- A call with the other setting on an unchanged store is recomputed, never served from the cache.
- Only `materialize` applies rules; `classify`, `checkConsistency` and `isEntailed` never do.

## Opt-in features (off by default)

### Hierarchy closure

```typescript
await reasoner.classify(store, { closure: true });
await reasoner.classifyProperties(store, { closure: true });
await reasoner.materialize(store, { includeClassHierarchy: true, closure: true });
```

- **Default: off.** The inferred graph holds the *reduced* hierarchy the classifier reports: direct `subClassOf` / `subPropertyOf` edges, equivalents as `equivalentClass`.
- **With `closure: true`** the transitive closure is written: `A subClassOf C` for `A ⊑ B ⊑ C`, mutual `subClassOf` and `equivalentClass` between all members of an equivalence group, the same for properties. Triples already in a source graph are not repeated. Reflexive pairs are not written.
- **Why:** a consumer that only reads the graph (SPARQL, SHACL, an app) then needs no reasoning to see every entailed subsumption. This is the deductive closure under OWL 2 direct semantics, open world: it contains nothing the classification did not entail.
- **Cost:** about 6 to 9 times the direct edges in triples (PMDco 1,612 to 10,572 pairs, GALEN 3,382 to 30,795), a few milliseconds of computing.
- `materialize` writes the class closure only together with `includeClassHierarchy: true` (without it the hierarchy is not part of the output).
- `isEntailed` answers `A ⊑ C` with or without this option (it follows the reduced hierarchy itself); `closure` is only about what is written into the graph.

## Safety and reporting

### Ill-typed literals

```typescript
const reasoner = new RdfReasoner({ illTypedLiterals: "report" }); // default
reasoner.illTypedLiterals = "error"; // can be changed between calls
console.log(reasoner.lastLiteralIssues); // { issues: [...], total }
```

| Mode | Behaviour |
|---|---|
| `"report"` (**default**) | Numeric and boolean literals outside their datatype are listed in `lastLiteralIssues`; reasoning continues exactly as before |
| `"error"` | The call rejects with `InvalidLiteralError` naming the first literal |
| `"ignore"` | No scan |

- **What is checked:** the integer-derived XSD datatypes (lexical form and value bounds), `xsd:decimal`, `xsd:float`, `xsd:double`, `xsd:boolean`, and integers beyond the kernel's 64 bits. Other datatypes are not checked.
- **Why this exists:** the kernel drops an ill-typed literal silently (`"5abc"^^xsd:integer`, `"1.5"^^xsd:integer`, `"300"^^xsd:byte`), so it has no effect on the result. With `"report"` the drop is visible.
- **Why "report" is the default:** real data is sloppy (`"1.0"^^xsd:integer`, `"N/A"^^xsd:decimal` from spreadsheet conversions). `"error"` would make every call on such a store fail, including for users who never needed that literal. Choose `"error"` for strict validation pipelines.
- **The remaining wrong answer in `"report"` mode:** a dropped literal that would have caused an inconsistency (for example a value outside a declared range) is not noticed by the reasoner, only reported.
- **Cost:** one pass over the store's literals per synced call; no measurable cost on PMDco.

### Fail on inconsistent

`failOnInconsistent: true` (on `classify`, `materialize`, `classifyProperties`, `isEntailed`, `getUnsatisfiableClasses`, `isSatisfiable`, `whatIf`): reject with `InconsistentOntologyError` when the ontology is inconsistent, instead of returning an empty result without a signal. Default `false`. Costs one consistency check per changed content, and for `materialize` one extra rebuild (the realization variant differs from the consistency one).

`materialize()` additionally rejects with `InconsistentOntologyError` when an asserted individual belongs to an unsatisfiable class, **regardless of this option**: the kernel's consistency step misses some of these (a stopgap in TypeScript, see the decisions log).

## Output shape

| Option | Method | Default | Effect |
|---|---|---|---|
| `includeClassHierarchy` | `materialize` | `false` | also write `subClassOf` / `equivalentClass` triples, not only `rdf:type` and property assertions |
| `returnDelta` | `materialize` | `false` | resolve to `{ delta: { added, removed } }` against the previous inferred state |
| `explanations` | `classify`, `materialize`, `classifyProperties` | `false` | also build the justification graph (costs time: the survey in `tests/integration/explanation-overhead-survey.test.ts`) |
| `mode` | one-shot `reason()` | | `"classify"`, `"consistency"` or `"full"` |

Explanations of a `materialize` that applied SWRL rules are those of the first realization, without the rule consequences.

## Graph handling

- **`inferredGraph`** (most methods, default `urn:konclude:inferred`): the named graph that receives inferred triples. It is cleared before each call; do not keep ontology triples in it. Each call that omits it uses the default graph, never the graph of an earlier call.
- **`excludeGraphs`** (constructor): graphs that never count as axioms (for example graphs of previous inference runs, SHACL results). Inferred graphs seen by an instance are excluded automatically.
- Named graphs are dropped at serialization: the reasoner works on the union of all non-excluded graphs.

## Worker and resource options

- **`stallTimeoutMs`** (default 600000): the idle watchdog. A reasoning call that shows no progress for this long is rejected with `ReasonerStalledError`, the worker restarted and the call retried once. Lower it for interactive use.
- **`recycleHeapBytes`** (default 2 GiB): the worker is replaced when its heap exceeds this, only when changed content arrives.
- **`workerUrl`, `worker`, `workerFactory`, `onTrace`:** worker construction and tracing, see the README.
- **Thread stacks:** since the stall fix the build uses 2 MiB per thread (`-sSTACK_SIZE`, `-sDEFAULT_PTHREAD_STACK_SIZE`, `emscripten.cmake`); this is a build setting, not a runtime option.

## Read-only status properties

| Property | Meaning |
|---|---|
| `lastSwrl` **new** | `{ rules, unsupported, rounds, derived, applied }` of the last `materialize` |
| `lastLiteralIssues` **new** | `{ issues, total }` of the last synced store (see [Ill-typed literals](#ill-typed-literals)) |

## Methods whose answers changed

`isEntailed` answers some questions it used to answer with `null` or a wrong `false`. Applications that treat `null` as "unsupported" will now get a definite answer.

| Axiom | Before | Now |
|---|---|---|
| `A rdfs:subClassOf C` over a chain `A ⊑ B ⊑ C`, `A ⊑ A`, `A ⊑ B` for `A ≡ B` | `false` | `true` (reachability over the reduced hierarchy) |
| `p rdfs:subPropertyOf q`, `p owl:equivalentProperty q` | `null` / `false` | decided; a `false` from the classifier is re-checked with a refutation probe for object properties |
| `a owl:sameAs b` | always `null` | symmetric, transitive, reflexive |
| `p rdfs:range D`, `p rdfs:domain C` | `null` | decided by a probe (datatype hierarchy: `p range byte` entails `p range short`) |

A `false` always means *not entailed* under OWL 2 direct semantics (open world), never "refuted". `null` means *not decided* (unsupported shape, an inconsistent ontology, an aborted check).

## Recipes

| Goal | Call |
|---|---|
| Pure OWL reasoning, ignore rules in the data | `materialize(store, { swrl: false })` |
| Everything entailed as triples, for SPARQL/SHACL consumers | `classify(store, { closure: true })`, `materialize(store, { includeClassHierarchy: true, closure: true })` |
| Strict data validation before reasoning | `new RdfReasoner({ illTypedLiterals: "error" })` |
| Show data problems in a UI without blocking | read `reasoner.lastLiteralIssues` after any call |
| Fail loudly on a broken ontology | `{ failOnInconsistent: true }` |
| Keep inferred triples of two runs apart | different `inferredGraph` per run, and list them in `excludeGraphs` |
