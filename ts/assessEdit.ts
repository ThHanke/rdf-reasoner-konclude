/**
 * assessEdit (C3 of the repair plan): what does a proposed edit cost, measured as entailed class disjointness lost.
 *
 * The pairs to protect are the ASSERTED disjointness pairs of the unedited store (`owl:disjointWith`,
 * `owl:AllDisjointClasses`, `owl:disjointUnionOf`, expanded, named classes only). They are read syntactically, so this
 * works for an inconsistent store too, where every pair is vacuously entailed. With `deriveFromHierarchy` the pairs
 * of the descendants of the asserted endpoints are added (they are entailed by monotonicity), which needs a
 * consistent unedited store. "Lost" = a pair that is no longer entailed disjoint after the edit: tested for all pairs
 * in one batch with probe classes (`P rdfs:subClassOf A, B` is unsatisfiable exactly when A and B are disjoint, or an
 * endpoint is unsatisfiable, in which case the disjointness holds vacuously and is not lost).
 */
import type { Quad } from "@rdfjs/types";
import { DataFactory } from "n3";
import { quadKey } from "./axiomGrouping.js";
import { dropAnnotationTriples } from "./annotations.js";
import type { AssessEditOptions, DisjointPair, Edit, EditAssessment } from "./types.js";

const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const RDFS = "http://www.w3.org/2000/01/rdf-schema#";
const OWL = "http://www.w3.org/2002/07/owl#";
export const PROBE_NS = "urn:konclude:assess-probe:";
export const MAX_PAIRS = 5000;

const pairKey = (p: DisjointPair): string => `${p.a}\0${p.b}`;
const mkPair = (x: string, y: string): DisjointPair => (x < y ? { a: x, b: y } : { a: y, b: x });

/** The elements of the RDF list starting at `head` (named nodes only; stops at rdf:nil or a broken list). */
function listMembers(head: string, bySubject: Map<string, Quad[]>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let cell: string | undefined = head;
  while (cell && cell !== `${RDF}nil` && !seen.has(cell)) {
    seen.add(cell);
    const cellQuads: Quad[] = bySubject.get(cell) ?? [];
    const first = cellQuads.find(q => q.predicate.value === `${RDF}first`);
    if (first && first.object.termType === "NamedNode") out.push(first.object.value);
    cell = cellQuads.find(q => q.predicate.value === `${RDF}rest`)?.object.value;
  }
  return out;
}

/** Asserted disjointness pairs between named classes (see module comment). Result is deduplicated, `a < b`. */
export function assertedDisjointPairs(quads: readonly Quad[]): DisjointPair[] {
  const bySubject = new Map<string, Quad[]>();
  for (const q of quads) {
    const k = q.subject.value;
    const list = bySubject.get(k);
    if (list) list.push(q);
    else bySubject.set(k, [q]);
  }
  const pairs = new Map<string, DisjointPair>();
  const add = (x: string, y: string) => {
    if (x === y) return;
    const p = mkPair(x, y);
    pairs.set(pairKey(p), p);
  };
  const allPairs = (members: string[]) => {
    for (let i = 0; i < members.length; i++) for (let j = i + 1; j < members.length; j++) add(members[i], members[j]);
  };
  for (const q of quads) {
    if (q.predicate.value === `${OWL}disjointWith` && q.subject.termType === "NamedNode" && q.object.termType === "NamedNode") {
      add(q.subject.value, q.object.value);
    } else if (q.predicate.value === `${OWL}disjointUnionOf` && q.subject.termType === "NamedNode" && q.object.value) {
      allPairs(listMembers(q.object.value, bySubject));
    } else if (q.predicate.value === `${OWL}members` && q.subject.termType === "BlankNode") {
      const isAllDisjointClasses = (bySubject.get(q.subject.value) ?? []).some(t => t.predicate.value === `${RDF}type` && t.object.value === `${OWL}AllDisjointClasses`);
      if (isAllDisjointClasses) allPairs(listMembers(q.object.value, bySubject));
    }
  }
  return [...pairs.values()].sort((x, y) => (x.a < y.a ? -1 : x.a > y.a ? 1 : x.b < y.b ? -1 : x.b > y.b ? 1 : 0));
}

/** The probe quads for a batch of pairs: one satisfiable-unless-disjoint class per pair. */
export function probeQuads(pairs: readonly DisjointPair[]): Quad[] {
  const { namedNode: n, quad } = DataFactory;
  return pairs.flatMap((p, i) => {
    const probe = n(`${PROBE_NS}${i}`);
    return [
      quad(probe, n(`${RDF}type`), n(`${OWL}Class`)),
      quad(probe, n(`${RDFS}subClassOf`), n(p.a)),
      quad(probe, n(`${RDFS}subClassOf`), n(p.b)),
    ];
  });
}

export interface AssessOracle {
  /** True when the quad set is inconsistent; "aborted" when the deadline cut the check short. */
  inconsistent(quads: Quad[]): Promise<boolean | "aborted">;
  /** IRIs of the unsatisfiable classes of a (consistent) quad set; "aborted" on deadline. */
  unsatisfiable(quads: Quad[]): Promise<Set<string> | "aborted">;
  /** Entailed named `rdfs:subClassOf` pairs [sub, super] of a (consistent) quad set; "aborted" on deadline. */
  subClassPairs(quads: Quad[]): Promise<Array<[string, string]> | "aborted">;
}

export async function computeAssessment(args: {
  base: Quad[];
  edit: Edit;
  opts?: AssessEditOptions;
  oracle: AssessOracle;
}): Promise<EditAssessment> {
  const { base, edit, opts, oracle } = args;
  const result: EditAssessment = { consistent: false, lostDisjointPairs: null, pairsChecked: [], unmatchedRemovals: [], incomplete: false };
  const stop = (reason: "deadline" | "pair-cap"): EditAssessment => {
    result.incomplete = true;
    result.reason = reason;
    return result;
  };

  // the edit: removals by exact quad identity (graph included), then additions
  const present = new Set(base.map(quadKey));
  const removeKeys = new Set((edit.remove ?? []).map(quadKey));
  result.unmatchedRemovals = (edit.remove ?? []).filter(q => !present.has(quadKey(q)));
  const seen = new Set<string>();
  const edited = [...base.filter(q => !removeKeys.has(quadKey(q))), ...(edit.add ?? [])].filter(q => {
    const k = quadKey(q);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const editedForReasoning = dropAnnotationTriples(edited);

  const inc = await oracle.inconsistent(editedForReasoning);
  if (inc === "aborted") return stop("deadline");
  result.consistent = !inc;

  // the pairs to protect
  let pairs = opts?.pairs ? opts.pairs.map(p => mkPair(p.a, p.b)) : assertedDisjointPairs(base);
  if (!opts?.pairs && opts?.deriveFromHierarchy) {
    const beforeInc = await oracle.inconsistent(dropAnnotationTriples(base));
    if (beforeInc === "aborted") return stop("deadline");
    if (!beforeInc) {
      const subs = await oracle.subClassPairs(dropAnnotationTriples(base));
      if (subs === "aborted") return stop("deadline");
      const descendants = new Map<string, Set<string>>();
      for (const [sub, sup] of subs) {
        const set = descendants.get(sup);
        if (set) set.add(sub);
        else descendants.set(sup, new Set([sub]));
      }
      const derived = new Map<string, DisjointPair>();
      for (const p of pairs) {
        for (const x of [p.a, ...(descendants.get(p.a) ?? [])]) {
          for (const y of [p.b, ...(descendants.get(p.b) ?? [])]) {
            if (x !== y) derived.set(pairKey(mkPair(x, y)), mkPair(x, y));
            if (derived.size > MAX_PAIRS) break;
          }
        }
      }
      pairs = [...derived.values()];
    }
  }
  const unique = new Map(pairs.map(p => [pairKey(p), p]));
  pairs = [...unique.values()];
  result.pairsChecked = pairs;
  if (pairs.length > MAX_PAIRS) return stop("pair-cap");

  if (inc) {
    result.reason = "edited-inconsistent";
    return result;
  }
  if (pairs.length === 0) {
    result.lostDisjointPairs = [];
    return result;
  }
  const unsat = await oracle.unsatisfiable([...editedForReasoning, ...probeQuads(pairs)]);
  if (unsat === "aborted") return stop("deadline");
  result.lostDisjointPairs = pairs.filter((_, i) => !unsat.has(`${PROBE_NS}${i}`));
  return result;
}

