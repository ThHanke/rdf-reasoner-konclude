/**
 * Entailment of a small RDF graph (a "conclusion") that may contain blank nodes, the shape of the W3C OWL 2 entailment tests.
 *
 * A conclusion graph is a conjunction. Every part must be entailed by the ontology, so the plan splits it into independent
 * statements and gives up (the caller answers `null`) as soon as a part cannot be handled soundly:
 *   - `annotation`:  `s ap o` with an annotation property. Not DL entailment: a lookup in the store (see RdfReasoner.isEntailedGraph).
 *   - `quad`:        a triple of named terms: decided by the ordinary `isEntailed` axiom machinery.
 *   - `exists`:      `s p _:x` where the blank node starts a TREE (every blank node is the object of exactly one triple, no cycles):
 *                    entailed iff `s : exists p . D(x)` where D(x) is the intersection of the types of x and `exists q . D(y)` for its
 *                    other properties (`hasValue` for a named object). Refutation probe: ontology plus `s : not (exists p . D)`.
 * Anything else (shared blank nodes = joins, cycles, free-standing blank nodes, blank predicates) is `unsupported`.
 * An unsound `true` is worse than `null`, so every unrecognised shape is `unsupported`.
 */
import type { Quad, Term } from "@rdfjs/types";
import { DataFactory } from "n3";

const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const OWL = "http://www.w3.org/2002/07/owl#";
const OWL_THING = OWL + "Thing";
const OWL_CLASS = OWL + "Class";
const OWL_RESTRICTION = OWL + "Restriction";
const OWL_ON_PROPERTY = OWL + "onProperty";
const OWL_SOME = OWL + "someValuesFrom";
const OWL_HAS_VALUE = OWL + "hasValue";
const OWL_COMPLEMENT_OF = OWL + "complementOf";
const OWL_INTERSECTION_OF = OWL + "intersectionOf";
const RDF_FIRST = "http://www.w3.org/1999/02/22-rdf-syntax-ns#first";
const RDF_REST = "http://www.w3.org/1999/02/22-rdf-syntax-ns#rest";
const RDF_NIL = "http://www.w3.org/1999/02/22-rdf-syntax-ns#nil";

/** Class expression of a conclusion subtree. */
export type Expr =
  | { k: "thing" }
  | { k: "named"; iri: string }
  | { k: "and"; parts: Expr[] }
  | { k: "some"; property: string; expr: Expr }
  | { k: "value"; property: string; term: Term };

export type Statement =
  | { kind: "annotation"; quad: Quad }
  | { kind: "quad"; quad: Quad }
  | { kind: "exists"; subject: string; property: string; expr: Expr };

export type Plan = { ok: true; statements: Statement[] } | { ok: false; reason: string };

/** Well-known annotation properties (others are recognised through a declaration `P rdf:type owl:AnnotationProperty`). */
export const BUILTIN_ANNOTATION_PROPERTIES: ReadonlySet<string> = new Set([
  "http://www.w3.org/2000/01/rdf-schema#label", "http://www.w3.org/2000/01/rdf-schema#comment",
  "http://www.w3.org/2000/01/rdf-schema#seeAlso", "http://www.w3.org/2000/01/rdf-schema#isDefinedBy",
  OWL + "versionInfo", OWL + "priorVersion", OWL + "backwardCompatibleWith", OWL + "incompatibleWith", OWL + "deprecated",
]);

const isBlank = (t: Term) => t.termType === "BlankNode";
const isNamed = (t: Term) => t.termType === "NamedNode";
const bkey = (t: Term) => (isBlank(t) ? "_:" + t.value : t.value);

/**
 * Split a conclusion graph into independent statements. `isAnnotationProperty` tells whether an IRI is an annotation property
 * (declared in the premise or the conclusion).
 */
export function planConclusion(conclusion: readonly Quad[], isAnnotationProperty: (iri: string) => boolean): Plan {
  const own = new Set(conclusion.filter((q) => q.predicate.value === RDF_TYPE && q.object.value === OWL + "AnnotationProperty").map((q) => q.subject.value));
  const isAnn = (iri: string) => BUILTIN_ANNOTATION_PROPERTIES.has(iri) || own.has(iri) || isAnnotationProperty(iri);
  const bySubject = new Map<string, Quad[]>();
  const objectCount = new Map<string, number>();
  for (const q of conclusion) {
    if (!isNamed(q.predicate)) return { ok: false, reason: "blank predicate" };
    (bySubject.get(bkey(q.subject)) ?? bySubject.set(bkey(q.subject), []).get(bkey(q.subject))!).push(q);
    if (isBlank(q.object)) objectCount.set(bkey(q.object), (objectCount.get(bkey(q.object)) ?? 0) + 1);
  }
  const used = new Set<string>(); // blank nodes consumed by a tree
  const statements: Statement[] = [];

  const expr = (node: Term, seen: Set<string>): Expr | null => {
    const k = bkey(node);
    if (seen.has(k) || (objectCount.get(k) ?? 0) !== 1) return null; // cycle, or shared blank node (a join)
    seen.add(k);
    used.add(k);
    const parts: Expr[] = [];
    for (const q of bySubject.get(k) ?? []) {
      if (q.predicate.value === RDF_TYPE) {
        if (isBlank(q.object)) return null; // anonymous class expression as a type: not handled
        if (q.object.value !== OWL_THING) parts.push({ k: "named", iri: q.object.value });
        continue;
      }
      if (isAnn(q.predicate.value)) return null;
      if (isBlank(q.object)) {
        const sub = expr(q.object, seen);
        if (!sub) return null;
        parts.push({ k: "some", property: q.predicate.value, expr: sub });
      } else {
        parts.push({ k: "value", property: q.predicate.value, term: q.object });
      }
    }
    seen.delete(k);
    return parts.length === 0 ? { k: "thing" } : parts.length === 1 ? parts[0]! : { k: "and", parts };
  };

  for (const q of conclusion) {
    if (isBlank(q.subject)) continue; // consumed by the tree of its parent (checked below)
    if (isAnn(q.predicate.value)) { statements.push({ kind: "annotation", quad: q }); continue; }
    if (!isBlank(q.object)) { statements.push({ kind: "quad", quad: q }); continue; }
    if (!isNamed(q.subject)) return { ok: false, reason: "subject is not a named individual" };
    if (q.predicate.value === RDF_TYPE) return { ok: false, reason: "anonymous class expression as a type" };
    const e = expr(q.object, new Set());
    if (!e) return { ok: false, reason: "blank node is shared, cyclic or uses an unsupported construct" };
    statements.push({ kind: "exists", subject: q.subject.value, property: q.predicate.value, expr: e });
  }
  for (const k of bySubject.keys()) {
    if (k.startsWith("_:") && !used.has(k)) return { ok: false, reason: "free-standing blank node" };
  }
  if (statements.length === 0) return { ok: false, reason: "empty conclusion" };
  return { ok: true, statements };
}

/**
 * Probe quads for an `exists` statement: ontology plus `s : not (exists p . D)` is inconsistent iff the statement is entailed.
 * Blank-node labels are deterministic (`vg_<probeId>_<n>`) because labels count as content in the sync digest.
 */
export function existsProbeQuads(st: Extract<Statement, { kind: "exists" }>, probeId: string): Quad[] {
  const { namedNode, blankNode, quad, defaultGraph } = DataFactory;
  const g = defaultGraph();
  const out: Quad[] = [];
  let n = 0;
  const fresh = () => blankNode(`vg_${probeId}_${n++}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const add = (s: any, p: string, o: any) => out.push(quad(s, namedNode(p), o, g) as Quad);
  const list = (items: Term[]) => {
    let head: Term = namedNode(RDF_NIL);
    for (let i = items.length - 1; i >= 0; i--) {
      const cell = fresh();
      add(cell, RDF_FIRST, items[i]); add(cell, RDF_REST, head);
      head = cell;
    }
    return head;
  };
  const build = (e: Expr): Term => {
    switch (e.k) {
      case "thing": return namedNode(OWL_THING);
      case "named": return namedNode(e.iri);
      case "and": {
        const c = fresh();
        add(c, RDF_TYPE, namedNode(OWL_CLASS)); add(c, OWL_INTERSECTION_OF, list(e.parts.map(build)));
        return c;
      }
      case "some": {
        const r = fresh();
        add(r, RDF_TYPE, namedNode(OWL_RESTRICTION)); add(r, OWL_ON_PROPERTY, namedNode(e.property)); add(r, OWL_SOME, build(e.expr));
        return r;
      }
      case "value": {
        const r = fresh();
        add(r, RDF_TYPE, namedNode(OWL_RESTRICTION)); add(r, OWL_ON_PROPERTY, namedNode(e.property)); add(r, OWL_HAS_VALUE, e.term);
        return r;
      }
    }
  };
  const some = build({ k: "some", property: st.property, expr: st.expr });
  const neg = fresh();
  add(neg, RDF_TYPE, namedNode(OWL_CLASS)); add(neg, OWL_COMPLEMENT_OF, some);
  add(namedNode(st.subject), RDF_TYPE, neg);
  return out;
}
