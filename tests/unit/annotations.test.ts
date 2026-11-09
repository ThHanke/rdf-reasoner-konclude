import { describe, it, expect } from "vitest";
import { DataFactory } from "n3";
import { annotationProperties, dropAnnotationTriples } from "../../ts/annotations.js";

const { namedNode: n, quad, literal } = DataFactory;
const EX = "http://ex.org/";
const RDF_TYPE = n("http://www.w3.org/1999/02/22-rdf-syntax-ns#type");
const OWL = "http://www.w3.org/2002/07/owl#";
const RDFS = "http://www.w3.org/2000/01/rdf-schema#";
const A = n(`${EX}A`);
const def = n("http://www.w3.org/2004/02/skos/core#definition");

describe("dropAnnotationTriples", () => {
  it("drops built-in annotation properties", () => {
    const label = quad(A, n(`${RDFS}label`), literal("A"));
    const comment = quad(A, n(`${RDFS}comment`), literal("c"));
    const keep = quad(A, n(`${RDFS}subClassOf`), n(`${EX}B`));
    expect(dropAnnotationTriples([label, comment, keep])).toEqual([keep]);
  });

  it("drops predicates declared as owl:AnnotationProperty in the same set, keeps the declaration", () => {
    const decl = quad(def, RDF_TYPE, n(`${OWL}AnnotationProperty`));
    const used = quad(A, def, literal("long definition"));
    expect(dropAnnotationTriples([decl, used])).toEqual([decl]);
  });

  it("never guesses: an undeclared predicate stays, whatever its name", () => {
    const used = quad(A, def, literal("long definition"));
    expect(dropAnnotationTriples([used])).toEqual([used]);
  });

  it("keeps owl:imports, axiom reification nodes and ordinary assertions", () => {
    const imp = quad(n(`${EX}onto`), n(`${OWL}imports`), n(`${EX}other`));
    const src = quad(n(`${EX}ax`), n(`${OWL}annotatedSource`), A);
    const type = quad(n(`${EX}x`), RDF_TYPE, A);
    expect(dropAnnotationTriples([imp, src, type])).toEqual([imp, src, type]);
  });

  it("returns a new array and leaves the input untouched", () => {
    const input = [quad(A, n(`${RDFS}label`), literal("A"))];
    const out = dropAnnotationTriples(input);
    expect(out).not.toBe(input);
    expect(input).toHaveLength(1);
  });

  it("annotationProperties includes the built-ins even for an empty set", () => {
    expect(annotationProperties([]).has(`${RDFS}label`)).toBe(true);
  });
});
