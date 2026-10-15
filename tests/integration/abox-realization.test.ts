/**
 * Integration test: ABox realization
 *
 * One shared RdfReasoner for the entire file — creating and terminating
 * multiple Workers sequentially exhausts the Emscripten pthread pool.
 *
 * Each describe block materializes its own fixture exactly once in beforeAll
 * (different store instances → different fingerprints → no cache sharing).
 * The `it` cases assert against the already-materialized store.
 *
 * With the Store API, inferred triples are written to INFERRED_GRAPH_IRI only
 * if they do not already exist in the source (DefaultGraph).
 *
 * Requires the built WASM binary (`dist/konclude.wasm`); entire suite skips
 * when binary is absent.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { Parser, Store, DataFactory } from "n3";
import type { Quad } from "@rdfjs/types";

import { RdfReasoner, INFERRED_GRAPH_IRI } from "../../ts/index.js";

// ---------------------------------------------------------------------------
// WASM availability guard
// ---------------------------------------------------------------------------

const wasmPath = new URL("../../dist/konclude.wasm", import.meta.url).pathname;
const wasmExists = existsSync(wasmPath);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseStore(ntriplesStr: string): Store {
  return new Store(new Parser({ format: "N-Triples" }).parse(ntriplesStr) as Quad[]);
}

function getInferred(store: Store): Quad[] {
  return store.getQuads(null, null, null, INFERRED_GRAPH_IRI) as Quad[];
}

function hasTriple(quads: Quad[], s: string, p: string, o: string): boolean {
  return quads.some(
    (q) => q.subject.value === s && q.predicate.value === p && q.object.value === o,
  );
}

// ---------------------------------------------------------------------------
// IRIs
// ---------------------------------------------------------------------------

const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const RDFS_SUB = "http://www.w3.org/2000/01/rdf-schema#subClassOf";
const OWL_SAME_AS = "http://www.w3.org/2002/07/owl#sameAs";
const OWL_THING = "http://www.w3.org/2002/07/owl#Thing";
const EX = (local: string) => `http://example.org/${local}`;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Alice typed ONLY as Employee (not Person) so Alice rdf:type Person is genuine inference.
const ABOX_NT = `
<http://example.org/Alice> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#NamedIndividual> .
<http://example.org/Alice> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://example.org/Employee> .
<http://example.org/Bob> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#NamedIndividual> .
<http://example.org/Bob> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://example.org/Person> .
<http://example.org/Alice> <http://example.org/knows> <http://example.org/Bob> .
<http://example.org/Person> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#Class> .
<http://example.org/Employee> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#Class> .
<http://example.org/Employee> <http://www.w3.org/2000/01/rdf-schema#subClassOf> <http://example.org/Person> .
<http://example.org/knows> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#ObjectProperty> .
`.trim();

// TBox-only; Animal is a root class so Animal subClassOf owl:Thing is a genuine inference.
const TBOX_NT = `
<http://example.org/Animal> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#Class> .
<http://example.org/Mammal> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#Class> .
<http://example.org/Dog> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#Class> .
<http://example.org/Mammal> <http://www.w3.org/2000/01/rdf-schema#subClassOf> <http://example.org/Animal> .
<http://example.org/Dog> <http://www.w3.org/2000/01/rdf-schema#subClassOf> <http://example.org/Mammal> .
`.trim();

const SAME_AS_NT = `
<http://example.org/Person> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#Class> .
<http://example.org/Alice> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#NamedIndividual> .
<http://example.org/Alice> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://example.org/Person> .
<http://example.org/Eve> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#NamedIndividual> .
<http://example.org/Eve> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://example.org/Person> .
<http://example.org/Alice> <http://www.w3.org/2002/07/owl#sameAs> <http://example.org/Eve> .
`.trim();

// Alice typed as Employee (not Person) + data property; genuine inference: Alice rdf:type Person.
const DATA_PROP_NT = `
<http://example.org/Alice> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#NamedIndividual> .
<http://example.org/Alice> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://example.org/Employee> .
<http://example.org/age> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#DatatypeProperty> .
<http://example.org/Alice> <http://example.org/age> "30"^^<http://www.w3.org/2001/XMLSchema#integer> .
<http://example.org/Person> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#Class> .
<http://example.org/Employee> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#Class> .
<http://example.org/Employee> <http://www.w3.org/2000/01/rdf-schema#subClassOf> <http://example.org/Person> .
`.trim();

// ---------------------------------------------------------------------------
// Shared reasoner — one Worker for the entire file avoids pthread pool exhaustion
// ---------------------------------------------------------------------------

let sharedReasoner: RdfReasoner;

beforeAll(async () => {
  sharedReasoner = new RdfReasoner();
  await sharedReasoner.ready;
}, 30_000);

afterAll(() => sharedReasoner?.terminate());

// ---------------------------------------------------------------------------
// ABox materialization
// ---------------------------------------------------------------------------

describe.skipIf(!wasmExists)("ABox realization — Employee/Person", () => {
  let store: Store;

  beforeAll(async () => {
    store = parseStore(ABOX_NT);
    await sharedReasoner.materialize(store);
  });

  it("inferred: Alice rdf:type Person (via Employee ⊑ Person)", () => {
    expect(
      hasTriple(getInferred(store), EX("Alice"), RDF_TYPE, EX("Person")),
      "Alice rdf:type Person must appear in inferred graph",
    ).toBe(true);
  });

  it("asserted rdf:type NOT echoed to inferred graph", () => {
    expect(
      hasTriple(getInferred(store), EX("Alice"), RDF_TYPE, EX("Employee")),
      "Alice rdf:type Employee (asserted) must NOT be in inferred graph",
    ).toBe(false);
  });

  it("source graph intact after materialize", () => {
    expect(
      store.has(DataFactory.quad(
        DataFactory.namedNode(EX("Alice")),
        DataFactory.namedNode(EX("knows")),
        DataFactory.namedNode(EX("Bob")),
        DataFactory.defaultGraph(),
      )),
      "Alice knows Bob must still exist in DefaultGraph",
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TBox-only classification
// ---------------------------------------------------------------------------

describe.skipIf(!wasmExists)("TBox-only classification", () => {
  let store: Store;

  beforeAll(async () => {
    store = parseStore(TBOX_NT);
    await sharedReasoner.classify(store, { includeClassHierarchy: true });
  });

  it("no rdf:type triples in inferred graph", () => {
    const typeTriples = getInferred(store).filter((q) => q.predicate.value === RDF_TYPE);
    expect(typeTriples, "TBox-only must produce zero rdf:type triples").toHaveLength(0);
  });

  it("Animal subClassOf owl:Thing appears (root-class inference)", () => {
    expect(
      hasTriple(getInferred(store), EX("Animal"), RDFS_SUB, OWL_THING),
      "Animal rdfs:subClassOf owl:Thing must be inferred",
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// owl:sameAs realization
// ---------------------------------------------------------------------------

describe.skipIf(!wasmExists)("owl:sameAs realization", () => {
  let store: Store;

  beforeAll(async () => {
    store = parseStore(SAME_AS_NT);
    await sharedReasoner.materialize(store);
  });

  it("at least one owl:sameAs triple in inferred graph", () => {
    const sameAsTriples = getInferred(store).filter((q) => q.predicate.value === OWL_SAME_AS);
    expect(sameAsTriples.length, "at least one owl:sameAs triple").toBeGreaterThan(0);
  });

  it("Alice owl:sameAs Eve (or vice versa)", () => {
    const sameAsTriples = getInferred(store).filter((q) => q.predicate.value === OWL_SAME_AS);
    const found =
      sameAsTriples.some((q) => q.subject.value === EX("Alice") && q.object.value === EX("Eve")) ||
      sameAsTriples.some((q) => q.subject.value === EX("Eve") && q.object.value === EX("Alice"));
    expect(found, "Alice owl:sameAs Eve (or Eve owl:sameAs Alice)").toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Data property realization
// ---------------------------------------------------------------------------

describe.skipIf(!wasmExists)("data property realization", () => {
  let store: Store;

  beforeAll(async () => {
    store = parseStore(DATA_PROP_NT);
    await sharedReasoner.materialize(store);
  });

  it("individual with data property is realized: Alice rdf:type Person inferred", () => {
    expect(
      hasTriple(getInferred(store), EX("Alice"), RDF_TYPE, EX("Person")),
      "Alice rdf:type Person must be inferred even when individual has data property assertions",
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Regression: n=3 ABox calls + classify + sameAs (plan-030 fix)
// ---------------------------------------------------------------------------

describe.skipIf(!wasmExists)("regression — sequential calls with sameAs final", () => {
  let sameAsStore: Store;

  beforeAll(async () => {
    for (let i = 0; i < 3; i++) {
      await sharedReasoner.materialize(parseStore(ABOX_NT));
    }
    await sharedReasoner.classify(parseStore(TBOX_NT), { includeClassHierarchy: true });
    sameAsStore = parseStore(SAME_AS_NT);
    await sharedReasoner.materialize(sameAsStore);
  });

  it("at least one owl:sameAs triple after n=3 ABox calls + classify", () => {
    const sameAsTriples = getInferred(sameAsStore).filter((q) => q.predicate.value === OWL_SAME_AS);
    expect(
      sameAsTriples.length,
      "owl:sameAs triple must appear after n=3 prior ABox calls + classify",
    ).toBeGreaterThan(0);
  });

  it("Alice owl:sameAs Eve (or vice versa) in regression sequence", () => {
    const sameAsTriples = getInferred(sameAsStore).filter((q) => q.predicate.value === OWL_SAME_AS);
    const found =
      sameAsTriples.some((q) => q.subject.value === EX("Alice") && q.object.value === EX("Eve")) ||
      sameAsTriples.some((q) => q.subject.value === EX("Eve") && q.object.value === EX("Alice"));
    expect(found, "Alice owl:sameAs Eve (or vice versa)").toBe(true);
  });
});
