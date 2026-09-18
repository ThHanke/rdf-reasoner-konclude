/**
 * Integration test: OWL 2 DL capabilities
 *
 * Verifies that Konclude handles OWL 2 DL constructs that a simple OWL-RL /
 * BGP reasoner cannot:
 *   - owl:equivalentClass with owl:intersectionOf
 *   - owl:equivalentClass with owl:minCardinality restrictions
 *   - owl:someValuesFrom existential restrictions (TBox + ABox)
 *
 * Expected DL inferences (none of these appear in OWL-RL output):
 *   Father rdfs:subClassOf Male     (via equivalentClass: Father ≡ Male ⊓ Parent)
 *   Father rdfs:subClassOf Parent   (via equivalentClass: Father ≡ Male ⊓ Parent)
 *   Father rdfs:subClassOf Person   (transitive: Father ⊑ Male ⊑ Person)
 *   Parent rdfs:subClassOf Person   (via equivalentClass: Parent ≡ Person ⊓ ≥1 hasChild)
 *
 * These tests require the built WASM binary (`dist/konclude.wasm`). When the
 * binary is absent the entire suite is skipped so that `vitest run tests/unit/`
 * continues to pass cleanly.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { Parser, Store } from "n3";
import type { Quad } from "@rdfjs/types";

import { RdfReasoner } from "../../ts/index.js";

const wasmPath = new URL("../../dist/konclude.wasm", import.meta.url).pathname;
const wasmExists = existsSync(wasmPath);

// ---------------------------------------------------------------------------
// Fixture (Turtle) — OWL 2 DL vs OWL-RL comparison
// ---------------------------------------------------------------------------

const DL_TURTLE = `
@prefix ex:   <http://example.org/dl-demo#> .
@prefix owl:  <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix rdf:  <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .

<http://example.org/dl-demo> a owl:Ontology .

ex:Person a owl:Class .
ex:Male   a owl:Class ; rdfs:subClassOf ex:Person .
ex:Female a owl:Class ; rdfs:subClassOf ex:Person .
ex:Male owl:disjointWith ex:Female .

ex:hasChild a owl:ObjectProperty ;
    rdfs:domain ex:Person ;
    rdfs:range  ex:Person .

# Parent ≡ Person ⊓ ≥1 hasChild  [OWL 2 DL only]
ex:Parent a owl:Class ;
    owl:equivalentClass [
        a owl:Class ;
        owl:intersectionOf (
            ex:Person
            [ a owl:Restriction ; owl:onProperty ex:hasChild ; owl:minCardinality 1 ]
        )
    ] .

# Father ≡ Male ⊓ Parent  [OWL 2 DL only]
ex:Father a owl:Class ;
    owl:equivalentClass [
        a owl:Class ;
        owl:intersectionOf ( ex:Male ex:Parent )
    ] .
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EX  = (s: string) => `http://example.org/dl-demo#${s}`;
const SUB = "http://www.w3.org/2000/01/rdf-schema#subClassOf";

function hasSub(quads: Quad[], sub: string, sup: string): boolean {
  return quads.some((q) => q.subject.value === sub && q.predicate.value === SUB && q.object.value === sup);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(!wasmExists)("OWL 2 DL capabilities — classify()", () => {
  let reasoner: RdfReasoner;
  let inferred: Quad[];

  beforeAll(async () => {
    reasoner = new RdfReasoner();
    await reasoner.ready;

    const parser = new Parser({ format: "Turtle" });
    const quads = parser.parse(DL_TURTLE) as Quad[];
    inferred = await reasoner.classify(quads);
  }, 30000);

  afterAll(() => reasoner?.terminate());

  it("Father rdfs:subClassOf Male (via equivalentClass: Father ≡ Male ⊓ Parent)", () => {
    expect(hasSub(inferred, EX("Father"), EX("Male"))).toBe(true);
  });

  it("Father rdfs:subClassOf Parent (via equivalentClass: Father ≡ Male ⊓ Parent)", () => {
    expect(hasSub(inferred, EX("Father"), EX("Parent"))).toBe(true);
  });

  it("Male rdfs:subClassOf Person + Father ⊑ Male form the chain Father → Male → Person (Hasse diagram, no redundant transitive edge)", () => {
    // Konclude emits direct (Hasse) edges only — Father ⊑ Person is NOT emitted
    // because it is subsumed by the direct path Father ⊑ Male ⊑ Person.
    expect(hasSub(inferred, EX("Father"), EX("Male"))).toBe(true);
    expect(hasSub(inferred, EX("Male"),   EX("Person"))).toBe(true);
    expect(hasSub(inferred, EX("Father"), EX("Person"))).toBe(false);
  });

  it("Parent rdfs:subClassOf Person (via equivalentClass: Parent ≡ Person ⊓ ≥1 hasChild)", () => {
    expect(hasSub(inferred, EX("Parent"), EX("Person"))).toBe(true);
  });

  it("Male rdfs:subClassOf Person (direct TBox assertion)", () => {
    expect(hasSub(inferred, EX("Male"), EX("Person"))).toBe(true);
  });

  it("no rdf:type triples in classify() output (TBox only)", () => {
    const typeTriples = inferred.filter(
      (q) => q.predicate.value === "http://www.w3.org/1999/02/22-rdf-syntax-ns#type",
    );
    expect(typeTriples).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// owl:someValuesFrom — existential restriction
// ---------------------------------------------------------------------------

/**
 * Fixture:
 *   Animal, Dog ⊑ Animal
 *   DogOwner ≡ ∃hasAnimal.Dog     (someValuesFrom)
 *   PetOwner ≡ ∃hasAnimal.Animal  (someValuesFrom)
 *   Alice hasAnimal Fido, Fido rdf:type Dog
 *
 * Expected TBox:
 *   DogOwner ⊑ PetOwner   (because Dog ⊑ Animal ⟹ ∃hasAnimal.Dog ⊑ ∃hasAnimal.Animal)
 *
 * Expected ABox (materialize):
 *   Alice rdf:type DogOwner  (she has a hasAnimal value that is a Dog)
 *   Alice rdf:type PetOwner  (via DogOwner ⊑ PetOwner)
 */
const SVF_TURTLE = `
@prefix ex:   <http://example.org/svf#> .
@prefix owl:  <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix rdf:  <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .

<http://example.org/svf> a owl:Ontology .

ex:Animal a owl:Class .
ex:Dog    a owl:Class ; rdfs:subClassOf ex:Animal .

ex:hasAnimal a owl:ObjectProperty .

# DogOwner ≡ ∃hasAnimal.Dog
ex:DogOwner a owl:Class ;
    owl:equivalentClass [ a owl:Restriction ; owl:onProperty ex:hasAnimal ; owl:someValuesFrom ex:Dog ] .

# PetOwner ≡ ∃hasAnimal.Animal
ex:PetOwner a owl:Class ;
    owl:equivalentClass [ a owl:Restriction ; owl:onProperty ex:hasAnimal ; owl:someValuesFrom ex:Animal ] .

# ABox
ex:Fido  a owl:NamedIndividual, ex:Dog .
ex:Alice a owl:NamedIndividual ;
    ex:hasAnimal ex:Fido .
`;

const SVF  = (s: string) => `http://example.org/svf#${s}`;
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

function hasType(quads: Quad[], ind: string, cls: string): boolean {
  return quads.some((q) => q.subject.value === ind && q.predicate.value === RDF_TYPE && q.object.value === cls);
}

describe.skipIf(!wasmExists)("OWL 2 DL — owl:someValuesFrom", () => {
  let reasoner: RdfReasoner;
  let svfQuads: Quad[];

  beforeAll(async () => {
    reasoner = new RdfReasoner();
    await reasoner.ready;
    const parser = new Parser({ format: "Turtle" });
    svfQuads = parser.parse(SVF_TURTLE) as Quad[];
  }, 30000);

  afterAll(() => reasoner?.terminate());

  it("TBox: DogOwner ⊑ PetOwner (∃hasAnimal.Dog ⊑ ∃hasAnimal.Animal because Dog ⊑ Animal)", async () => {
    const inferred = await reasoner.classify(svfQuads);
    expect(
      hasSub(inferred, SVF("DogOwner"), SVF("PetOwner")),
      "DogOwner must be a subclass of PetOwner via someValuesFrom range subsumption",
    ).toBe(true);
  });

  it("ABox: Alice rdf:type DogOwner (hasAnimal Fido, Fido rdf:type Dog → ∃hasAnimal.Dog)", async () => {
    const inferred = await reasoner.materialize(svfQuads);
    expect(
      hasType(inferred, SVF("Alice"), SVF("DogOwner")),
      "Alice must be inferred as DogOwner via someValuesFrom",
    ).toBe(true);
  });

  it("ABox: Alice rdf:type PetOwner (via DogOwner ⊑ PetOwner)", async () => {
    const inferred = await reasoner.materialize(svfQuads);
    expect(
      hasType(inferred, SVF("Alice"), SVF("PetOwner")),
      "Alice must be inferred as PetOwner via DogOwner ⊑ PetOwner",
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isSatisfiable / getUnsatisfiableClasses
// ---------------------------------------------------------------------------

const UNSAT_TURTLE = `
@prefix ex:   <http://example.org/unsat#> .
@prefix owl:  <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix rdf:  <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .

<http://example.org/unsat> a owl:Ontology .
ex:Bird a owl:Class .
ex:EmptyClass a owl:Class ; rdfs:subClassOf owl:Nothing .
`;

const UNSAT = (s: string) => `http://example.org/unsat#${s}`;
const OWL_NOTHING = "http://www.w3.org/2002/07/owl#Nothing";

describe.skipIf(!wasmExists)("isSatisfiable / getUnsatisfiableClasses", () => {
  let reasoner: RdfReasoner;
  let unsatStore: Store;

  beforeAll(async () => {
    reasoner = new RdfReasoner();
    await reasoner.ready;
    const parser = new Parser({ format: "Turtle" });
    unsatStore = new Store(parser.parse(UNSAT_TURTLE) as Quad[]);
  }, 30000);

  afterAll(() => reasoner?.terminate());

  it("isSatisfiable: EmptyClass ⊑ owl:Nothing → false", async () => {
    const result = await reasoner.isSatisfiable(unsatStore, UNSAT("EmptyClass"));
    expect(result).toBe(false);
  }, 360000);

  it("isSatisfiable: Bird (satisfiable class) → true", async () => {
    const result = await reasoner.isSatisfiable(unsatStore, UNSAT("Bird"));
    expect(result).toBe(true);
  }, 360000);

  it("isSatisfiable: unknown IRI not in ontology → true (open-world)", async () => {
    const result = await reasoner.isSatisfiable(unsatStore, "urn:unknown:class");
    expect(result).toBe(true);
  }, 360000);

  it("isSatisfiable: owl:Nothing → false (always unsatisfiable)", async () => {
    const result = await reasoner.isSatisfiable(unsatStore, OWL_NOTHING);
    expect(result).toBe(false);
  }, 360000);

  it("getUnsatisfiableClasses: returns EmptyClass, does NOT include owl:Nothing", async () => {
    const classes = await reasoner.getUnsatisfiableClasses(unsatStore);
    expect(classes).toContain(UNSAT("EmptyClass"));
    expect(classes).not.toContain(OWL_NOTHING);
  }, 360000);

  it("getUnsatisfiableClasses: consistent DL ontology with no unsat classes → []", async () => {
    const parser = new Parser({ format: "Turtle" });
    const consistentStore = new Store(parser.parse(DL_TURTLE) as Quad[]);
    const classes = await reasoner.getUnsatisfiableClasses(consistentStore);
    expect(classes).toEqual([]);
  }, 360000);
});

// ---------------------------------------------------------------------------
// Skolemized blank-node restrictions (urn:vg:bnode: scheme)
//
// Mirrors the ontosphere applyBatch scenario where blank restriction nodes are
// skolemized to urn:vg:bnode: IRIs before being handed to the reasoner.
// Two restrictions share owl:onProperty but have DIFFERENT owl:someValuesFrom
// fillers; Konclude must NOT collapse ClassA ≡ ClassB.
// ---------------------------------------------------------------------------

const SKOLEM_EX = "http://example.org/collapse-test#";
const SKOLEM = (s: string) => `${SKOLEM_EX}${s}`;
const OWL = (s: string) => `http://www.w3.org/2002/07/owl#${s}`;
const RDF = (s: string) => `http://www.w3.org/1999/02/22-rdf-syntax-ns#${s}`;

describe.skipIf(!wasmExists)("Skolemized blank-node restrictions (urn:vg:bnode: IRIs)", () => {
  let reasoner: RdfReasoner;
  let quads: Quad[];

  beforeAll(async () => {
    reasoner = new RdfReasoner();
    await reasoner.ready;

    const nn = (iri: string): any => ({ termType: "NamedNode", value: iri });
    const dg = nn("");
    const q = (s: any, p: any, o: any): Quad => ({ subject: s, predicate: p, object: o, graph: dg } as any);

    const R1 = nn("urn:vg:bnode:restriction-r1");
    const R2 = nn("urn:vg:bnode:restriction-r2");
    const ClassA = nn(SKOLEM("ClassA"));
    const ClassB = nn(SKOLEM("ClassB"));
    const hasPart = nn(SKOLEM("hasPart"));
    const FillerA = nn(SKOLEM("FillerA"));
    const FillerB = nn(SKOLEM("FillerB"));
    const ind1 = nn(SKOLEM("ind1"));
    const p1 = nn(SKOLEM("p1"));
    const ontology = nn("http://example.org/collapse-test");

    quads = [
      q(ontology, nn(RDF("type")), nn(OWL("Ontology"))),
      q(ClassA, nn(RDF("type")), nn(OWL("Class"))),
      q(ClassB, nn(RDF("type")), nn(OWL("Class"))),
      q(FillerA, nn(RDF("type")), nn(OWL("Class"))),
      q(FillerB, nn(RDF("type")), nn(OWL("Class"))),
      q(hasPart, nn(RDF("type")), nn(OWL("ObjectProperty"))),
      q(R1, nn(RDF("type")), nn(OWL("Restriction"))),
      q(R1, nn(OWL("onProperty")), hasPart),
      q(R1, nn(OWL("someValuesFrom")), FillerA),
      q(R2, nn(RDF("type")), nn(OWL("Restriction"))),
      q(R2, nn(OWL("onProperty")), hasPart),
      q(R2, nn(OWL("someValuesFrom")), FillerB),
      q(ClassA, nn(OWL("equivalentClass")), R1),
      q(ClassB, nn(OWL("equivalentClass")), R2),
      q(ind1, nn(RDF("type")), nn(OWL("NamedIndividual"))),
      q(ind1, hasPart, p1),
      q(p1, nn(RDF("type")), nn(OWL("NamedIndividual"))),
      q(p1, nn(RDF("type")), FillerA),
    ];
  }, 30000);

  afterAll(() => reasoner?.terminate());

  it("TBox: no spurious ClassA ≡ ClassB equivalence (different someValuesFrom fillers)", async () => {
    const inferred = await reasoner.classify(quads);
    const OWL_EQUIV = OWL("equivalentClass");
    const spurious =
      inferred.some(
        (q) =>
          q.subject.value === SKOLEM("ClassA") &&
          q.predicate.value === OWL_EQUIV &&
          q.object.value === SKOLEM("ClassB"),
      ) ||
      inferred.some(
        (q) =>
          q.subject.value === SKOLEM("ClassB") &&
          q.predicate.value === OWL_EQUIV &&
          q.object.value === SKOLEM("ClassA"),
      );
    expect(spurious).toBe(false);
  }, 360000);

  it("ABox: ind1 rdf:type ClassA inferred (hasPart p1, p1 rdf:type FillerA → ∃hasPart.FillerA)", async () => {
    const inferred = await reasoner.materialize(quads);
    expect(
      hasType(inferred, SKOLEM("ind1"), SKOLEM("ClassA")),
      "ind1 must be inferred as ClassA",
    ).toBe(true);
  }, 360000);

  it("ABox: ind1 NOT rdf:type ClassB (p1 only satisfies FillerA, not FillerB)", async () => {
    const inferred = await reasoner.materialize(quads);
    expect(
      hasType(inferred, SKOLEM("ind1"), SKOLEM("ClassB")),
      "ind1 must NOT be inferred as ClassB",
    ).toBe(false);
  }, 360000);
});
