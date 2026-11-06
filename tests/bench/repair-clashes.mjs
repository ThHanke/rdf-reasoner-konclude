// tests/bench/repair-clashes.mjs — the clashes injected into a consistent ontology by the repair() benchmark, each with
// the axioms it adds (in Turtle, for the docs) and the result repair() is expected to return.
import { DataFactory } from "n3";

const { namedNode: n, blankNode: b, literal, quad } = DataFactory;
const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
  OWL = "http://www.w3.org/2002/07/owl#",
  RDFS = "http://www.w3.org/2000/01/rdf-schema#";
const XSD_INT = n("http://www.w3.org/2001/XMLSchema#nonNegativeInteger");
export const BX = "http://bench.example/";
const T = n(`${RDF}type`);

const disjointClash = (i) => [
  quad(n(`${BX}C${i}a`), T, n(`${OWL}Class`)),
  quad(n(`${BX}C${i}b`), T, n(`${OWL}Class`)),
  quad(n(`${BX}C${i}a`), n(`${OWL}disjointWith`), n(`${BX}C${i}b`)),
  quad(n(`${BX}ind${i}`), T, n(`${BX}C${i}a`)),
  quad(n(`${BX}ind${i}`), T, n(`${BX}C${i}b`)),
];
const unsatClash = () => [
  ...["A", "B", "U"].map((c) => quad(n(`${BX}${c}`), T, n(`${OWL}Class`))),
  quad(n(`${BX}A`), n(`${OWL}disjointWith`), n(`${BX}B`)),
  quad(n(`${BX}U`), n(`${RDFS}subClassOf`), n(`${BX}A`)),
  quad(n(`${BX}U`), n(`${RDFS}subClassOf`), n(`${BX}B`)),
  quad(n(`${BX}u1`), T, n(`${BX}U`)),
];
const cardinalityClash = () => {
  const r = b("restr");
  return [
    quad(n(`${BX}p`), T, n(`${OWL}ObjectProperty`)),
    quad(n(`${BX}K`), T, n(`${OWL}Class`)),
    quad(n(`${BX}K`), n(`${RDFS}subClassOf`), r),
    quad(r, T, n(`${OWL}Restriction`)),
    quad(r, n(`${OWL}onProperty`), n(`${BX}p`)),
    quad(r, n(`${OWL}maxCardinality`), literal("1", XSD_INT)),
    quad(n(`${BX}k1`), T, n(`${BX}K`)),
    quad(n(`${BX}k1`), n(`${BX}p`), n(`${BX}y1`)),
    quad(n(`${BX}k1`), n(`${BX}p`), n(`${BX}y2`)),
    quad(n(`${BX}y1`), n(`${OWL}differentFrom`), n(`${BX}y2`)),
  ];
};
const bfoClash = () => [
  quad(n(`${BX}x`), T, n("http://purl.obolibrary.org/obo/BFO_0000004")),
  quad(n(`${BX}x`), T, n("http://purl.obolibrary.org/obo/BFO_0000020")),
];

export const CLASHES = {
  disjoint: {
    build: () => disjointClash(0),
    turtle: `bx:C0a a owl:Class . bx:C0b a owl:Class .
bx:C0a owl:disjointWith bx:C0b .
bx:ind0 a bx:C0a , bx:C0b .`,
    what: "An individual asserted into two classes that are declared disjoint (the classic ABox clash).",
    expected:
      "One justification of 3 axioms (the disjointness axiom and the two type assertions). Three repairs, each removing one of them.",
  },
  unsat: {
    build: unsatClash,
    turtle: `bx:A a owl:Class . bx:B a owl:Class . bx:U a owl:Class .
bx:A owl:disjointWith bx:B .
bx:U rdfs:subClassOf bx:A , bx:B .
bx:u1 a bx:U .`,
    what: "A TBox error (class U is a subclass of two disjoint classes, so unsatisfiable) that only becomes an inconsistency because an individual is an instance of it.",
    expected:
      "One justification of 4 axioms (disjointness, the two subclass axioms, the instance assertion). Four repairs, each removing one of them.",
  },
  cardinality: {
    build: cardinalityClash,
    turtle: `bx:p a owl:ObjectProperty . bx:K a owl:Class .
bx:K rdfs:subClassOf [ a owl:Restriction ; owl:onProperty bx:p ; owl:maxCardinality "1"^^xsd:nonNegativeInteger ] .
bx:k1 a bx:K ; bx:p bx:y1 , bx:y2 .
bx:y1 owl:differentFrom bx:y2 .`,
    what: "A number restriction violated by two provably different fillers. The restriction is an axiom made of four triples (blank-node closure) that must be removed as one unit.",
    expected:
      "One justification of 5 axioms (the restriction as ONE axiom of 4 triples, the instance assertion, the two role assertions, differentFrom). Five repairs, each removing one axiom.",
  },
  three: {
    build: () => [0, 1, 2].flatMap(disjointClash),
    turtle: `# three independent copies of the "disjoint" clash, with C0a/C0b, C1a/C1b, C2a/C2b and ind0, ind1, ind2`,
    what: "Three independent clashes in one ontology: the repair set must fix all of them.",
    expected:
      "Three justifications of 3 axioms. Every complete repair removes one axiom per clash (size 3); there are 27 such minimal sets, so repair() stops at its cap of 10 and reports `incomplete: solution-cap` (by design, not a failure).",
  },
  bfo: {
    build: bfoClash,
    turtle: `bx:x a obo:BFO_0000004 , obo:BFO_0000020 .   # PMDco only: BFO "continuant"-side and "occurrent"-side classes, declared disjoint in the ontology`,
    what: "A real clash against the ontology's own BFO axioms (no synthetic axioms): the individual is typed with two classes that PMDco declares disjoint, both directly and through an owl:AllDisjointClasses axiom.",
    expected:
      "Two justifications of 3 axioms: {direct disjointWith, 2 type assertions} and {AllDisjointClasses axiom (grouped as one unit), the same 2 type assertions}. Repairs: remove either type assertion (size 1, it hits both justifications), or remove both disjointness axioms (size 2).",
  },
};
