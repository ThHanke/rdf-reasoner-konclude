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
