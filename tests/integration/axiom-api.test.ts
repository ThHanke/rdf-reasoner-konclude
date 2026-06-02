/**
 * Integration test: isEntailed() axiom API
 *
 * Tests `RdfReasoner.isEntailed()` covering:
 *   R1. Returns `true` for entailments derivable from classify/materialize output
 *   R2. Returns `false` for triples not entailed
 *   R3. Works for rdf:type assertions derived from object property chains
 *
 * These tests require the built WASM binary (`dist/konclude.wasm`).  When the
 * binary is absent the entire suite is skipped so that `vitest run tests/unit/`
 * continues to pass cleanly.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { DataFactory, Parser, Store } from "n3";
import type { Quad } from "@rdfjs/types";

import { RdfReasoner, INFERRED_GRAPH_IRI } from "../../ts/index.js";
import { loadFixture } from "../helpers/fixture.js";

// ---------------------------------------------------------------------------
// WASM availability guard
// ---------------------------------------------------------------------------

const wasmPath = new URL("../../dist/konclude.wasm", import.meta.url).pathname;
const wasmExists = existsSync(wasmPath);

// ---------------------------------------------------------------------------
// Prefixes / IRIs
// ---------------------------------------------------------------------------

const ROBERTS = "http://www.co-ode.org/roberts/family-tree.owl#";
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const RDFS_SUBCLASS_OF = "http://www.w3.org/2000/01/rdf-schema#subClassOf";
const OWL_SAME_AS = "http://www.w3.org/2002/07/owl#sameAs";

// Individuals / classes used in R1 / R2 assertions (present in roberts fixtures)
const HUMPHREY = `${ROBERTS}Humphrey_archer_1726`;
const ANCESTOR = `${ROBERTS}Ancestor`;
const BLOOD_RELATION = `${ROBERTS}BloodRelation`;

// ---------------------------------------------------------------------------
// Suite: isEntailed() — R1 and R2 — Roberts Family
// ---------------------------------------------------------------------------

describe.skipIf(!wasmExists)("isEntailed() integration (R1 + R2)", () => {
  let reasoner: RdfReasoner;
  let store: Store;

  beforeAll(async () => {
    reasoner = new RdfReasoner();
    await reasoner.ready;

    // Load Roberts Family as a Store and materialize with class hierarchy.
    // materialize() writes rdf:type AND rdfs:subClassOf to INFERRED_GRAPH_IRI.
    const quads = loadFixture("roberts-family.nt");
    store = new Store(quads);
    await reasoner.materialize(store, { includeClassHierarchy: true });
  }, 360000);

  afterAll(() => {
    reasoner?.terminate();
  });

  // ── R1: entailed rdf:type (ABox) ─────────────────────────────────────────

  it(
    "R1: isEntailed rdf:type — Humphrey_archer_1726 rdf:type Ancestor → true",
    async () => {
      const axiom = DataFactory.quad(
        DataFactory.namedNode(HUMPHREY),
        DataFactory.namedNode(RDF_TYPE),
        DataFactory.namedNode(ANCESTOR),
      );
      const result = await reasoner.isEntailed(store, axiom);
      expect(result).toBe(true);
    },
    360000,
  );

  // ── R2: not-entailed rdf:type ─────────────────────────────────────────────

  it(
    "R2: isEntailed rdf:type — Humphrey rdf:type NonExistentClass → false",
    async () => {
      const axiom = DataFactory.quad(
        DataFactory.namedNode(HUMPHREY),
        DataFactory.namedNode(RDF_TYPE),
        DataFactory.namedNode("http://example.org/NonExistentClass"),
      );
      const result = await reasoner.isEntailed(store, axiom);
      expect(result).toBe(false);
    },
    360000,
  );

  // ── Batch: multiple axioms in one call ────────────────────────────────────

  it(
    "batch isEntailed([true axiom, false axiom]) → [true, false]",
    async () => {
      const trueAxiom = DataFactory.quad(
        DataFactory.namedNode(HUMPHREY),
        DataFactory.namedNode(RDF_TYPE),
        DataFactory.namedNode(ANCESTOR),
      );
      const falseAxiom = DataFactory.quad(
        DataFactory.namedNode(HUMPHREY),
        DataFactory.namedNode(RDF_TYPE),
        DataFactory.namedNode("http://example.org/NonExistentClass"),
      );
      const results = await reasoner.isEntailed(store, [trueAxiom, falseAxiom]);
      expect(results).toHaveLength(2);
      expect(results[0]).toBe(true);
      expect(results[1]).toBe(false);
    },
    360000,
  );

  // ── Unsupported predicate → null ──────────────────────────────────────────

  it(
    "unsupported predicate owl:sameAs → isEntailed returns null",
    async () => {
      const axiom = DataFactory.quad(
        DataFactory.namedNode(HUMPHREY),
        DataFactory.namedNode(OWL_SAME_AS),
        DataFactory.namedNode(HUMPHREY),
      );
      const result = await reasoner.isEntailed(store, axiom);
      expect(result).toBeNull();
    },
    360000,
  );

  it(
    "batch isEntailed with unsupported predicate owl:sameAs returns null entry",
    async () => {
      // Exercises the batch code path (ts/index.ts queue body, not the fast-path).
      // The unsupported owl:sameAs predicate must yield null even inside a batch call.
      const sameAs = DataFactory.namedNode(OWL_SAME_AS);
      const unsupportedAxiom = DataFactory.quad(
        DataFactory.namedNode(HUMPHREY),
        sameAs,
        DataFactory.namedNode("http://example.org/X"),
      );
      const entailedAxiom = DataFactory.quad(
        DataFactory.namedNode(HUMPHREY),
        DataFactory.namedNode(RDF_TYPE),
        DataFactory.namedNode(ANCESTOR),
      );
      const results = await reasoner.isEntailed(store, [unsupportedAxiom, entailedAxiom]);
      expect(results).toHaveLength(2);
      expect(results[0]).toBeNull();
      expect(results[1]).toBe(true);
    },
    360000,
  );

  // ── R1: entailed rdfs:subClassOf (TBox) ──────────────────────────────────
  // Note: isEntailed for rdfs:subClassOf always runs _classifyInline internally
  // (per _opForPredicate). After materialize, _classifyCache is null, so this
  // triggers an additional classify Worker call — expected behavior.
  // This test runs last in the block because _classifyInline cross-invalidates
  // _materializeCache; rdf:type checks after this point would require a fresh
  // realization run (which has known sequencing constraints with classification).

  it(
    "R1: isEntailed rdfs:subClassOf — Ancestor rdfs:subClassOf BloodRelation → true",
    async () => {
      // Ancestor is a DIRECT subclass of BloodRelation in the Roberts Family TBox
      // (tests/fixtures/roberts-native-tbox.nt line 1). The WASM classifier emits
      // only direct (Hasse diagram) edges, so transitive-only pairs would return false.
      const axiom = DataFactory.quad(
        DataFactory.namedNode(ANCESTOR),
        DataFactory.namedNode(RDFS_SUBCLASS_OF),
        DataFactory.namedNode(BLOOD_RELATION),
      );
      const result = await reasoner.isEntailed(store, axiom);
      expect(result).toBe(true);
    },
    360000,
  );
});

// ---------------------------------------------------------------------------
// Suite: isEntailed() — R3 — property chain + domain inference
// ---------------------------------------------------------------------------

describe.skipIf(!wasmExists)(
  "isEntailed() property chain / domain inference (R3)",
  () => {
    let reasoner: RdfReasoner;
    let store: Store;

    beforeAll(async () => {
      reasoner = new RdfReasoner();
      await reasoner.ready;

      // Inline Turtle: TransitiveProperty + rdfs:domain + ABox chain
      // After materialize: alice rdf:type Person is entailed via domain inference
      // (alice hasAncestor bob → alice is in domain of hasAncestor → alice rdf:type Person)
      const turtle = `
@prefix ex: <http://example.org/> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
<http://example.org/> a owl:Ontology .
ex:Person a owl:Class .
ex:hasAncestor a owl:ObjectProperty, owl:TransitiveProperty ;
    rdfs:domain ex:Person .
ex:alice a owl:NamedIndividual ;
    ex:hasAncestor ex:bob .
ex:bob a owl:NamedIndividual ;
    ex:hasAncestor ex:carol .
ex:carol a owl:NamedIndividual .
`.trim();

      const parser = new Parser({ format: "Turtle" });
      store = new Store(parser.parse(turtle) as Quad[]);
      await reasoner.materialize(store, { includeClassHierarchy: true });
    }, 360000);

    afterAll(() => {
      reasoner?.terminate();
    });

    it(
      "R3: alice rdf:type Person entailed via rdfs:domain inference → isEntailed returns true",
      async () => {
        const axiom = DataFactory.quad(
          DataFactory.namedNode("http://example.org/alice"),
          DataFactory.namedNode(RDF_TYPE),
          DataFactory.namedNode("http://example.org/Person"),
        );
        const result = await reasoner.isEntailed(store, axiom);
        expect(result).toBe(true);
      },
      360000,
    );
  },
);

// ---------------------------------------------------------------------------
// Suite: whatIf() — R4, R5, R6
// ---------------------------------------------------------------------------

describe.skipIf(!wasmExists)("whatIf() integration (R4 + R5 + R6)", () => {
  const WIF = "http://example.org/wif#";
  const RDF_TYPE_IRI = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
  const RDFS_SUBCLASS_IRI = "http://www.w3.org/2000/01/rdf-schema#subClassOf";
  const OWL_NS = "http://www.w3.org/2002/07/owl#";

  const wif = (local: string) => `${WIF}${local}`;

  // Inline ontology: Person ⊑ Animal, alice : Person
  // After materialize: INFERRED_GRAPH_IRI should contain alice rdf:type Animal
  const TURTLE = `
@prefix ex: <${WIF}> .
@prefix owl: <${OWL_NS}> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
<http://example.org/wif> a owl:Ontology .
ex:Animal a owl:Class .
ex:Person a owl:Class ; rdfs:subClassOf ex:Animal .
ex:alice a ex:Person .
`.trim();

  let reasoner: RdfReasoner;
  let store: Store;
  let inferredBefore: string[]; // SPO keys of INFERRED_GRAPH_IRI before whatIf

  beforeAll(async () => {
    reasoner = new RdfReasoner();
    await reasoner.ready;

    const parser = new Parser({ format: "Turtle" });
    store = new Store(parser.parse(TURTLE) as Quad[]);

    // Pre-establish non-empty INFERRED_GRAPH_IRI via materialize
    await reasoner.materialize(store, { includeClassHierarchy: true });

    // Snapshot the SPO keys of INFERRED_GRAPH_IRI for R4 comparison
    const ig = DataFactory.namedNode(INFERRED_GRAPH_IRI);
    inferredBefore = store
      .getQuads(null, null, null, ig)
      .map(q => `${q.subject.value}\0${q.predicate.value}\0${q.object.value}`);
  }, 360000);

  afterAll(() => {
    reasoner?.terminate();
  });

  // ── R4: whatIf does not mutate INFERRED_GRAPH_IRI ────────────────────────

  it(
    "R4: whatIf does not mutate INFERRED_GRAPH_IRI, and a subsequent materialize produces the same result",
    async () => {
      // additions: a new individual bob typed as Person (harmless)
      const additions: Quad[] = [
        DataFactory.quad(
          DataFactory.namedNode(wif("bob")),
          DataFactory.namedNode(RDF_TYPE_IRI),
          DataFactory.namedNode(wif("Person")),
        ) as unknown as Quad,
      ];

      const delta = await reasoner.whatIf(store, additions);

      // whatIf returns an object with added and removed arrays
      expect(delta).toHaveProperty("added");
      expect(delta).toHaveProperty("removed");
      expect(Array.isArray(delta.added)).toBe(true);
      expect(Array.isArray(delta.removed)).toBe(true);

      // INFERRED_GRAPH_IRI must be unchanged after whatIf
      const ig = DataFactory.namedNode(INFERRED_GRAPH_IRI);
      const inferredAfterWhatIf = store
        .getQuads(null, null, null, ig)
        .map(q => `${q.subject.value}\0${q.predicate.value}\0${q.object.value}`);

      expect(inferredAfterWhatIf.sort()).toEqual(inferredBefore.sort());

      // A subsequent materialize should produce the same inferred set
      await reasoner.materialize(store, { includeClassHierarchy: true });
      const inferredAfterMaterialize = store
        .getQuads(null, null, null, ig)
        .map(q => `${q.subject.value}\0${q.predicate.value}\0${q.object.value}`);

      expect(inferredAfterMaterialize.sort()).toEqual(inferredBefore.sort());
    },
    360000,
  );

  // ── R5: whatIf with contradicting axiom produces non-zero delta ──────────
  // Spike result: adding alice rdf:type owl:Nothing collapses the ontology —
  // the reasoner removes all previously-inferred triples (removed.length > 0,
  // added.length === 0). Direction observed empirically:
  //   delta.added:   []
  //   delta.removed: [Animal⊑Thing, Person⊑Animal, alice:Animal, alice:Person]

  it(
    "R5: whatIf with contradiction (alice rdf:type owl:Nothing) collapses inferences — removed.length > 0",
    async () => {
      const additions: Quad[] = [
        DataFactory.quad(
          DataFactory.namedNode(wif("alice")),
          DataFactory.namedNode(RDF_TYPE_IRI),
          DataFactory.namedNode(`${OWL_NS}Nothing`),
        ) as unknown as Quad,
      ];

      const delta = await reasoner.whatIf(store, additions);

      // Contradiction collapses the inferred set: removed.length > 0.
      // We do not assert delta.added.length === 0 because Konclude may emit
      // triples during inconsistency collapse (e.g. owl:Thing rdfs:subClassOf
      // owl:Nothing) — that would be correct behaviour, not a test failure.
      expect(delta.removed.length).toBeGreaterThan(0);

      // alice rdf:type Animal is one of the collapsed inferences
      const aliceAnimalRemoved = delta.removed.some(
        q =>
          q.subject.value === wif("alice") &&
          q.predicate.value === RDF_TYPE_IRI &&
          q.object.value === wif("Animal"),
      );
      expect(aliceAnimalRemoved).toBe(true);
    },
    360000,
  );

  // ── R6: two independent whatIf calls produce independent results ──────────
  // additions1 types ClassX under Animal; additions2 types ClassY under Animal.
  // delta1 should include entailments about ClassX but not ClassY, and vice versa.

  it(
    "R6: two independent whatIf calls produce independent results — ClassX vs ClassY",
    async () => {
      const classX = wif("ClassX");
      const classY = wif("ClassY");

      const additions1: Quad[] = [
        DataFactory.quad(
          DataFactory.namedNode(classX),
          DataFactory.namedNode(RDF_TYPE_IRI),
          DataFactory.namedNode(`${OWL_NS}Class`),
        ) as unknown as Quad,
        DataFactory.quad(
          DataFactory.namedNode(classX),
          DataFactory.namedNode(RDFS_SUBCLASS_IRI),
          DataFactory.namedNode(wif("Animal")),
        ) as unknown as Quad,
      ];

      const additions2: Quad[] = [
        DataFactory.quad(
          DataFactory.namedNode(classY),
          DataFactory.namedNode(RDF_TYPE_IRI),
          DataFactory.namedNode(`${OWL_NS}Class`),
        ) as unknown as Quad,
        DataFactory.quad(
          DataFactory.namedNode(classY),
          DataFactory.namedNode(RDFS_SUBCLASS_IRI),
          DataFactory.namedNode(wif("Animal")),
        ) as unknown as Quad,
      ];

      const delta1 = await reasoner.whatIf(store, additions1);
      const delta2 = await reasoner.whatIf(store, additions2);

      // delta1 should reference ClassX but NOT ClassY
      const delta1HasX = delta1.added.some(q =>
        q.subject.value === classX || q.object.value === classX,
      );
      const delta1HasY = delta1.added.some(q =>
        q.subject.value === classY || q.object.value === classY,
      );

      // delta2 should reference ClassY but NOT ClassX
      const delta2HasY = delta2.added.some(q =>
        q.subject.value === classY || q.object.value === classY,
      );
      const delta2HasX = delta2.added.some(q =>
        q.subject.value === classX || q.object.value === classX,
      );

      expect(delta1HasX).toBe(true);
      expect(delta1HasY).toBe(false);
      expect(delta2HasY).toBe(true);
      expect(delta2HasX).toBe(false);

      // Cross-contamination checks on removed arrays: state must not leak
      // between the two independent whatIf calls.
      const delta1RemovedHasY = delta1.removed.some(
        q => q.subject.value === classY || q.object.value === classY,
      );
      const delta2RemovedHasX = delta2.removed.some(
        q => q.subject.value === classX || q.object.value === classX,
      );
      expect(delta1RemovedHasY).toBe(false);
      expect(delta2RemovedHasX).toBe(false);
    },
    360000,
  );
});

// ---------------------------------------------------------------------------
// Suite: explain() and explainInconsistency() — R7, R8, R9
//
// Uses a small inline TBox (ClassA rdfs:subClassOf ClassB) for R7/R9.
// explain() separates candidates from background declarations: rdf:type owl:Class
// triples are passed to Konclude as background so it can recognise classes, but
// they do not appear in the returned justification set.
// ---------------------------------------------------------------------------

describe.skipIf(!wasmExists)(
  "explain() and explainInconsistency() integration (R7 + R8 + R9)",
  () => {
    const EXP_NS = "http://example.org/exp#";
    const classA = `${EXP_NS}ClassA`;
    const classB = `${EXP_NS}ClassB`;

    const TURTLE = `
@prefix ex: <${EXP_NS}> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
<http://example.org/exp> a owl:Ontology .
ex:ClassA a owl:Class .
ex:ClassB a owl:Class .
ex:ClassA rdfs:subClassOf ex:ClassB .
`.trim();

    let reasoner: RdfReasoner;
    let store: Store;

    beforeAll(async () => {
      reasoner = new RdfReasoner();
      await reasoner.ready;

      const parser = new Parser({ format: "Turtle" });
      store = new Store(parser.parse(TURTLE) as Quad[]);
    }, 360000);

    afterAll(() => {
      reasoner?.terminate();
    });

    // ── R7: explain returns non-empty justification for entailed axiom ────────

    it(
      "R7: explain(ClassA rdfs:subClassOf ClassB) returns a non-empty justification containing the source axiom",
      async () => {
        const axiom = DataFactory.quad(
          DataFactory.namedNode(classA),
          DataFactory.namedNode(RDFS_SUBCLASS_OF),
          DataFactory.namedNode(classB),
        ) as unknown as Quad;

        const justs = await reasoner.explain(store, axiom);

        expect(justs.length).toBeGreaterThanOrEqual(1);
        expect(justs[0].length).toBeGreaterThanOrEqual(1);

        // The justification must contain the source axiom itself
        const j0 = justs[0];
        const foundAxiom = j0.some(
          q =>
            q.subject.value === classA &&
            q.predicate.value === RDFS_SUBCLASS_OF &&
            q.object.value === classB,
        );
        expect(foundAxiom).toBe(true);

        // Verify background declarations don't leak into justifications
        const CLASS_IRI = "http://www.w3.org/2002/07/owl#Class";
        const RDF_TYPE_IRI = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
        const hasClassDecl = justs[0].some(
          q => q.predicate.value === RDF_TYPE_IRI && q.object.value === CLASS_IRI
        );
        expect(hasClassDecl).toBe(false);
      },
      360000,
    );

    // ── R9: explain returns [] for non-entailed axiom (reverse direction) ─────

    it(
      "R9: explain(ClassB rdfs:subClassOf ClassA) returns [] — reverse direction not entailed",
      async () => {
        const axiom = DataFactory.quad(
          DataFactory.namedNode(classB),
          DataFactory.namedNode(RDFS_SUBCLASS_OF),
          DataFactory.namedNode(classA),
        ) as unknown as Quad;

        const justs = await reasoner.explain(store, axiom);

        expect(justs).toEqual([]);
      },
      360000,
    );

    // ── R8a: explainInconsistency returns non-empty result for inconsistent onto

    it(
      "R8a: explainInconsistency returns non-empty justification for inconsistent ontology",
      async () => {
        const incStore = new Store(loadFixture("inconsistent.nt"));
        const justifications = await reasoner.explainInconsistency(incStore);

        expect(justifications.length).toBeGreaterThanOrEqual(1);
        expect(justifications[0].length).toBeGreaterThanOrEqual(1);
      },
      360000,
    );

    // ── R8b: explainInconsistency returns [] for consistent ontology ──────────

    it(
      "R8b: explainInconsistency returns [] for consistent ontology (ClassA/ClassB store)",
      async () => {
        const justifications = await reasoner.explainInconsistency(store);

        expect(justifications).toEqual([]);
      },
      360000,
    );
  },
);

// ---------------------------------------------------------------------------
// Suite: validate() — R10, R11a, R11b
//
// R10: validate(store) on Roberts Family → { consistent: true, errors: [], warnings: [] }
// R11a: validate with maxJustificationsPerWarning:1 → justifications populated
// R11b: validate with maxJustificationsPerWarning:0 → justifications: [] (IRI-only mode)
// ---------------------------------------------------------------------------

describe.skipIf(!wasmExists)("validate() integration (R10 + R11)", () => {
  let reasoner: RdfReasoner;

  afterAll(() => {
    reasoner?.terminate();
  });

  // ── R10: Roberts Family → consistent: true, no warnings ──────────────────

  describe("R10: Roberts Family validate()", () => {
    let validateResult: Awaited<ReturnType<RdfReasoner["validate"]>>;

    beforeAll(async () => {
      reasoner = new RdfReasoner();
      await reasoner.ready;

      const quads = loadFixture("roberts-family.nt");
      const store = new Store(quads);
      validateResult = await reasoner.validate(store);
    }, 360000);

    it(
      "R10: validate(Roberts Family) → consistent: true",
      () => {
        expect(validateResult.consistent).toBe(true);
      },
      360000,
    );

    it(
      "R10: validate(Roberts Family) → errors: []",
      () => {
        expect(validateResult.errors).toEqual([]);
      },
      360000,
    );

    it(
      "R10: validate(Roberts Family) → warnings: [] (no unsatisfiable classes)",
      () => {
        // The Roberts Family disjoint axioms (Female/Male, Person/Sex) do not
        // produce unsatisfiable classes — verified empirically here.
        expect(validateResult.warnings).toEqual([]);
      },
      360000,
    );
  });

  // ── R11: EmptyClass ⊑ owl:Nothing → justifications populated / empty ──────

  describe("R11: EmptyClass ⊑ owl:Nothing validate() options", () => {
    const EMPTY_CLASS_IRI = "http://example.org/val#EmptyClass";

    const TURTLE = `
@prefix ex: <http://example.org/val#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
<http://example.org/val> a owl:Ontology .
ex:EmptyClass a owl:Class ; rdfs:subClassOf owl:Nothing .
`.trim();

    let store: Store;

    beforeAll(async () => {
      if (!reasoner) {
        reasoner = new RdfReasoner();
        await reasoner.ready;
      }
      const parser = new Parser({ format: "Turtle" });
      store = new Store(parser.parse(TURTLE) as Quad[]);
    }, 360000);

    it(
      "R11a: validate(EmptyClass, { maxJustificationsPerWarning: 1 }) → warnings[0].justifications is populated",
      async () => {
        const result = await reasoner.validate(store, { maxJustificationsPerWarning: 1 });

        expect(result.consistent).toBe(true);
        expect(result.errors).toEqual([]);

        const emptyClassWarning = result.warnings.find(w => w.classIRI === EMPTY_CLASS_IRI);
        expect(emptyClassWarning).toBeDefined();
        // justifications must be non-empty (not IRI-only mode)
        expect(emptyClassWarning!.justifications.length).toBeGreaterThanOrEqual(1);
        // each justification must contain at least one axiom
        expect(emptyClassWarning!.justifications[0].length).toBeGreaterThanOrEqual(1);
      },
      360000,
    );

    it(
      "R11b: validate(EmptyClass, { maxJustificationsPerWarning: 0 }) → warnings[0].justifications is []",
      async () => {
        const result = await reasoner.validate(store, { maxJustificationsPerWarning: 0 });

        expect(result.consistent).toBe(true);
        expect(result.errors).toEqual([]);

        const emptyClassWarning = result.warnings.find(w => w.classIRI === EMPTY_CLASS_IRI);
        expect(emptyClassWarning).toBeDefined();
        // IRI-only mode: justifications must be empty
        expect(emptyClassWarning!.justifications).toEqual([]);
      },
      360000,
    );
  });
});

// ---------------------------------------------------------------------------
// Suite: Sequential call state isolation — R12, R13, R14
//
// All three tests share a single RdfReasoner instance to exercise cross-call
// state isolation. No owl:sameAs entailments are tested here (BackendAssCache
// n=3 slot-collision bug — see docs/solutions/logic-errors/).
//
// Inline ontology used throughout:
//   ex:Animal a owl:Class .
//   ex:Person a owl:Class ; rdfs:subClassOf ex:Animal .
//   ex:alice a ex:Person .
//
// Expected TBox inference: Person rdfs:subClassOf Animal (in INFERRED_GRAPH_IRI)
// Expected ABox inference: alice rdf:type Animal (in INFERRED_GRAPH_IRI)
// ---------------------------------------------------------------------------

describe.skipIf(!wasmExists)(
  "Sequential call state isolation (R12 + R13 + R14)",
  () => {
    const SEQ = "http://example.org/seq#";
    const seq = (local: string) => `${SEQ}${local}`;

    const TURTLE = `
@prefix ex: <${SEQ}> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
<http://example.org/seq> a owl:Ontology .
ex:Animal a owl:Class .
ex:Person a owl:Class ; rdfs:subClassOf ex:Animal .
ex:alice a ex:Person .
`.trim();

    let reasoner: RdfReasoner;

    beforeAll(async () => {
      reasoner = new RdfReasoner();
      await reasoner.ready;
    }, 360000);

    afterAll(() => {
      reasoner?.terminate();
    });

    // Helper: build a fresh Store from TURTLE for each test
    const freshStore = (): Store => {
      const parser = new Parser({ format: "Turtle" });
      return new Store(parser.parse(TURTLE) as Quad[]);
    };

    // ── R12: classify() then materialize() on same instance ─────────────────
    // Step 1: classify(store) → assert rdfs:subClassOf in INFERRED_GRAPH_IRI
    // Step 2: materialize(store, { includeClassHierarchy: true }) → assert rdf:type in INFERRED_GRAPH_IRI
    // Checking subClassOf BEFORE materialize avoids the _materializeOnStore
    // removeQuads clearing the classify output.

    it(
      "R12: classify() then materialize(includeClassHierarchy:true) on same instance — both produce correct results",
      async () => {
        const store = freshStore();
        const inferredGraph = DataFactory.namedNode(INFERRED_GRAPH_IRI);

        // Step 1: classify
        await reasoner.classify(store);
        const subClassOfQuads = store.getQuads(null, RDFS_SUBCLASS_OF, null, inferredGraph);
        expect(subClassOfQuads.length).toBeGreaterThan(0);
        const personSubAnimal = subClassOfQuads.some(
          q => q.subject.value === seq("Person") && q.object.value === seq("Animal"),
        );
        expect(personSubAnimal).toBe(true);

        // Step 2: materialize with class hierarchy (re-writes INFERRED_GRAPH_IRI)
        await reasoner.materialize(store, { includeClassHierarchy: true });
        const rdfTypeQuads = store.getQuads(null, RDF_TYPE, null, inferredGraph);
        expect(rdfTypeQuads.length).toBeGreaterThan(0);
        const aliceAnimal = rdfTypeQuads.some(
          q => q.subject.value === seq("alice") && q.object.value === seq("Animal"),
        );
        expect(aliceAnimal).toBe(true);
      },
      360000,
    );

    // ── R13: checkConsistency() then classify() on same instance ─────────────

    it(
      "R13: checkConsistency() then classify() on same instance — no hang, correct TBox output",
      async () => {
        const store = freshStore();
        const inferredGraph = DataFactory.namedNode(INFERRED_GRAPH_IRI);

        // Step 1: check consistency
        const consistent = await reasoner.checkConsistency(store);
        expect(consistent).toBe(true);

        // Step 2: classify — must complete without hanging and produce inferred triples
        await reasoner.classify(store);
        const subClassOfQuads = store.getQuads(null, RDFS_SUBCLASS_OF, null, inferredGraph);
        expect(subClassOfQuads.length).toBeGreaterThan(0);
        const personSubAnimal = subClassOfQuads.some(
          q => q.subject.value === seq("Person") && q.object.value === seq("Animal"),
        );
        expect(personSubAnimal).toBe(true);
      },
      360000,
    );

    // ── R14: whatIf() does not affect subsequent classify() ──────────────────
    // Call whatIf with a harmless addition (new class ClassX subClassOf Animal).
    // whatIf invalidates all caches. Subsequent classify(store) must re-load the
    // unmodified base store and produce correct TBox output.
    //
    // Uses a distinct ontology prefix (seq14:) to avoid fingerprint cache
    // collision with the R12/R13 stores that share the same TURTLE content.

    it(
      "R14: whatIf() does not contaminate subsequent classify() — correct TBox output after cache invalidation",
      async () => {
        // Distinct prefix avoids fingerprint collision with R12/R13 stores
        const SEQ14 = "http://example.org/seq14#";
        const seq14 = (local: string) => `${SEQ14}${local}`;
        const TURTLE14 = `
@prefix ex: <${SEQ14}> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
<http://example.org/seq14> a owl:Ontology .
ex:Animal a owl:Class .
ex:Person a owl:Class ; rdfs:subClassOf ex:Animal .
ex:alice a ex:Person .
`.trim();
        const parser = new Parser({ format: "Turtle" });
        const store = new Store(parser.parse(TURTLE14) as Quad[]);
        const inferredGraph = DataFactory.namedNode(INFERRED_GRAPH_IRI);

        // whatIf: add a new class ClassX subClassOf Animal
        const additions: Quad[] = [
          DataFactory.quad(
            DataFactory.namedNode(seq14("ClassX")),
            DataFactory.namedNode(RDF_TYPE),
            DataFactory.namedNode("http://www.w3.org/2002/07/owl#Class"),
          ) as unknown as Quad,
          DataFactory.quad(
            DataFactory.namedNode(seq14("ClassX")),
            DataFactory.namedNode(RDFS_SUBCLASS_OF),
            DataFactory.namedNode(seq14("Animal")),
          ) as unknown as Quad,
        ];
        const delta = await reasoner.whatIf(store, additions);
        expect(delta).toHaveProperty("added");
        expect(delta).toHaveProperty("removed");

        // whatIf must not write to INFERRED_GRAPH_IRI — store inferred graph is still empty
        const afterWhatIfInferred = store.getQuads(null, null, null, inferredGraph);
        expect(afterWhatIfInferred.length).toBe(0);

        // Now classify — whatIf invalidated all caches, so this must re-load
        // the unmodified base store and produce correct TBox output
        await reasoner.classify(store);
        const subClassOfQuads = store.getQuads(null, RDFS_SUBCLASS_OF, null, inferredGraph);
        expect(subClassOfQuads.length).toBeGreaterThan(0);
        const personSubAnimal = subClassOfQuads.some(
          q => q.subject.value === seq14("Person") && q.object.value === seq14("Animal"),
        );
        expect(personSubAnimal).toBe(true);

        // ClassX must NOT appear (it was only in the whatIf additions, not in the base store)
        const classXPresent = subClassOfQuads.some(
          q => q.subject.value === seq14("ClassX") || q.object.value === seq14("ClassX"),
        );
        expect(classXPresent).toBe(false);
      },
      360000,
    );
  },
);
