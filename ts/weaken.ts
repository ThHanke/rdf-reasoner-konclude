/**
 * weaken (C2 of the repair plan): replace a culprit `rdfs:subClassOf` axiom by weaker ones that still repair the ontology.
 *
 * Supported culprits (v1): `X rdfs:subClassOf Y` (Y a named class) and `X rdfs:subClassOf (B1 and ... and Bn)` with named
 * conjuncts. Operators: generalize one conjunct to a named superclass, drop one conjunct (n >= 2), and the deletion of the
 * whole axiom (always offered last).
 *
 * The named superclasses form a DAG, not a chain. The search walks upward from each conjunct and stops at the first
 * working superclass on each path: a weaker axiom only adds models, so every superclass above a working one works too and
 * is pruned. Only the MOST SPECIFIC working generalizations are returned. A candidate is verified by consistency of the
 * edited ontology AND satisfiability of the target class X (for an unsatisfiable class without instances consistency alone
 * passes for any replacement, including the culprit itself). Candidates that are already entailed without the culprit are
 * skipped: they would repair nothing the deletion does not.
 */
import type { Quad } from "@rdfjs/types";
import { DataFactory } from "n3";
import { quadKey, tripleKey } from "./axiomGrouping.js";
import { dropAnnotationTriples } from "./annotations.js";
import type { AssessOracle } from "./assessEdit.js";
import type { Axiom, Weakening, WeakenResult } from "./types.js";

const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const RDFS = "http://www.w3.org/2000/01/rdf-schema#";
const OWL = "http://www.w3.org/2002/07/owl#";
const SUB_CLASS_OF = `${RDFS}subClassOf`;
const TOP_BOTTOM = new Set([`${OWL}Thing`, `${OWL}Nothing`]);

export interface CulpritShape {
  subject: string;
  conjuncts: string[];
  graph: Quad["graph"];
}

/** The shape of a supported culprit axiom, or null (see module comment). */
export function parseCulprit(culprit: Axiom): CulpritShape | null {
  const p = culprit.principal;
  if (p.predicate.value !== SUB_CLASS_OF || p.subject.termType !== "NamedNode") return null;
  if (p.object.termType === "NamedNode") return { subject: p.subject.value, conjuncts: [p.object.value], graph: p.graph };
  if (p.object.termType !== "BlankNode") return null;
  const triples = new Map<string, Quad>();
  for (const q of culprit.quads) triples.set(tripleKey(q), q);
  const bySubject = new Map<string, Quad[]>();
  for (const q of triples.values()) bySubject.set(q.subject.value, [...(bySubject.get(q.subject.value) ?? []), q]);
  const node = bySubject.get(p.object.value) ?? [];
  const head = node.find(q => q.predicate.value === `${OWL}intersectionOf`);
  if (!head) return null;
  const conjuncts: string[] = [];
  const seen = new Set<string>();
  let cell: string | undefined = head.object.value;
  let consumed = 1; // the principal
  consumed += node.length;
  while (cell && cell !== `${RDF}nil` && !seen.has(cell)) {
    seen.add(cell);
    const cellQuads: Quad[] = bySubject.get(cell) ?? [];
    const first = cellQuads.find(q => q.predicate.value === `${RDF}first`);
    if (!first || first.object.termType !== "NamedNode") return null;
    conjuncts.push(first.object.value);
    consumed += cellQuads.length;
    cell = cellQuads.find(q => q.predicate.value === `${RDF}rest`)?.object.value;
  }
  if (conjuncts.length < 2 || consumed !== triples.size) return null; // some other structure is part of the axiom
  return { subject: p.subject.value, conjuncts, graph: p.graph };
}

/** The quads of `subject rdfs:subClassOf (c1 and ... and cn)` (a plain subclass axiom when n = 1). */
export function subClassAxiomQuads(shape: Pick<CulpritShape, "subject" | "graph">, conjuncts: readonly string[]): Quad[] {
  const { namedNode: n, blankNode: b, quad } = DataFactory;
  const g = shape.graph;
  if (conjuncts.length === 1) return [quad(n(shape.subject), n(SUB_CLASS_OF), n(conjuncts[0]), g)];
  const expr = b();
  const cells = conjuncts.map(() => b());
  return [
    quad(n(shape.subject), n(SUB_CLASS_OF), expr, g),
    quad(expr, n(`${RDF}type`), n(`${OWL}Class`), g),
    quad(expr, n(`${OWL}intersectionOf`), cells[0], g),
    ...conjuncts.flatMap((c, i) => [
      quad(cells[i], n(`${RDF}first`), n(c), g),
      quad(cells[i], n(`${RDF}rest`), i + 1 < conjuncts.length ? cells[i + 1] : n(`${RDF}nil`), g),
    ]),
  ];
}

/** Strict ancestors (named superclasses, equivalents excluded) from a list of entailed [sub, super] pairs. */
function hierarchy(pairs: ReadonlyArray<[string, string]>) {
  const up = new Map<string, Set<string>>();
  for (const [sub, sup] of pairs) {
    if (sub === sup || TOP_BOTTOM.has(sup)) continue;
    (up.get(sub) ?? up.set(sub, new Set()).get(sub)!).add(sup);
  }
  const closure = (x: string): Set<string> => {
    const out = new Set<string>();
    const stack = [...(up.get(x) ?? [])];
    while (stack.length) {
      const s = stack.pop()!;
      if (out.has(s)) continue;
      out.add(s);
      stack.push(...(up.get(s) ?? []));
    }
    return out;
  };
  const cache = new Map<string, Set<string>>();
  const ancestors = (x: string): Set<string> => {
    let a = cache.get(x);
    if (!a) {
      a = new Set([...closure(x)].filter(s => s !== x && !closure(s).has(x))); // equivalents are not "above"
      cache.set(x, a);
    }
    return a;
  };
  const directSupers = (x: string): string[] => {
    const anc = ancestors(x);
    return [...anc].filter(s => ![...anc].some(t => t !== s && ancestors(t).has(s)));
  };
  return { ancestors, directSupers };
}

export async function computeWeakenings(args: {
  base: Quad[];
  culprit: Axiom;
  oracle: AssessOracle;
  deadline: number;
}): Promise<WeakenResult> {
  const { base, culprit, oracle, deadline } = args;
  const result: WeakenResult = { weakenings: [], incomplete: false };
  const fail = (reason: NonNullable<WeakenResult["reason"]>, incomplete = false): WeakenResult => {
    result.reason = reason;
    result.incomplete = incomplete;
    return result;
  };
  const shape = parseCulprit(culprit);
  if (!shape) return fail("unsupported-axiom");
  const present = new Set(base.map(quadKey));
  if (!culprit.quads.every(q => present.has(quadKey(q)))) return fail("culprit-not-in-store");

  const removeKeys = new Set(culprit.quads.map(quadKey));
  const rest = base.filter(q => !removeKeys.has(quadKey(q)));
  const expired = () => Date.now() >= deadline;
  const inc = await oracle.inconsistent(dropAnnotationTriples(rest));
  if (inc === "aborted") return fail("deadline", true);
  if (inc) return fail("removal-does-not-restore-consistency");

  const deleteWeakening: Weakening = { strategy: "delete", remove: culprit.quads, add: [], verifiedConsistent: true };
  const pairs = await oracle.subClassPairs(dropAnnotationTriples(rest));
  if (pairs === "aborted") {
    result.weakenings.push(deleteWeakening);
    return fail("deadline", true);
  }
  const { ancestors, directSupers } = hierarchy(pairs);

  // verification: consistent AND the target class stays satisfiable
  const verify = async (conjuncts: readonly string[]): Promise<boolean | "aborted"> => {
    const edited = dropAnnotationTriples([...rest, ...subClassAxiomQuads(shape, conjuncts)]);
    const bad = await oracle.inconsistent(edited);
    if (bad === "aborted") return "aborted";
    if (bad) return false;
    const unsat = await oracle.unsatisfiable(edited);
    if (unsat === "aborted") return "aborted";
    return !unsat.has(shape.subject);
  };

  const generalizations: Weakening[] = [];
  const drops: Weakening[] = [];
  const entailedAlready = ancestors(shape.subject); // X subClassOf S holds without the culprit
  let aborted = false;
  search: for (let i = 0; i < shape.conjuncts.length; i++) {
    const others = shape.conjuncts.filter((_, k) => k !== i);
    const queue = directSupers(shape.conjuncts[i]);
    const tried = new Set<string>();
    const pruned = new Set<string>();
    while (queue.length > 0) {
      if (expired()) {
        aborted = true;
        break search;
      }
      const s = queue.shift()!;
      if (tried.has(s) || pruned.has(s)) continue;
      tried.add(s);
      if (entailedAlready.has(s)) {
        for (const a of ancestors(s)) pruned.add(a);
        continue;
      }
      if (others.includes(s)) {
        queue.push(...directSupers(s)); // same as dropping the conjunct; look above it
        continue;
      }
      const ok = await verify([...others.slice(0, i), s, ...others.slice(i)]);
      if (ok === "aborted") {
        aborted = true;
        break search;
      }
      if (ok) {
        generalizations.push({
          strategy: "generalize",
          remove: culprit.quads,
          add: subClassAxiomQuads(shape, [...others.slice(0, i), s, ...others.slice(i)]),
          verifiedConsistent: true,
          change: { from: shape.conjuncts[i], to: s },
        });
        for (const a of ancestors(s)) pruned.add(a); // weaker than a working replacement: not minimal
      } else queue.push(...directSupers(s));
    }
  }
  if (!aborted && shape.conjuncts.length >= 2) {
    for (let i = 0; i < shape.conjuncts.length; i++) {
      if (expired()) {
        aborted = true;
        break;
      }
      const remaining = shape.conjuncts.filter((_, k) => k !== i);
      const ok = await verify(remaining);
      if (ok === "aborted") {
        aborted = true;
        break;
      }
      if (ok) drops.push({ strategy: "dropConjunct", remove: culprit.quads, add: subClassAxiomQuads(shape, remaining), verifiedConsistent: true, change: { from: shape.conjuncts[i], to: null } });
    }
  }
  result.weakenings = [...generalizations, ...drops, deleteWeakening];
  if (aborted) {
    result.incomplete = true;
    result.reason = "deadline";
  }
  return result;
}
