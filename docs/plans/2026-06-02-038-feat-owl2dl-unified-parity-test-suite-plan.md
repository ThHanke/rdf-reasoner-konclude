---
title: "feat: OWL 2 DL unified parity test suite"
type: feat
status: active
date: 2026-06-02
origin: docs/brainstorms/2026-06-02-011-owl2dl-unified-parity-test-suite-requirements.md
---

# feat: OWL 2 DL unified parity test suite

## Overview

Creates `tests/integration/owl2dl-parity.test.ts` — a single integration test file
exercising every OWL 2 DL construct (R6–R13) across all three operation stages
(`checkConsistency`, `classify`/`classifyProperties`, `materialize`). Turtle fixtures
live in `tests/fixtures/owl2dl/`, one file per construct group. Known UPSTREAM_LIMITATION
hangs are included as `it.skip` with explicit markers.

## Problem Frame

Current coverage is fragmented: `issue13` covers only `checkConsistency`, `property-characteristics`
covers only `materialize`, `owl-dl-capabilities` covers select `classify` constructs. No single
test exercises the same OWL 2 DL construct across all three operations. Data property
`classifyProperties()` is untested entirely. (See origin document §Problem Frame.)

## Requirements Trace

- R1. Single file `tests/integration/owl2dl-parity.test.ts`; three `describe` blocks per
  construct group (checkConsistency / classify / materialize).
- R2. `checkConsistency` stage: asserts consistent or inconsistent.
- R3. `classify` stage: asserts expected `rdfs:subClassOf` / `owl:equivalentClass` edges.
- R4. `materialize` stage: asserts expected ABox entailments (rdf:type, role assertions,
  owl:sameAs).
- R5. UPSTREAM_LIMITATION cases included as `it.skip` with markers.
- R6–R8. TBox, restrictions, and cardinality constructs covered.
- R9. All eight property characteristics covered (FunctionalProperty stages are all skipped).
- R10–R12. ABox, property disjointness, and class collection constructs covered.
- R13. Data property constructs covered.
- R14. `classifyProperties()` tested for data property `rdfs:subPropertyOf` hierarchy.
- R15. `classifyProperties()` excludes object properties on data-property-only fixture and
  vice versa.

## Scope Boundaries

- README coverage table update: sibling plan 010.
- UPSTREAM_LIMITATION hangs: `it.skip` only — not fixed here.
- Browser integration tests: out of scope.
- Performance benchmarks: out of scope.
- Axiom API (`isEntailed`, `whatIf`, `explain`): sibling plan 010.

### Deferred to Separate Tasks

- README OWL 2 DL coverage table update: plan 010 PR.

## Context & Research

### Relevant Code and Patterns

- `tests/integration/issue13-owl-violations.test.ts` — three-line WASM guard, local
  `parseTurtle()`, inline Turtle string objects, `it.skip` UPSTREAM_LIMITATION pattern.
- `tests/integration/property-characteristics.test.ts` — inline N-Triples fixtures, single
  `describe.skipIf`, shared `reasoner` lifecycle, `it.skip` with 30 000 ms timeout.
- `tests/integration/classify-properties.test.ts` — `classifyProperties()` lifecycle,
  filter-based assertions (no `rdf:type` triples, no `rdfs:subClassOf` triples in result).
- `tests/integration/owl-dl-capabilities.test.ts` — multiple independent
  `describe.skipIf(!wasmExists)` blocks per construct family, each with its own reasoner.
- `vitest.config.ts`: `fileParallelism: false` — test files run sequentially; WASM guard
  `existsSync(wasmPath)` skips entire suite when binary absent.
- WASM import path: `import { RdfReasoner } from "../../ts/index.js"` (`.js` extension
  required; NodeNext module resolution).
- `tests/helpers/fixture.ts` (`loadFixture`): N-Triples only — cannot load Turtle. New
  test must declare a local `parseTurtle()` and load fixtures via `readFileSync`.

### materialize() output model

`materialize()` returns **all ABox entailments**: `rdf:type`, role assertions (e.g.
`Bob directSiblingOf Alice` via SymmetricProperty), and `owl:sameAs` assertions.  This
is broader than "rdf:type only". See `property-characteristics.test.ts` lines 225–314
for confirmed examples.

### Institutional Learnings

- Every class needs explicit `rdf:type owl:Class`; every property needs
  `rdf:type owl:ObjectProperty` or `owl:DatatypeProperty`; every ABox individual needs
  `rdf:type owl:NamedIndividual`. (See `project_konclude_mapper_class_detection.md`.)
- `classify()` returns Hasse diagram only — no transitive `rdfs:subClassOf` edges.
  Assert `A rdfs:subClassOf C` as **false** when the path is `A ⊑ B ⊑ C`.
- UPSTREAM_LIMITATION `it.skip` pattern: name must start with
  `"UPSTREAM_LIMITATION — "`, include a multi-line block comment explaining the root
  cause, and pass `30_000` as the third argument.
- Turtle format avoids the NTriples blank-node representation that triggers the
  `materialize()` hang for AllDisjointClasses, disjointUnionOf, and
  NegativePropertyAssertion. `checkConsistency()` works correctly in Turtle for all three.
  However, `materialize()` for these constructs is still `it.skip` (conservative — the
  hang root is internal serialization to NTriples at the WASM boundary).
- FunctionalProperty + ABox: **all stages** skipped (ALIF+ hang). Any `it.skip` body for
  FunctionalProperty must use a fresh `RdfReasoner` instance (BackendAssCache n=3
  isolation bug).
- `docs/solutions/` contains solved bug records that explain why specific patches (025–029)
  affect NPA, AsymmetricProperty, IrreflexiveProperty, AllDisjointProperties,
  EquivalentObjectProperties.

### External References

No external research needed — codebase patterns are sufficient.

## Key Technical Decisions

- **External Turtle fixtures in `tests/fixtures/owl2dl/`** (not inline strings): The number
  of constructs (8+ groups × 3 stages) makes inline strings unmanageable in a single
  file. External `.ttl` files one per construct group follow the requirements doc's key
  decision (see origin §Key Decisions). Load via `readFileSync` + local `parseTurtle()`.

- **Multiple `describe.skipIf(!wasmExists)` blocks** — one per construct group — each with
  its own `let reasoner: RdfReasoner` + `beforeAll`/`afterAll`. Allows independent
  `it.skip` per operation stage without fixture duplication. Mirrors
  `owl-dl-capabilities.test.ts`.

- **Local `parseTurtle()` and `hasTriple()` helpers** declared once at file top. Not
  imported from `tests/helpers/` (that module is N-Triples only; extending it is out of
  scope).

- **Stage selection per construct**: Not all constructs produce meaningful assertions for
  all three stages. See stage matrix below.

- **Data property assertions deferred**: `classifyProperties()` behavior for data
  properties must be verified against native Konclude output during implementation before
  writing golden-reference assertions.

## Open Questions

### Resolved During Planning

- **Which constructs need all 3 stages vs. fewer?** Resolved via stage matrix (see
  High-Level Technical Design). Constructs that don't affect the class hierarchy (e.g.
  AsymmetricProperty, IrreflexiveProperty, disjointWith) have no meaningful `classify`
  stage. ABox-only constructs (differentFrom, AllDifferent) have no meaningful
  `materialize` assertion beyond "no spurious types".
- **Inline strings or external `.ttl` files?** External files, per origin doc §Key
  Decisions and scale of constructs.
- **Does parseTurtle belong in helpers/?** No — local declaration, consistent with existing
  integration tests.
- **Turtle format avoids materialize hang?** Partially. `checkConsistency` is confirmed
  safe. `materialize` for blank-node constructs is still `it.skip` conservatively.

### Deferred to Implementation

- **Data property `classifyProperties()` native behavior**: Must run native Konclude on a
  data property `rdfs:subPropertyOf` fixture before writing assertions for R14. Use the
  same approach as `tests/helpers/compare-native.ts` (run native binary, capture output,
  compare).
- **Does `classifyProperties()` filter object properties from data-property-only input
  (R15)?** Needs verification against actual WASM output — write a provisional assertion
  then confirm it passes.
- **Does `disjointUnionOf` → `classify()` emit `A rdfs:subClassOf C` edges?** Verify
  against actual WASM output; if not emitted, document as a non-entailment in the test
  comment rather than failing.

## Output Structure

```
tests/
  integration/
    owl2dl-parity.test.ts         ← new
  fixtures/
    owl2dl/                       ← new directory
      tbox.ttl                    ← subClassOf, equivalentClass, disjointWith, complementOf
      restrictions.ttl            ← someValuesFrom, allValuesFrom, hasValue, hasSelf
      cardinality.ttl             ← min/max/exact/qualified cardinality
      property-characteristics.ttl  ← all 8 property characteristics + inverseOf
      abox.ttl                    ← sameAs, differentFrom, AllDifferent, NPA
      property-disjointness.ttl   ← AllDisjointProperties, EquivalentObjectProperties
      class-collections.ttl       ← AllDisjointClasses, disjointUnionOf
      data-properties.ttl         ← DatatypeProperty, subPropertyOf, FuncProp on data,
                                    rdfs:range with datatype
      data-only.ttl               ← R15: data properties only, no object properties
      object-only.ttl             ← R15: object properties only, no data properties
```

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not
> implementation specification. The implementing agent should treat it as context, not code
> to reproduce.*

### Stage matrix

`✓` = active test · `S` = `it.skip` (UPSTREAM_LIMITATION) · `—` = not applicable

| Construct group | checkConsistency | classify / classifyProps | materialize |
|---|---|---|---|
| TBox: `subClassOf`, `equivalentClass` | ✓ | ✓ (Hasse edges) | ✓ (type propagation) |
| TBox: `disjointWith`, `complementOf` | ✓ | — | — |
| Restrictions: `someValuesFrom`, `allValuesFrom` | ✓ | ✓ | ✓ |
| Restrictions: `hasValue`, `hasSelf` | ✓ | ✓ | ✓ |
| Cardinality | ✓ | ✓ | ✓ |
| `SymmetricProperty` | — | — | ✓ (p(a,b) → p(b,a)) |
| `AsymmetricProperty` | ✓ (both directions → inconsistent) | — | — |
| `IrreflexiveProperty` | ✓ (self-loop → inconsistent) | — | — |
| `ReflexiveProperty` | — | — | ✓ (self-loop asserted) |
| `TransitiveProperty` | — | — | ✓ (chain closed) |
| `FunctionalProperty` (obj) | S | S | S |
| `InverseFunctionalProperty` | — | — | ✓ (`owl:sameAs` inferred) |
| `owl:inverseOf` | — | ✓ | ✓ (inverse role asserted) |
| `owl:sameAs` | — | — | ✓ (type propagation across sameAs) |
| `differentFrom`, `owl:AllDifferent` | ✓ | — | — |
| `NegativePropertyAssertion` | ✓ | — | S |
| `AllDisjointProperties` + `EquivalentObjectProperties` | ✓ | `classifyProps` ✓ | — |
| `AllDisjointClasses` | ✓ | — | S |
| `disjointUnionOf` | ✓ | ✓ (document result) | S |
| `DatatypeProperty`, data `subPropertyOf` | ✓ | `classifyProps` ✓ | — |
| `FunctionalProperty` (data) | ✓ | — | — |
| `rdfs:range` with datatype | ✓ | — | — |
| `classifyProps`: data-only / object-only | — | `classifyProps` ✓ | — |

### Test file structure sketch

One `describe.skipIf(!wasmExists)` block per construct group. Each block owns its reasoner
lifecycle. Within each block, individual `it` calls correspond to one cell in the stage
matrix. UPSTREAM_LIMITATION cells → `it.skip`.

```
describe.skipIf(!wasmExists)("TBox constructs", () => {
  beforeAll(async () => { reasoner = new RdfReasoner(); await reasoner.ready; quads = loadTtl("tbox.ttl"); });
  afterAll(() => { reasoner?.terminate(); });
  it("checkConsistency: …", async () => { … });
  it("classify: …", async () => { … });
  it("materialize: …", async () => { … });
});
// … one describe per construct group …
```

## Implementation Units

---

- [ ] **Unit 1: Scaffold test file and fixture directory**

**Goal:** Create the test file with all shared boilerplate and the `tests/fixtures/owl2dl/`
directory.

**Requirements:** R1 (file structure), prerequisite for all other units.

**Dependencies:** None.

**Files:**
- Create: `tests/integration/owl2dl-parity.test.ts`
- Create: `tests/fixtures/owl2dl/` (directory, add first fixture file in unit 2)

**Approach:**
- File top: WASM guard (`wasmPath` / `wasmExists` pattern identical to existing files).
- Imports: `vitest`, `node:fs` (`existsSync`, `readFileSync`), `n3` (`Parser`), `@rdfjs/types`,
  `RdfReasoner` from `../../ts/index.js`.
- Local helpers: `parseTurtle(content: string): Quad[]`, `hasTriple(quads, s, p, o): boolean`,
  `EX(local: string)` IRI shorthand, `loadTtl(name: string): Quad[]` — reads from
  `tests/fixtures/owl2dl/<name>` via `new URL(...)` + `readFileSync`.
- Common IRI constants: `RDF_TYPE`, `RDFS_SUB_CLASS_OF`, `RDFS_SUB_PROPERTY_OF`, `OWL_SAME_AS`.
- No describe blocks yet — file compiles but contains no tests.

**Patterns to follow:**
- `tests/integration/issue13-owl-violations.test.ts` (WASM guard, helpers)
- `tests/integration/classify-properties.test.ts` (`new URL(...)` path pattern)

**Test scenarios:**
- Test expectation: none — scaffold only; compilation and import resolution verified by
  running `npm test` (suite is skipped when WASM absent, passes when present).

**Verification:**
- `npm run build` passes (TypeScript compiles without errors).
- `npm test` reports the file with zero failures (WASM-absent skip or empty describe).

---

- [ ] **Unit 2: TBox construct tests (R6)**

**Goal:** Test `subClassOf`, `equivalentClass`, `disjointWith`, `complementOf` across the
applicable stages.

**Requirements:** R1, R2, R3, R4, R6.

**Dependencies:** Unit 1.

**Files:**
- Create: `tests/fixtures/owl2dl/tbox.ttl`
- Modify: `tests/integration/owl2dl-parity.test.ts`

**Approach:**
- Fixture: two subClassOf chains (A⊑B⊑C), one equivalentClass pair (D≡E),
  `owl:disjointWith` between two classes, `owl:complementOf` pair. Include ABox individuals
  typed into relevant classes.
- describe block "TBox constructs" — three `it` calls per the stage matrix.
- `checkConsistency`: individual simultaneously typed into two disjoint classes → `false`.
  Separate consistent ontology → `true`.
- `classify`: assert `A rdfs:subClassOf B` (direct edge), `B rdfs:subClassOf C` (direct
  edge). Assert `A rdfs:subClassOf C` is **not** in output (Hasse diagram only). Assert
  `D owl:equivalentClass E`.
- `materialize`: individual typed A → also typed B and C (subClassOf propagation).

**Patterns to follow:**
- `tests/integration/owl-dl-capabilities.test.ts` (multi-construct classify assertions)
- Hasse-only invariant from `tests/integration/classify-properties.test.ts` comments

**Test scenarios:**
- Happy path (classify): `A rdfs:subClassOf B` present; `B rdfs:subClassOf C` present.
- Edge case (classify): `A rdfs:subClassOf C` absent (transitive edge not emitted).
- Happy path (classify): `D owl:equivalentClass E` present.
- Happy path (checkConsistency): consistent TBox → `true`.
- Error path (checkConsistency): individual in `A ∩ B` where `A owl:disjointWith B` → `false`.
- Error path (checkConsistency): individual in `X ∩ owl:complementOf(X)` → `false`.
- Happy path (materialize): individual typed A → inferred as type B and C via subClassOf.
- Happy path (materialize): individual typed D → inferred as type E via equivalentClass.

**Verification:**
- All `it` blocks in this describe pass.
- `classify` assertions confirm Hasse-only behavior explicitly.

---

- [ ] **Unit 3: Restriction construct tests (R7)**

**Goal:** Test `someValuesFrom`, `allValuesFrom`, `hasValue`, `hasSelf` across applicable
stages.

**Requirements:** R1–R4, R7.

**Dependencies:** Unit 1.

**Files:**
- Create: `tests/fixtures/owl2dl/restrictions.ttl`
- Modify: `tests/integration/owl2dl-parity.test.ts`

**Approach:**
- Fixture: named restriction classes using each constructor; include ABox individuals with
  property assertions that satisfy the restrictions; all classes and individuals declared
  with `rdf:type owl:Class` / `rdf:type owl:NamedIndividual`.
- `hasValue` pattern mirrors the regression fixture in `property-characteristics.test.ts`
  (C ≡ ∃hasFriend.{Alice}; Bob:C → Bob hasFriend Alice).
- `hasSelf` defines a reflexive restriction class.
- `checkConsistency`: individual that violates `allValuesFrom` (filler outside range class)
  → inconsistent.
- `classify`: named restriction class appears as subclass of another (if TBox defines it).
- `materialize`: Bob:C, C ≡ ∃p.{v} → Bob p v via `hasValue`; range filler typed correctly
  via `someValuesFrom`.

**Patterns to follow:**
- `HAS_VALUE_NTRIPLES` fixture and test in `property-characteristics.test.ts` lines 113–122.

**Test scenarios:**
- Happy path (materialize/hasValue): `Bob rdf:type C`, `C ≡ ∃hasFriend.{Alice}` → `Bob hasFriend Alice`.
- Happy path (materialize/someValuesFrom): individual in `∃p.Dog` restriction → filler typed Dog.
- Error path (checkConsistency): `allValuesFrom` constraint violated by typed filler → `false`.
- Happy path (checkConsistency): consistent `hasSelf` and `hasSelf` filler present → `true`.
- Happy path (materialize/hasSelf): individual in hasSelf-class → self-role asserted.

**Verification:**
- All `it` blocks pass; `hasValue` materialize matches existing `property-characteristics` behavior.

---

- [ ] **Unit 4: Cardinality construct tests (R8)**

**Goal:** Test `minCardinality`, `maxCardinality`, `exactCardinality`,
`minQualifiedCardinality`, `maxQualifiedCardinality` across applicable stages.

**Requirements:** R1–R4, R8.

**Dependencies:** Unit 1.

**Files:**
- Create: `tests/fixtures/owl2dl/cardinality.ttl`
- Modify: `tests/integration/owl2dl-parity.test.ts`

**Approach:**
- Fixture: named cardinality restriction classes for each constructor; ABox individuals
  with appropriate property fillers.
- `checkConsistency`: individual violating `maxCardinality 1` (two distinct fillers, with
  `owl:differentFrom` to prevent sameAs merging) → inconsistent.
- `classify`: named cardinality class appears in class hierarchy.
- `materialize`: individual typed as `minCardinality 1` restriction class → typed as
  superclass via subClassOf propagation.
- Qualified cardinality: use a simple class as filler type; verify consistency and type
  inference.

**Test scenarios:**
- Error path (checkConsistency): `maxCardinality 1` with two `differentFrom` fillers → `false`.
- Happy path (checkConsistency): `minCardinality 1` with one filler present → `true`.
- Happy path (classify): named restriction class appears in classify output.
- Happy path (materialize): type propagation through named restriction class.

**Verification:**
- All `it` blocks pass; violation test reliably returns `false`.

---

- [ ] **Unit 5: Property characteristic tests (R9)**

**Goal:** Test all eight property characteristics and `owl:inverseOf` across applicable
stages. FunctionalProperty stages are all `it.skip`.

**Requirements:** R1–R4, R5, R9.

**Dependencies:** Unit 1.

**Files:**
- Create: `tests/fixtures/owl2dl/property-characteristics.ttl`
- Modify: `tests/integration/owl2dl-parity.test.ts`

**Approach:**
- Fixture: one or two ABox individuals per characteristic with the minimal triple set.
  Must declare `rdf:type owl:NamedIndividual` for each individual.
- **SymmetricProperty** (materialize): `Alice p Bob` → `Bob p Alice`.
- **AsymmetricProperty** (checkConsistency): `Alice p Bob` ∧ `Bob p Alice` → inconsistent.
- **IrreflexiveProperty** (checkConsistency): `Alice p Alice` → inconsistent.
- **ReflexiveProperty** (materialize): `Alice p Alice` automatically asserted for any
  individual in the domain.
- **TransitiveProperty** (materialize): `Alice p Bob`, `Bob p Carol` → `Alice p Carol`.
- **FunctionalProperty** (all stages `it.skip`): comment must explain ALIF+ hang and note
  that a fresh `RdfReasoner` is required inside the skipped body.
- **InverseFunctionalProperty** (materialize): two subjects with same object filler →
  `owl:sameAs` inferred.
- **owl:inverseOf** (classify + materialize): `Alice hasChild Bob` → `Bob hasParent Alice`;
  also any TBox equivalence between inverse-related classes.

**Patterns to follow:**
- `property-characteristics.test.ts` UPSTREAM_LIMITATION comment block (lines 240–280).
- Fresh-reasoner-in-skip-body pattern (lines 257–278).

**Test scenarios:**
- Happy path (materialize/SymmetricProperty): `p(a,b)` → `p(b,a)` present.
- Error path (checkConsistency/AsymmetricProperty): `p(a,b)` ∧ `p(b,a)` → `false`.
- Error path (checkConsistency/IrreflexiveProperty): `p(a,a)` → `false`.
- Happy path (materialize/TransitiveProperty): `p(a,b)` ∧ `p(b,c)` → `p(a,c)` present.
- Happy path (materialize/inverseOf): `hasChild(a,b)` → `hasParent(b,a)` present.
- Happy path (materialize/InverseFunctionalProperty): two subjects with same object → `owl:sameAs` present.
- Skipped: FunctionalProperty (all three stages, UPSTREAM_LIMITATION).

**Verification:**
- All active `it` blocks pass; FunctionalProperty blocks are `it.skip` and do not run.

---

- [ ] **Unit 6: ABox construct tests (R10)**

**Goal:** Test `owl:sameAs`, `owl:differentFrom`, `owl:AllDifferent`, and
`owl:NegativePropertyAssertion` across applicable stages.

**Requirements:** R1–R4, R5, R10.

**Dependencies:** Unit 1.

**Files:**
- Create: `tests/fixtures/owl2dl/abox.ttl`
- Modify: `tests/integration/owl2dl-parity.test.ts`

**Approach:**
- `owl:sameAs` (materialize): two individuals declared `owl:sameAs`; individual A typed
  → individual B inherits the type.
- `owl:differentFrom` (checkConsistency): A `differentFrom` A → inconsistent (reflexive
  contradiction). Separate consistent fixture → `true`.
- `owl:AllDifferent` (checkConsistency): inconsistency when all-different members include
  an individual forced into identity via FunctionalProperty — **skip** this
  (FunctionalProperty hang). Use only a consistent `AllDifferent` → `true` check and a
  class-membership violation instead.
- `NegativePropertyAssertion` (checkConsistency): consistent NPA without positive
  assertion → `true`; NPA with matching positive assertion → `false`. Materialize
  stage → `it.skip`.
- Use Turtle blank-node syntax (`[ rdf:type owl:NegativePropertyAssertion; ... ]`) for NPA
  fixture — avoid manual `_:b0` NTriples syntax.

**Patterns to follow:**
- `NEGATIVE_PROPERTY_ASSERTION_CONSISTENT_NTRIPLES` fixture in
  `property-characteristics.test.ts` (lines 195–203) — adapts its assertion (consistent
  NPA must NOT produce positive triple) to Turtle fixture.
- Issue13 case 12 (consistent NPA → `true`) for checkConsistency happy path.

**Test scenarios:**
- Happy path (materialize/sameAs): typed individual's type propagates to sameAs peer.
- Error path (checkConsistency/differentFrom): `a owl:differentFrom a` → `false`.
- Happy path (checkConsistency/AllDifferent): three distinct individuals AllDifferent → `true`.
- Happy path (checkConsistency/NPA): NPA without positive assertion → `true`.
- Error path (checkConsistency/NPA): NPA + matching positive assertion → `false`.
- Skipped (materialize/NPA): UPSTREAM_LIMITATION blank-node hang.

**Verification:**
- All active `it` blocks pass; NPA materialize is `it.skip`.

---

- [ ] **Unit 7: Class collections and property disjointness (R11, R12)**

**Goal:** Test `AllDisjointClasses`, `disjointUnionOf`, `AllDisjointProperties`, and
`EquivalentObjectProperties` across applicable stages.

**Requirements:** R1–R4, R5, R11, R12.

**Dependencies:** Unit 1.

**Files:**
- Create: `tests/fixtures/owl2dl/class-collections.ttl`
- Create: `tests/fixtures/owl2dl/property-disjointness.ttl`
- Modify: `tests/integration/owl2dl-parity.test.ts`

**Approach:**
- **AllDisjointClasses** (checkConsistency + materialize skip): individual typed into two
  members of the disjoint group → `false`. Consistent individual typed into one member →
  `true`. Materialize: `it.skip`. Use Turtle `[ rdf:type owl:AllDisjointClasses;
  owl:members (A B C) ]` form.
- **disjointUnionOf** (checkConsistency + classify documented + materialize skip):
  consistent ontology with `C owl:disjointUnionOf (A B)` → `true`. Inconsistency: individual
  typed into both A and B → `false`. `classify` stage: test whether A ⊑ C edge is emitted;
  document actual behavior via a comment if not (non-assertion test). Materialize: `it.skip`.
- **AllDisjointProperties** + **EquivalentObjectProperties** (checkConsistency +
  `classifyProperties`): consistent ontology with equivalent properties and a disjoint
  pair → `true`; `classifyProperties()` emits the `rdfs:subPropertyOf` edges for the
  equivalent pair. Inconsistency: two individuals related by two properties declared
  AllDisjoint → `false`.

**Patterns to follow:**
- `ALL_DISJOINT_CLASSES_NEGATIVE_NTRIPLES` and `DISJOINT_UNION_OF_ENTAILMENT_NTRIPLES`
  in `property-characteristics.test.ts` (lines 152–185) — adapt to Turtle.
- `classify-properties.test.ts` for `classifyProperties()` lifecycle and assertion style.

**Test scenarios:**
- Error path (checkConsistency/AllDisjointClasses): individual in two disjoint classes → `false`.
- Happy path (checkConsistency/AllDisjointClasses): individual in one class only → `true`.
- Error path (checkConsistency/disjointUnionOf): individual in two disjoint union members → `false`.
- Happy path (classify/disjointUnionOf): test whether `A rdfs:subClassOf C` is emitted; document result.
- Happy path (classifyProperties/AllDisjointProperties+EquivalentObjectProperties): equivalent
  property pair → `rdfs:subPropertyOf` edges present; AllDisjoint pair → `classifyProperties`
  result doesn't assert the disjoint pair as subproperties.
- Skipped (materialize/AllDisjointClasses): UPSTREAM_LIMITATION.
- Skipped (materialize/disjointUnionOf): UPSTREAM_LIMITATION.

**Verification:**
- All active `it` blocks pass; both materialize stages are `it.skip`.

---

- [ ] **Unit 8: Data property and classifyProperties tests (R13–R15)**

**Goal:** Test `owl:DatatypeProperty`, data property `rdfs:subPropertyOf`, `FunctionalProperty`
on data properties, `rdfs:range` with a datatype, and `classifyProperties()` data property
hierarchy (R14). Test cross-fixture property-type exclusion for `classifyProperties()` (R15).

**Requirements:** R1–R4, R5, R13, R14, R15.

**Dependencies:** Unit 1.

**Files:**
- Create: `tests/fixtures/owl2dl/data-properties.ttl`
- Create: `tests/fixtures/owl2dl/data-only.ttl`
- Create: `tests/fixtures/owl2dl/object-only.ttl`
- Modify: `tests/integration/owl2dl-parity.test.ts`

**Approach:**
- `data-properties.ttl`: declares `hasAge rdfs:subPropertyOf hasNumber` (both
  `owl:DatatypeProperty`), a `owl:FunctionalProperty` data property, and a data property
  with `rdfs:range xsd:integer`. Include an ABox individual with two conflicting
  FunctionalProperty values (using `owl:differentFrom` to force inconsistency).
- **checkConsistency** (FunctionalProperty on data): two distinct literal values for a
  functional data property → `false`.
- **classifyProperties (R14)**: call on `data-properties.ttl` quads; verify
  `hasAge rdfs:subPropertyOf hasNumber` present. Verify no `rdf:type` triples in result
  (mirrors `classify-properties.test.ts`).
- **classifyProperties (R15 — data-only fixture)**: call on `data-only.ttl`; verify no
  object property IRIs appear in result. Call on `object-only.ttl`; verify no data
  property IRIs appear in result.
- **Implementation note**: verify data property `classifyProperties()` output against
  native Konclude before committing golden-reference assertions. Run:
  `docker compose run --rm shell konclude realize -i <data-properties.nt>` (convert ttl
  to nt first via `rapper`). Adjust assertions to match native output.
- `rdfs:range xsd:integer` consistency check: value of wrong type → `false`; correct
  type → `true`. (Concretely: if Konclude enforces datatype range at the ABox level, which
  needs native verification.)

**Execution note:** Verify data property classifyProperties() native behavior before
writing assertion values — use native comparison approach rather than assuming behavior.

**Patterns to follow:**
- `classify-properties.test.ts` — `classifyProperties()` lifecycle and filter assertions.
- `property-characteristics.test.ts` FunctionalProperty fixture (for fresh-reasoner note,
  though the data-property functional case may not trigger ALIF+).

**Test scenarios:**
- Happy path (classifyProperties/R14): `hasAge rdfs:subPropertyOf hasNumber` present in output.
- Happy path (classifyProperties/R14): no `rdf:type` triples in `classifyProperties()` result.
- Happy path (classifyProperties/R15): `data-only.ttl` result contains no object property IRIs.
- Happy path (classifyProperties/R15): `object-only.ttl` result contains no data property IRIs.
- Error path (checkConsistency/FunctionalProperty data): two distinct literal values → `false`.
- Happy path (checkConsistency/FunctionalProperty data): single value only → `true`.
- Happy path / Error path (checkConsistency/rdfs:range): consistent and incorrect-type assertions (subject to native verification).

**Verification:**
- All `it` blocks pass.
- R15 cross-fixture exclusion tests confirm property type filtering.
- Native comparison confirms data property subPropertyOf assertion is correct.

---

## System-Wide Impact

- **Interaction graph:** No production code changes. Test-only. `fileParallelism: false`
  means new file runs sequentially after all existing tests — no concurrency risk.
- **Error propagation:** WASM hang risk managed entirely by `it.skip` with
  UPSTREAM_LIMITATION markers.
- **State lifecycle risks:** Each `describe` block owns its own `RdfReasoner` instance.
  FunctionalProperty skip bodies must allocate a fresh instance to avoid BackendAssCache
  contamination.
- **API surface parity:** No changes to the `RdfReasoner` public API.
- **Integration coverage:** This test file is the integration layer — it exercises the full
  stack (Turtle → Quad[] → Worker → WASM → Quad[]).
- **Unchanged invariants:** Existing 255 tests continue to pass unchanged. No modifications
  to production source, WASM binary, or existing test files.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Data property `classifyProperties()` native behavior unknown | Defer golden-reference assertions to implementation; verify before committing |
| `disjointUnionOf` classify behavior may not emit A⊑C | Document as non-entailment in test comment if not emitted; don't fail |
| New describe blocks add ~30 s to test wall time | Acceptable; `fileParallelism: false` already serializes all files |
| Turtle blank-node serialization by n3 Writer may trigger internal NTriples hang | Conservative `it.skip` on all three blank-node-heavy constructs' materialize stages |
| WASM patches 027–029 required for test correctness | Already applied in current build; documented in MEMORY.md |

## Sources & References

- **Origin document:** [docs/brainstorms/2026-06-02-011-owl2dl-unified-parity-test-suite-requirements.md](docs/brainstorms/2026-06-02-011-owl2dl-unified-parity-test-suite-requirements.md)
- Pattern: [tests/integration/issue13-owl-violations.test.ts](tests/integration/issue13-owl-violations.test.ts)
- Pattern: [tests/integration/property-characteristics.test.ts](tests/integration/property-characteristics.test.ts)
- Pattern: [tests/integration/classify-properties.test.ts](tests/integration/classify-properties.test.ts)
- Pattern: [tests/integration/owl-dl-capabilities.test.ts](tests/integration/owl-dl-capabilities.test.ts)
- MEMORY: `project_konclude_mapper_class_detection.md` (explicit owl:Class required)
- MEMORY: `project_owl2dl_parity_gaps.md` (UPSTREAM_LIMITATION inventory)
- MEMORY: `project_upstream_konclude_bugs.md` (patch 025–029 context)
