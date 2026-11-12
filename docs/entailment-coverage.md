# Entailment Justification Coverage

This table documents which entailment types have justification support in
`explainEntailment()`, what method provides them, and which integration test
validates each row.

Validated by: `tests/integration/entailment-coverage.test.ts`,
`tests/integration/domain-range-justification.test.ts`

## Coverage Matrix

| # | Entailment Type | Method | Track | Test Case |
|---|----------------|--------|-------|-----------|
| 1 | `rdfs:subClassOf` | Native (classification dep chain) | A | `subClassOf: Father ⊑ Parent` |
| 2 | `owl:equivalentClass` | Native (bidirectional subClassOf) | A | `equivalentClass: not entailed for non-equivalent` |
| 3 | `owl:disjointWith` | Native (classification cache) | A | `disjointWith: not entailed for non-disjoint` |
| 4 | `rdf:type` (subClassOf chain) | Native (classification + asserted type) | A | `rdf:type via subClassOf chain` |
| 5 | `rdf:type` (realization) | Native (clash-path hook) | A | via roberts-family materialize |
| 6 | `rdf:type` (someValuesFrom) | Synthesized (restriction + role scan) | B+1 | `alice PetOwner ≡ ∃hasAnimal.Dog`: `rex rdf:type Dog` is NOT entailed (2026-11-09 correction) |
| 7 | `rdf:type` (minCardinality) | Synthesized (restriction + filler count) | B+1 | `dave rdf:type AtLeastOneHobby` |
| 8 | Object property assertions | Asserted lookup (returns triple) | B | `asserted object property returns entailed` |
| 9 | `owl:sameAs` (native) | Native (realization cache) | A | `sameAs: not entailed for distinct individuals` |
| 10 | `owl:sameAs` (FP/IFP) | Synthesized (TS workaround) | B | `alice sameAs bob via FunctionalProperty` |
| 11 | `rdfs:subPropertyOf` | Synthesized (asserted + property subsumption cache) | B | `hasFather subPropertyOf hasParent` |
| 12 | `rdfs:domain`/`rdfs:range` | Synthesized (role assertion + domain/range axiom scan) | B | `alice rdf:type Person via domain` / `fido rdf:type Animal via range` |
| 13 | `owl:equivalentProperty` | Synthesized (assertion scan) | B | `likes equivalentProperty isInterestedIn` |
| 14 | `disjointUnionOf` → `subClassOf` | Synthesized (RDF list walk) | B | `Cat subClassOf Animal via disjointUnionOf` |
| 15 | `owl:oneOf` → `rdf:type` | Synthesized (member scan) | B | `Red rdf:type PrimaryColor via oneOf` |
| 16 | Data property assertions | Asserted lookup (returns triple) | B | `asserted data property (entailed)` |
| 17 | Inconsistency (MIPS) | QuickXplain over axiom units (retained) | -- | via `explainInconsistency` (separate API) |
| 18 | `rdf:type` (hasValue) | Synthesized (restriction + value match) | B | `mario rdf:type Italian via hasValue` |
| 19 | `rdf:type` (allValuesFrom) | Synthesized (type + restriction + role → filler type) | B | `grass rdf:type Plant via allValuesFrom` |
| 20 | `rdf:type` (intersectionOf) | Synthesized (all member types → intersection type) | B | `bob rdf:type Father via Male ∩ Parent` |
| 21 | `rdf:type` (hasSelf) | Synthesized (self-referential role → type) | B | `echo rdf:type Narcissist via hasSelf loves` |
| 22 | `rdf:type` (domain chain) | Synthesized (domain + transitive subClassOf) | B | `dave rdf:type Employee via Manager ⊑ Employee` |
| 23 | `rdf:type` (datatype domain) | Synthesized (datatype property + domain) | B | `alice rdf:type Person via hasAge domain` |

## justificationMode

| Mode | Behavior | Speed |
|------|----------|-------|
| `"fast"` (default; was `"causal"`) | Native dep chain + TS synthesis, every candidate verified. When no candidate verifies: a bounded exact search (5 s, one justification) on ontologies up to 2,000 quads, otherwise no justification and `justificationUnavailable: true`. | ~1ms |
| `"exact"` (was `"minimal"`) | QuickXplain over axiom units plus hitting-set tree. Guaranteed minimal axiom sets, all of them up to `maxJustifications`. | seconds (about 18 s for the 1 MB FeSi case), bounded by `timeout` |

`explainInconsistency` always uses the axiom-unit search (a minimal inconsistent set cannot be read off the native clash; see the README section "From a failed reasoning call to the explanation").
