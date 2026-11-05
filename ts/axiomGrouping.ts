/**
 * Groups the flat triples of a justification into OWL axioms (B1 + B2 of the repair plan).
 *
 * An axiom is the blank-node closure rooted at a triple with a named (IRI) subject: follow object blank
 * nodes (restrictions, RDF list cells, nested expressions) until only IRIs and literals remain. The closure
 * is read from the store, not only from the justification, so removing `Axiom.quads` removes a whole axiom
 * even when the minimised justification kept only part of it.
 *
 * `Axiom.quads` holds every graph copy of each triple (the kernel reasons over the union of graphs, so
 * removing one copy of a triple asserted in two graphs would change nothing).
 *
 * Fallback: a blank node reachable from two roots, or a blank-subject triple not reachable from any root,
 * is not grouped; each such triple is its own singleton axiom.
 */
import type { Quad, Term } from "@rdfjs/types";
import type { Store } from "n3";
import type { Axiom, AxiomJustification } from "./types.js";

const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const OWL = "http://www.w3.org/2002/07/owl#";
const DECLARATION_TYPES = new Set([
  `${OWL}Class`,
  `${OWL}ObjectProperty`,
  `${OWL}DatatypeProperty`,
  `${OWL}AnnotationProperty`,
  `${OWL}NamedIndividual`,
  "http://www.w3.org/2000/01/rdf-schema#Datatype",
]);

function termKey(t: Term): string {
  if (t.termType === "Literal") return `L${t.value}^${t.datatype.value}@${t.language}`;
  return `${t.termType[0]}${t.value}`;
}

function tripleKey(q: Quad): string {
  return `${termKey(q.subject)} ${termKey(q.predicate)} ${termKey(q.object)}`;
}

function isDeclaration(q: Quad): boolean {
  return q.subject.termType === "NamedNode" && q.predicate.value === RDF_TYPE && DECLARATION_TYPES.has(q.object.value);
}

/** `graphsToIgnore`: graph IRIs that are not part of the ontology (inferred, hypothetical, explanation). */
export function groupJustification(
  justification: Quad[],
  store: Store,
  graphsToIgnore: ReadonlySet<string>,
): AxiomJustification {
  const copies = (q: Quad): Quad[] =>
    store.getQuads(q.subject, q.predicate, q.object, null).filter(c => !graphsToIgnore.has(c.graph.value));

  const context: Quad[] = [];
  const contextSeen = new Set<string>();
  const roots: Quad[] = [];
  const rootSeen = new Set<string>();
  const blankSubjectQuads: Quad[] = [];
  for (const q of justification) {
    const key = tripleKey(q);
    if (isDeclaration(q)) {
      if (!contextSeen.has(key)) { contextSeen.add(key); context.push(q); }
    } else if (q.subject.termType === "BlankNode") {
      blankSubjectQuads.push(q);
    } else if (!rootSeen.has(key)) {
      rootSeen.add(key);
      roots.push(q);
    }
  }

  // Blank-node closure (as store quads, all graph copies) per root.
  const closureOf = (root: Quad): { quads: Quad[]; blanks: Set<string> } => {
    const quads: Quad[] = [];
    const blanks = new Set<string>();
    const visit = (term: Term): void => {
      if (term.termType !== "BlankNode" || blanks.has(term.value)) return;
      blanks.add(term.value);
      for (const c of store.getQuads(term, null, null, null)) {
        if (graphsToIgnore.has(c.graph.value)) continue;
        quads.push(c);
        visit(c.object);
      }
    };
    visit(root.object);
    return { quads, blanks };
  };

  const closures = roots.map(closureOf);
  const reachedBy = new Map<string, number>();
  for (const c of closures) for (const b of c.blanks) reachedBy.set(b, (reachedBy.get(b) ?? 0) + 1);

  const axioms: Axiom[] = [];
  const groupedBlanks = new Set<string>();
  roots.forEach((root, i) => {
    const { quads, blanks } = closures[i];
    const shared = [...blanks].some(b => (reachedBy.get(b) ?? 0) > 1);
    if (shared) {
      axioms.push({ principal: root, quads: copies(root) });
      return;
    }
    for (const b of blanks) groupedBlanks.add(b);
    axioms.push({ principal: root, quads: [...copies(root), ...quads] });
  });

  for (const q of blankSubjectQuads) {
    if (groupedBlanks.has(q.subject.value)) continue;
    axioms.push({ principal: q, quads: copies(q) });
  }

  return { axioms, context };
}
