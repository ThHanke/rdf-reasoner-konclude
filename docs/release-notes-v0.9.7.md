# Release Notes — v0.9.7

Adopts PR #18 (datatype clashes, memory fixes, input rewrites, DL-safe SWRL, property entailment) and closes most of the remaining W3C OWL 2 DL conformance gaps. Start with [pr18-handover.md](pr18-handover.md); chapters: [api.md](api.md), [options.md](options.md), [swrl.md](swrl.md), [owl2-conformance.md](owl2-conformance.md).

**W3C OWL 2 DL:** consistency 247 → 265 correct of 266 (raw set), 247 → 263 of 264 (normalized); entailment 60 → 68 correct of 84.

## Added

- **DL-safe SWRL rules in `materialize()`.** Rules (`swrl:Imp`) found in the store are applied over the named individuals of the realized ABox until no rule adds a statement; the consequences are written to the inferred graph. Konclude has no SWRL support, so this runs on top of the kernel.
  - **Opt out:** `materialize(store, { swrl: false })`. `reasoner.lastSwrl` reports `{ rules, unsupported, rounds, derived, applied }`; with the option off it still lists the rules found, with `applied: false`.
  - **Cost.** No `swrl:Imp` in the store: no cost. Rules that never match: one matching pass (about 3% on the benchmark). Rules that derive many statements: the kernel realizes a larger ABox; on 300 materials with 4,863 derived triples `materialize` takes 2.5x as long as without rules (1.4 s against 0.56 s). Rule chains are closed in TypeScript, so the kernel runs once per alternation between rule and OWL inference and not once per rule step (7 kernel rounds became 2, 4.8 s became 1.4 s on that benchmark).
  - Supported atoms: named class atoms, individual and data property atoms, same/different individuals. Other rules are skipped and listed in `lastSwrl.unsupported`.
- `isEntailed` decides property assertions, property characteristics and declarations.
- Input rewrites before reasoning: negative property assertions, the bottom data property, OWL 1 boolean constructors, disjoint data properties, `owl:hasKey`.
- `weaken()` gets an `alsoRemove` option.
- **`closure: true`** (opt-in) on `classify`, `classifyProperties` and `materialize` (with `includeClassHierarchy`): writes the transitive closure of the class / property hierarchy into the inferred graph (equivalents subsume each other, `equivalentClass` / `equivalentProperty` between all group members). Default stays the reduced hierarchy. About 6-9x the direct edges (PMDco 1,612 to 10,572 pairs).
- **`isEntailed`** decides `owl:sameAs` (symmetric, transitive, reflexive), `owl:equivalentProperty`, `rdfs:range` and `rdfs:domain` (datatype and class hierarchy conclusions such as `p range byte` entails `p range short`), and answers `subClassOf` / `subPropertyOf` / `equivalentClass` over the transitive-reflexive closure of the hierarchy. Before, `sameAs` and `equivalentProperty` returned `null` and `A ⊑ C` for `A ⊑ B ⊑ C`, `A ⊑ A` and `A ≡ B` as `A ⊑ B` returned `false`. A `false` means not entailed (open world), not refuted.
- **`illTypedLiterals`** option (`"report"` default, `"error"`, `"ignore"`) and `RdfReasoner.lastLiteralIssues`: ill-typed or out-of-range numeric and boolean literals are listed (or rejected with `InvalidLiteralError`) instead of being dropped silently by the kernel.

## Fixed (kernel)

- Datatype clashes between value spaces (a string where `xsd:integer` is required) are detected; datatype concepts get their datatype operator when created (patch 002).
- A negated derived datatype (`not xsd:positiveInteger`) no longer closes the whole value space (patch 002).
- One Redland world for all loads fixes a trap after consecutive loads in one reasoner (patch 004).
- Use-after-free and double free in `buildComplexABoxAxioms` for a blank-node class expression shared by several individuals (patch 004).
- The minimum of `xsd:byte`, `xsd:short` and `xsd:int` was one too high in upstream Konclude (-127, -32767, -2147483647), so valid values `-128`, `-32768` and `-2147483648` made an ontology inconsistent (patch 002).
- Data values follow `rdfs:subPropertyOf` for data properties (`hasAge ⊑ hasNumber`: `Alice hasNumber 30` is materialized).

- OWL 1 constructors on a named class: a class with several `owl:oneOf` lists is the intersection of them (one rewritten class per triple); fixes W3C `description-logic-502`.

- **`isEntailedGraph(store, conclusion)`:** conclusions that are small RDF graphs with blank nodes (existential trees, decided by a refutation probe) and annotation triples (lookup through `sameAs`, equivalent classes and properties); `null` for anything it cannot decide soundly.
- **`rdf:XMLLiteral` values** are compared in canonical form (the kernel could not parse XML and dropped every XML literal).

## Fixed (kernel, patches 002 and 006)

- Data cardinality over enumerated data ranges (`{0.5, 0.25}` with `minCardinality 2` was inconsistent, `{a}` with `minCardinality 2` consistent; W3C `New-Feature-Rational-003`).
- Float and double: -0 orders before +0, subnormals parse, empty facet intervals are inconsistent (`Datatype-Float-Discrete-001`, `Plus_and_Minus_Zero_are_Distinct`).
- A negated literal inside an OR branch was dropped (`excludeValue` compared the maximum in the wrong direction; `Minus_Infinity_is_not_in_owl_real`).
- Consistency for ABox individuals typed with complex classes: nominal cardinality clash (`description-logic-105`) and the separated-node saturation (`-008`, `-012`, `-013`, `-015`, `-017`, `-612` to `-617`). `checkConsistency` itself now answers correctly; the `materialize()` check stays as a stopgap.
- Merging nominals: links of non-child neighbours are moved to the merge target (`one_two`).
- **Realization "stall" on two normalized W3C premises** was a WebAssembly thread stack overflow (64 KiB default, silent heap corruption). Thread stacks are now 2 MiB (`emscripten.cmake`).

## Changed

- Vendor patches 006-009 of the PR are folded into 002 and 004; the vendor tree is byte-identical to the sequential application (`patches/README.md`).
- `materialize()` checks asserted individuals against the unsatisfiable classes after realization, because Konclude's consistency step misses some of them (W3C description-logic-008 and others).

## Performance

No measurable change on the benchmark fixtures: LUBM schema 283 ms and GALEN 1,134 ms (WASM ingest to result, quick run on a loaded host; recorded 261 and 1,126 ms), PMDco `materialize` 3.1 s (`main` 3.0 s), identical inferred counts. SWRL: no cost without rules; 2.5x a rule-free run when rules derive thousands of triples ([swrl.md](swrl.md#cost)).

## Known limits and open work

- Realization of two ROBOT-normalized W3C premises (`SymmetricProperty-002`, `TransitiveProperty-002`) deadlocks the kernel and is not fixed.
- Ten W3C consistency verdicts remain wrong (float/double value spaces, `owl:rational`, two kernel limitations); they are pinned in `tests/integration/w3c-conformance-pr18.test.ts` and listed in `docs/solutions/capability-gaps/pr18-known-conformance-gaps-2026-11-23.md`.
- Ill-typed literals (`"5abc"^^xsd:integer`, `"1.5"^^xsd:integer`, hex floats, `"abc"^^xsd:float`) and integers beyond 64 bits are silently dropped by the kernel's literal parsers instead of making the ontology inconsistent (pinned in `tests/integration/datatype-bounds.test.ts`). The planned fix validates literals in `ts/inputNormalize.ts` before they reach the kernel.
- Float and double value counting, and data cardinality over finite value spaces, are not implemented.
