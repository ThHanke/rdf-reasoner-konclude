/**
 * Annotation assertions carry no meaning in the OWL 2 direct semantics, so they can be left out of every
 * consistency check (they are long literal strings that Konclude still parses, interns and indexes on each
 * rebuild: ~35% of PMDco's triples). A predicate counts as an annotation property only when the quad set
 * proves it: it is typed `owl:AnnotationProperty` in the same set, or it is one of the built-in annotation
 * properties. Nothing is guessed from a predicate's name. OWL 2 DL keeps annotation properties disjoint from
 * object and data properties, so dropping their assertions cannot change entailments.
 *
 * Kept on purpose: `owl:imports` (semantic), the `owl:Axiom` reification nodes (`owl:annotatedSource` ...),
 * and the declarations `p a owl:AnnotationProperty` themselves. Nothing is removed from the caller's store;
 * the filter only shapes what is sent to the reasoner.
 */
import type { Quad } from "@rdfjs/types";

const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const OWL = "http://www.w3.org/2002/07/owl#";
const RDFS = "http://www.w3.org/2000/01/rdf-schema#";

const BUILTIN_ANNOTATION_PROPERTIES: ReadonlySet<string> = new Set([
  `${RDFS}label`,
  `${RDFS}comment`,
  `${RDFS}seeAlso`,
  `${RDFS}isDefinedBy`,
  `${OWL}versionInfo`,
  `${OWL}priorVersion`,
  `${OWL}backwardCompatibleWith`,
  `${OWL}incompatibleWith`,
  `${OWL}deprecated`,
]);

/** IRIs of the annotation properties the quad set can prove (declared in the set, plus the built-ins). */
export function annotationProperties(quads: readonly Quad[]): Set<string> {
  const out = new Set(BUILTIN_ANNOTATION_PROPERTIES);
  for (const q of quads) {
    if (q.predicate.value === RDF_TYPE && q.object.value === `${OWL}AnnotationProperty` && q.subject.termType === "NamedNode") {
      out.add(q.subject.value);
    }
  }
  return out;
}

/** The quads without annotation assertions (see module comment). Returns a new array. */
export function dropAnnotationTriples(quads: readonly Quad[]): Quad[] {
  const annotation = annotationProperties(quads);
  return quads.filter(q => !annotation.has(q.predicate.value));
}
