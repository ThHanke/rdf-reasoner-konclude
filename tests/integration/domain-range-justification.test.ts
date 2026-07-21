/**
 * Justification gap coverage tests
 *
 * Verifies that explainEntailment() in causal mode returns non-empty
 * justifications for all synthesis paths: domain/range, hasValue,
 * allValuesFrom, intersectionOf, hasSelf, subPropertyOf, datatype
 * property domain, and object property assertions.
 *
 * Requires WASM binary.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { Store, Parser } from "n3";
import type { Quad } from "@rdfjs/types";

import { RdfReasoner } from "../../ts/index.js";

const wasmExists = existsSync(
  new URL("../../dist/konclude.wasm", import.meta.url).pathname,
);

function parseTurtle(content: string): Quad[] {
  const parser = new Parser({ format: "Turtle" });
  return parser.parse(content) as Quad[];
}

const EX = (local: string) => `http://example.org/${local}`;
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const RDFS_SUB_PROPERTY_OF = "http://www.w3.org/2000/01/rdf-schema#subPropertyOf";

// ── Domain/range ─────────────────────────────────────────────────────────

const DOMAIN_RANGE_FIXTURE = `
  @prefix owl:  <http://www.w3.org/2002/07/owl#> .
  @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
  @prefix rdf:  <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
  @prefix ex:   <http://example.org/> .

  ex:onto a owl:Ontology .
  ex:Person a owl:Class .
  ex:Animal a owl:Class .
  ex:Employee a owl:Class .
  ex:Manager a owl:Class ;
      rdfs:subClassOf ex:Employee .
  ex:Employee rdfs:subClassOf ex:Person .

  ex:manages a owl:ObjectProperty ;
      rdfs:domain ex:Manager .
  ex:owns a owl:ObjectProperty ;
      rdfs:domain ex:Person ;
      rdfs:range ex:Animal .

  ex:alice a owl:NamedIndividual .
  ex:fido  a owl:NamedIndividual .
  ex:dave  a owl:NamedIndividual .
  ex:bob   a owl:NamedIndividual .

  ex:alice ex:owns ex:fido .
  ex:dave ex:manages ex:bob .
`;

describe.skipIf(!wasmExists)(
  "Domain/range rdf:type justifications (causal)",
  () => {
    let reasoner: RdfReasoner;
    let store: Store;

    beforeAll(async () => {
      reasoner = new RdfReasoner();
      await reasoner.ready;
      store = new Store(parseTurtle(DOMAIN_RANGE_FIXTURE));
      await reasoner.materialize(store, { includeClassHierarchy: true });
    }, 360000);

    afterAll(() => {
      reasoner?.terminate();
    });

    it("alice rdf:type Person — domain of ex:owns", async () => {
      const result = await reasoner.explainEntailment(
        store, EX("alice"), RDF_TYPE, EX("Person"),
        { justificationMode: "causal" },
      );
      expect(result.isEntailed).toBe(true);
      expect(result.justifications.length).toBeGreaterThanOrEqual(1);
      expect(result.justifications[0].length).toBeGreaterThan(0);
    }, 60000);

    it("fido rdf:type Animal — range of ex:owns", async () => {
      const result = await reasoner.explainEntailment(
        store, EX("fido"), RDF_TYPE, EX("Animal"),
        { justificationMode: "causal" },
      );
      expect(result.isEntailed).toBe(true);
      expect(result.justifications.length).toBeGreaterThanOrEqual(1);
      expect(result.justifications[0].length).toBeGreaterThan(0);
    }, 60000);

    it("dave rdf:type Manager — domain of ex:manages", async () => {
      const result = await reasoner.explainEntailment(
        store, EX("dave"), RDF_TYPE, EX("Manager"),
        { justificationMode: "causal" },
      );
      expect(result.isEntailed).toBe(true);
      expect(result.justifications.length).toBeGreaterThanOrEqual(1);
      expect(result.justifications[0].length).toBeGreaterThan(0);
    }, 60000);

    it("dave rdf:type Employee — domain chain via Manager ⊑ Employee", async () => {
      const result = await reasoner.explainEntailment(
        store, EX("dave"), RDF_TYPE, EX("Employee"),
        { justificationMode: "causal" },
      );
      expect(result.isEntailed).toBe(true);
      expect(result.justifications.length).toBeGreaterThanOrEqual(1);
      expect(result.justifications[0].length).toBeGreaterThan(0);
    }, 60000);

    it("dave rdf:type Person — domain chain via Manager ⊑ Employee ⊑ Person", async () => {
      const result = await reasoner.explainEntailment(
        store, EX("dave"), RDF_TYPE, EX("Person"),
        { justificationMode: "causal" },
      );
      expect(result.isEntailed).toBe(true);
      expect(result.justifications.length).toBeGreaterThanOrEqual(1);
      expect(result.justifications[0].length).toBeGreaterThan(0);
    }, 60000);
  },
);

// ── Datatype property domain ─────────────────────────────────────────────

const DATATYPE_DOMAIN_FIXTURE = `
  @prefix owl:  <http://www.w3.org/2002/07/owl#> .
  @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
  @prefix rdf:  <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
  @prefix xsd:  <http://www.w3.org/2001/XMLSchema#> .
  @prefix ex:   <http://example.org/> .

  ex:onto a owl:Ontology .
  ex:Person a owl:Class .
  ex:hasAge a owl:DatatypeProperty ;
      rdfs:domain ex:Person .
  ex:alice a owl:NamedIndividual .
  ex:alice ex:hasAge "30"^^xsd:integer .
`;

describe.skipIf(!wasmExists)(
  "Datatype property domain justification (causal)",
  () => {
    let reasoner: RdfReasoner;
    let store: Store;

    beforeAll(async () => {
      reasoner = new RdfReasoner();
      await reasoner.ready;
      store = new Store(parseTurtle(DATATYPE_DOMAIN_FIXTURE));
      await reasoner.materialize(store, { includeClassHierarchy: true });
    }, 360000);

    afterAll(() => {
      reasoner?.terminate();
    });

    it("alice rdf:type Person — domain of datatype property hasAge", async () => {
      const result = await reasoner.explainEntailment(
        store, EX("alice"), RDF_TYPE, EX("Person"),
        { justificationMode: "causal" },
      );
      expect(result.isEntailed).toBe(true);
      expect(result.justifications.length).toBeGreaterThanOrEqual(1);
      expect(result.justifications[0].length).toBeGreaterThan(0);
    }, 60000);
  },
);

// ── hasValue ─────────────────────────────────────────────────────────────

const HAS_VALUE_FIXTURE = `
  @prefix owl:  <http://www.w3.org/2002/07/owl#> .
  @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
  @prefix rdf:  <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
  @prefix ex:   <http://example.org/> .

  ex:onto a owl:Ontology .
  ex:Italian a owl:Class .
  ex:nationality a owl:ObjectProperty .
  ex:Italy a owl:NamedIndividual .
  ex:_r1 a owl:Restriction ;
      owl:onProperty ex:nationality ;
      owl:hasValue ex:Italy .
  ex:Italian owl:equivalentClass ex:_r1 .
  ex:mario a owl:NamedIndividual .
  ex:mario ex:nationality ex:Italy .
`;

describe.skipIf(!wasmExists)(
  "hasValue rdf:type justification (causal)",
  () => {
    let reasoner: RdfReasoner;
    let store: Store;

    beforeAll(async () => {
      reasoner = new RdfReasoner();
      await reasoner.ready;
      store = new Store(parseTurtle(HAS_VALUE_FIXTURE));
      await reasoner.materialize(store, { includeClassHierarchy: true });
    }, 360000);

    afterAll(() => {
      reasoner?.terminate();
    });

    it("mario rdf:type Italian — via hasValue nationality Italy", async () => {
      const result = await reasoner.explainEntailment(
        store, EX("mario"), RDF_TYPE, EX("Italian"),
        { justificationMode: "causal" },
      );
      expect(result.isEntailed).toBe(true);
      expect(result.justifications.length).toBeGreaterThanOrEqual(1);
      expect(result.justifications[0].length).toBeGreaterThan(0);
    }, 60000);
  },
);

// ── allValuesFrom ────────────────────────────────────────────────────────

const ALL_VALUES_FROM_FIXTURE = `
  @prefix owl:  <http://www.w3.org/2002/07/owl#> .
  @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
  @prefix rdf:  <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
  @prefix ex:   <http://example.org/> .

  ex:onto a owl:Ontology .
  ex:Herbivore a owl:Class .
  ex:Plant a owl:Class .
  ex:eats a owl:ObjectProperty .
  ex:_r1 a owl:Restriction ;
      owl:onProperty ex:eats ;
      owl:allValuesFrom ex:Plant .
  ex:Herbivore owl:equivalentClass ex:_r1 .
  ex:grass a owl:NamedIndividual .
  ex:cow a owl:NamedIndividual ;
      a ex:Herbivore .
  ex:cow ex:eats ex:grass .
`;

describe.skipIf(!wasmExists)(
  "allValuesFrom rdf:type justification (causal)",
  () => {
    let reasoner: RdfReasoner;
    let store: Store;

    beforeAll(async () => {
      reasoner = new RdfReasoner();
      await reasoner.ready;
      store = new Store(parseTurtle(ALL_VALUES_FROM_FIXTURE));
      await reasoner.materialize(store, { includeClassHierarchy: true });
    }, 360000);

    afterAll(() => {
      reasoner?.terminate();
    });

    it("grass rdf:type Plant — via allValuesFrom eats Plant", async () => {
      const result = await reasoner.explainEntailment(
        store, EX("grass"), RDF_TYPE, EX("Plant"),
        { justificationMode: "causal" },
      );
      expect(result.isEntailed).toBe(true);
      expect(result.justifications.length).toBeGreaterThanOrEqual(1);
      expect(result.justifications[0].length).toBeGreaterThan(0);
    }, 60000);
  },
);

// ── intersectionOf ───────────────────────────────────────────────────────

const INTERSECTION_OF_FIXTURE = `
  @prefix owl:  <http://www.w3.org/2002/07/owl#> .
  @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
  @prefix rdf:  <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
  @prefix ex:   <http://example.org/> .

  ex:onto a owl:Ontology .
  ex:Male a owl:Class .
  ex:Parent a owl:Class .
  ex:Father a owl:Class ;
      owl:intersectionOf ( ex:Male ex:Parent ) .
  ex:bob a owl:NamedIndividual, ex:Male, ex:Parent .
`;

describe.skipIf(!wasmExists)(
  "intersectionOf rdf:type justification (causal)",
  () => {
    let reasoner: RdfReasoner;
    let store: Store;

    beforeAll(async () => {
      reasoner = new RdfReasoner();
      await reasoner.ready;
      store = new Store(parseTurtle(INTERSECTION_OF_FIXTURE));
      await reasoner.materialize(store, { includeClassHierarchy: true });
    }, 360000);

    afterAll(() => {
      reasoner?.terminate();
    });

    it("bob rdf:type Father — via intersectionOf Male ∩ Parent", async () => {
      const result = await reasoner.explainEntailment(
        store, EX("bob"), RDF_TYPE, EX("Father"),
        { justificationMode: "causal" },
      );
      expect(result.isEntailed).toBe(true);
      expect(result.justifications.length).toBeGreaterThanOrEqual(1);
      expect(result.justifications[0].length).toBeGreaterThan(0);
    }, 60000);
  },
);

// ── hasSelf ──────────────────────────────────────────────────────────────

const HAS_SELF_FIXTURE = `
  @prefix owl:  <http://www.w3.org/2002/07/owl#> .
  @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
  @prefix rdf:  <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
  @prefix ex:   <http://example.org/> .

  ex:onto a owl:Ontology .
  ex:Narcissist a owl:Class .
  ex:loves a owl:ObjectProperty .
  ex:_r1 a owl:Restriction ;
      owl:onProperty ex:loves ;
      owl:hasSelf true .
  ex:Narcissist owl:equivalentClass ex:_r1 .
  ex:echo a owl:NamedIndividual .
  ex:echo ex:loves ex:echo .
`;

describe.skipIf(!wasmExists)(
  "hasSelf rdf:type justification (causal)",
  () => {
    let reasoner: RdfReasoner;
    let store: Store;

    beforeAll(async () => {
      reasoner = new RdfReasoner();
      await reasoner.ready;
      store = new Store(parseTurtle(HAS_SELF_FIXTURE));
      await reasoner.materialize(store, { includeClassHierarchy: true });
    }, 360000);

    afterAll(() => {
      reasoner?.terminate();
    });

    it("echo rdf:type Narcissist — via hasSelf loves", async () => {
      const result = await reasoner.explainEntailment(
        store, EX("echo"), RDF_TYPE, EX("Narcissist"),
        { justificationMode: "causal" },
      );
      expect(result.isEntailed).toBe(true);
      expect(result.justifications.length).toBeGreaterThanOrEqual(1);
      expect(result.justifications[0].length).toBeGreaterThan(0);
    }, 60000);
  },
);

// ── rdfs:subPropertyOf ───────────────────────────────────────────────────

const SUB_PROPERTY_FIXTURE = `
  @prefix owl:  <http://www.w3.org/2002/07/owl#> .
  @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
  @prefix rdf:  <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
  @prefix ex:   <http://example.org/> .

  ex:onto a owl:Ontology .
  ex:hasFather a owl:ObjectProperty ;
      rdfs:subPropertyOf ex:hasParent .
  ex:hasParent a owl:ObjectProperty .
  ex:alice a owl:NamedIndividual .
  ex:bob a owl:NamedIndividual .
  ex:alice ex:hasFather ex:bob .
`;

describe.skipIf(!wasmExists)(
  "rdfs:subPropertyOf justification (causal)",
  () => {
    let reasoner: RdfReasoner;
    let store: Store;

    beforeAll(async () => {
      reasoner = new RdfReasoner();
      await reasoner.ready;
      store = new Store(parseTurtle(SUB_PROPERTY_FIXTURE));
      await reasoner.materialize(store, { includeClassHierarchy: true });
    }, 360000);

    afterAll(() => {
      reasoner?.terminate();
    });

    it("hasFather subPropertyOf hasParent — asserted (entailed with justification)", async () => {
      const result = await reasoner.explainEntailment(
        store, EX("hasFather"), RDFS_SUB_PROPERTY_OF, EX("hasParent"),
        { justificationMode: "causal" },
      );
      expect(result.isEntailed).toBe(true);
      expect(result.justifications.length).toBeGreaterThanOrEqual(1);
      expect(result.justifications[0].length).toBeGreaterThan(0);
    }, 60000);

    it("hasParent subPropertyOf hasFather — not entailed", async () => {
      const result = await reasoner.explainEntailment(
        store, EX("hasParent"), RDFS_SUB_PROPERTY_OF, EX("hasFather"),
        { justificationMode: "causal" },
      );
      expect(result.isEntailed).toBe(false);
    }, 60000);
  },
);

// ── Object property assertion justification ──────────────────────────────

const OBJ_PROP_FIXTURE = `
  @prefix owl:  <http://www.w3.org/2002/07/owl#> .
  @prefix rdf:  <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
  @prefix ex:   <http://example.org/> .

  ex:onto a owl:Ontology .
  ex:knows a owl:ObjectProperty .
  ex:alice a owl:NamedIndividual .
  ex:bob a owl:NamedIndividual .
  ex:alice ex:knows ex:bob .
`;

describe.skipIf(!wasmExists)(
  "Object property assertion justification (causal)",
  () => {
    let reasoner: RdfReasoner;
    let store: Store;

    beforeAll(async () => {
      reasoner = new RdfReasoner();
      await reasoner.ready;
      store = new Store(parseTurtle(OBJ_PROP_FIXTURE));
      await reasoner.materialize(store, { includeClassHierarchy: true });
    }, 360000);

    afterAll(() => {
      reasoner?.terminate();
    });

    it("asserted alice knows bob — returns justification", async () => {
      const result = await reasoner.explainEntailment(
        store, EX("alice"), EX("knows"), EX("bob"),
        { objectIsClassLike: false, justificationMode: "causal" },
      );
      expect(result.isEntailed).toBe(true);
      expect(result.justifications.length).toBeGreaterThanOrEqual(1);
      expect(result.justifications[0].length).toBeGreaterThan(0);
    }, 60000);

    it("non-asserted bob knows alice — not entailed", async () => {
      const result = await reasoner.explainEntailment(
        store, EX("bob"), EX("knows"), EX("alice"),
        { objectIsClassLike: false, justificationMode: "causal" },
      );
      expect(result.isEntailed).toBe(false);
    }, 60000);
  },
);
