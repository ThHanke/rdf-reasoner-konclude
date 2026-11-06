# Release Notes — unreleased (inconsistency repair)

## Summary

This release adds **inconsistency repair** to the reasoner: `explainInconsistencyAxioms`, `repair`, `assessEdit` and `weaken`. A consumer (an ontology editor) can ask what to change, what the change costs, and whether part of an axiom can be kept; the reasoner computes and verifies the answers. It also fixes the cause of a trap on larger inputs and of false justifications on list-heavy ontologies. Method names and result shapes of the four new methods are new and may change between releases; the version number is the maintainer's call.

Measured on a quiet 8-core host (node build): a single clash on PMDco (17k quads) takes 13-17 s for `repair()` and about 1.2 s per `assessEdit`; on a 100k-quad ontology 106-128 s. See [`benchmark-repair.md`](benchmark-repair.md).

---

## What Changed

### New API

- **`explainInconsistencyAxioms(store, opts?)`**: like `explainInconsistency`, but each justification is a list of axioms (`{ principal, quads }`; a restriction or an RDF list is one unit, every graph copy of each triple included) plus the declarations it needs in `context`.
- **`repair(store, opts?)`**: complete sets of axioms whose removal restores consistency. Minimal hitting sets of the justifications are the candidates; each is verified on an edited copy and a failing candidate triggers another explanation round. Options: `maxJustifications`, `maxRepairs`, `maxRounds`, `cost`, `verify`, `timeout`, `inferredGraph`. Result: `repairs[]` with `remove`, `covers`, `verifiedConsistent`, `minimal`, plus `justifications`, `incomplete` and `reason`.
- **`assessEdit(store, { remove, add }, opts?)`**: whether the edited copy is consistent and which asserted class-disjointness pairs (`owl:disjointWith`, `owl:AllDisjointClasses`, `owl:disjointUnionOf`) are no longer entailed. Works on an inconsistent store. `deriveFromHierarchy` also protects the pairs of descendants.
- **`weaken(store, culprit, opts?)`**: replacements for a culprit `X subClassOf Y` or `X subClassOf (B1 and ... and Bn)`: a conjunct generalized to the most specific working named superclass, a dropped conjunct, and the deletion last. Every replacement is verified (consistent and the target class stays satisfiable); candidates already entailed without the culprit are skipped.
- All four never modify the store, never throw for a deadline (`incomplete: true` with a `reason`), and leave the reasoner on the last edited copy, so the next normal call reloads once.

### Changed behaviour of existing methods

- **`explainInconsistency` minimizes over whole axioms with declarations as fixed background.** Previously it removed individual triples, which can leave part of an RDF list or restriction (a different, stronger axiom for the reasoner) or drop a declaration (which changes how expressions are read) and returned false justifications on list-heavy ontologies such as Roberts. Justifications no longer contain declarations as removable members; each carries the declarations of the entities it mentions. A justification whose search is cut short by the `timeout` is dropped instead of being returned non-minimal.
- **`checkConsistency` issues one worker call** (`consistency`) instead of `classification` then `consistency`. For an inconsistent store this avoided a second full rebuild (480 -> 265 ms per check on PMDco); the `consistency` response now carries the WASM heap size, which the Worker recycle uses. `explainInconsistency`, `repair`, `assessEdit` and `weaken` leave annotation assertions (declared `owl:AnnotationProperty` or built-in) out of their consistency checks; they never affect consistency in OWL 2 DL.
- **A trap on larger inputs is fixed.** The explain search degenerated to one check per triple when a clash spanned both halves of the candidate set (17,159 checks on PMDco) and each reload retained about 20 MB of WASM heap until the 4 GiB limit trapped at call 193. The search is QuickXplain over axiom units (23-51 checks regardless of ontology size) and the Worker is recycled between checks when the heap passes the recycle threshold.

### Known limits

- `weaken` supports `rdfs:subClassOf` culprits with named classes only; other shapes return `reason: 'unsupported-axiom'`. No laconic (part-of-axiom) input yet.
- `assessEdit` measures class disjointness only (domain, range, functional and cardinality constraints are not reported) and tests at most 5,000 pairs.
- Per-check cost grows with the ontology (0.11 s at 300 quads, 2.4 s at 100k); three independent clashes on a 100k-quad ontology exceed a 240 s budget and return `incomplete: deadline`.
- Measured in node only; not yet in a browser. The WASM binary used for the benchmark changed between the first and second measurement (see the doc).
