/**
 * Axiom units: the grain at which justifications and repairs are computed.
 *
 * An axiom is a connected component of triples, where two triples are connected when they share a blank node (as
 * subject or object): a restriction, an RDF list (intersection, union, property chain, ...), an `AllDisjointClasses`
 * node with its member list, a nested expression. A triple that touches no blank node is its own axiom. Splitting a
 * component is never a weakening: a partial RDF list is a different, usually stronger axiom for the reasoner (a
 * property chain cut to fewer roles is a sub-property axiom), so no check set may contain part of a component.
 *
 * Declarations (`C a owl:Class`, `p a owl:ObjectProperty`, ...) are not axioms; they are background that every check
 * keeps (without them an expression is read differently: an undeclared role in a chain changes the result).
 *
 * `Axiom.quads` holds every graph copy of each triple (the kernel reasons over the union of graphs, so removing one
 * copy of a triple asserted in two graphs would change nothing).
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

/** Identity of a triple (graph-independent). */
export function tripleKey(q: Quad): string {
  return `${termKey(q.subject)} ${termKey(q.predicate)} ${termKey(q.object)}`;
}

/** Identity of a quad including its graph. */
export function quadKey(q: Quad): string {
  return `${tripleKey(q)} ${termKey(q.graph)}`;
}

/** Identity of an axiom: its principal triple (graph-independent). */
export function axiomKey(a: Axiom): string {
  return tripleKey(a.principal);
}

/** `C a owl:Class`, `p a owl:ObjectProperty`, ...: a declaration of a named entity, not an axiom. */
export function isDeclaration(q: Quad): boolean {
  return q.subject.termType === "NamedNode" && q.predicate.value === RDF_TYPE && DECLARATION_TYPES.has(q.object.value);
}

const blanksOf = (q: Quad): string[] => [q.subject, q.object].filter(t => t.termType === "BlankNode").map(t => t.value);

/**
 * Partition quads into axiom units and declaration background (see module comment). Every quad of the input is in
 * exactly one unit or in the background; the graph copies of one triple are in the same unit.
 */
export function partitionIntoUnits(quads: readonly Quad[]): { units: Quad[][]; background: Quad[] } {
  const background: Quad[] = [];
  const copies = new Map<string, Quad[]>();
  for (const q of quads) {
    if (isDeclaration(q)) {
      background.push(q);
      continue;
    }
    const k = tripleKey(q);
    const group = copies.get(k);
    if (group) group.push(q);
    else copies.set(k, [q]);
  }
  const triples = [...copies.values()];
  const parent = triples.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  const firstWithBlank = new Map<string, number>();
  triples.forEach((group, i) => {
    for (const b of blanksOf(group[0])) {
      const j = firstWithBlank.get(b);
      if (j === undefined) firstWithBlank.set(b, i);
      else parent[find(i)] = find(j);
    }
  });
  const byRoot = new Map<number, Quad[]>();
  triples.forEach((group, i) => {
    const r = find(i);
    const unit = byRoot.get(r);
    if (unit) unit.push(...group);
    else byRoot.set(r, [...group]);
  });
  return { units: [...byRoot.values()], background };
}

/**
 * Group the flat triples of a justification into axioms. Each axiom is the connected component (through blank nodes)
 * of a justification triple, read from the store, so removing `Axiom.quads` removes a whole axiom even when the
 * justification kept only part of it. `principal` is a justification triple of the component (preferably one with a
 * named subject). Declarations go to `context`.
 *
 * `graphsToIgnore`: graph IRIs that are not part of the ontology (inferred, hypothetical, explanation).
 */
export function groupJustification(
  justification: Quad[],
  store: Store,
  graphsToIgnore: ReadonlySet<string>,
): AxiomJustification {
  const live = (q: Quad): boolean => !graphsToIgnore.has(q.graph.value);
  const copiesOf = (q: Quad): Quad[] => store.getQuads(q.subject, q.predicate, q.object, null).filter(live);
  const neighbours = (b: Term): Quad[] => [...store.getQuads(b, null, null, null), ...store.getQuads(null, null, b, null)].filter(live);

  const context: Quad[] = [];
  const contextSeen = new Set<string>();
  const candidates: Quad[] = [];
  for (const q of justification) {
    if (isDeclaration(q)) {
      const k = tripleKey(q);
      if (!contextSeen.has(k)) {
        contextSeen.add(k);
        context.push(q);
      }
    } else candidates.push(q);
  }

  const axioms: Axiom[] = [];
  const claimed = new Set<string>();
  const bySubject = (qs: Quad[]) => qs.filter(q => q.subject.termType === "NamedNode");
  for (const seed of candidates) {
    if (claimed.has(tripleKey(seed))) continue;
    const component = new Map<string, Quad[]>();
    const seenBlanks = new Set<string>();
    const stack: Quad[] = [seed];
    while (stack.length > 0) {
      const t = stack.pop()!;
      const k = tripleKey(t);
      if (component.has(k)) continue;
      component.set(k, copiesOf(t));
      for (const b of [t.subject, t.object]) {
        if (b.termType !== "BlankNode" || seenBlanks.has(b.value)) continue;
        seenBlanks.add(b.value);
        stack.push(...neighbours(b));
      }
    }
    const quads = [...component.values()].flat();
    for (const k of component.keys()) claimed.add(k);
    const inComponent = candidates.filter(c => component.has(tripleKey(c)));
    axioms.push({ principal: bySubject(inComponent)[0] ?? inComponent[0], quads });
  }
  return { axioms, context };
}
