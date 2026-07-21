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
| 6 | `rdf:type` (someValuesFrom) | Synthesized (restriction + role scan) | B+1 | `rex rdf:type Dog via PetOwner ≡ ∃hasAnimal.Dog` |
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
| 17 | Inconsistency (MIPS) | BlackBox (retained) | -- | via `explainInconsistency` (separate API) |
| 18 | `rdf:type` (hasValue) | Synthesized (restriction + value match) | B | `mario rdf:type Italian via hasValue` |
| 19 | `rdf:type` (allValuesFrom) | Synthesized (type + restriction + role → filler type) | B | `grass rdf:type Plant via allValuesFrom` |
| 20 | `rdf:type` (intersectionOf) | Synthesized (all member types → intersection type) | B | `bob rdf:type Father via Male ∩ Parent` |
| 21 | `rdf:type` (hasSelf) | Synthesized (self-referential role → type) | B | `echo rdf:type Narcissist via hasSelf loves` |
| 22 | `rdf:type` (domain chain) | Synthesized (domain + transitive subClassOf) | B | `dave rdf:type Employee via Manager ⊑ Employee` |
| 23 | `rdf:type` (datatype domain) | Synthesized (datatype property + domain) | B | `alice rdf:type Person via hasAge domain` |

## justificationMode

| Mode | Behavior | Speed |
|------|----------|-------|
| `"causal"` (default) | Native dep chain + TS synthesis. No BlackBox fallback. | ~1ms |
| `"minimal"` | BlackBox MIPS. Guaranteed smallest axiom set. | 5-13s |

`explainInconsistency` always uses BlackBox (MIPS genuinely needs axiom-removal).
