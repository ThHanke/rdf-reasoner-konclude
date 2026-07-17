import type { Quad, Term } from "@rdfjs/types";
import { DataFactory } from "n3";

const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const RDF_FIRST = "http://www.w3.org/1999/02/22-rdf-syntax-ns#first";
const RDF_REST = "http://www.w3.org/1999/02/22-rdf-syntax-ns#rest";
const RDF_NIL = "http://www.w3.org/1999/02/22-rdf-syntax-ns#nil";
const RDFS_SUBCLASS_OF = "http://www.w3.org/2000/01/rdf-schema#subClassOf";
const OWL_EQUIVALENT_CLASS = "http://www.w3.org/2002/07/owl#equivalentClass";
const OWL_RESTRICTION = "http://www.w3.org/2002/07/owl#Restriction";
const OWL_ON_PROPERTY = "http://www.w3.org/2002/07/owl#onProperty";
const OWL_SOME_VALUES_FROM = "http://www.w3.org/2002/07/owl#someValuesFrom";
const OWL_INTERSECTION_OF = "http://www.w3.org/2002/07/owl#intersectionOf";

export type LaconicAxiom = Quad[];

export interface LaconicResult {
  laconic: LaconicAxiom[];
  sources: Map<LaconicAxiom, LaconicAxiom>;
}

export type EntailsOracleAsync = (axiomSet: LaconicAxiom[]) => Promise<boolean>;

function isBlankValue(value: string): boolean {
  return value.startsWith("_:") || /^b\d+$/.test(value) || value.startsWith("n3-");
}

function isBlankTerm(term: Term): boolean {
  return term.termType === "BlankNode";
}

function quadTripleKey(q: Quad): string {
  return `${q.subject.value} ${q.predicate.value} ${q.object.value} ${q.object.termType === "Literal" ? "1" : "0"}`;
}

export function axiomKey(axiom: LaconicAxiom): string {
  return axiom.map(quadTripleKey).sort().join("");
}

function indexBySubject(quads: Quad[]): Map<string, Quad[]> {
  const out = new Map<string, Quad[]>();
  for (const q of quads) {
    const key = q.subject.value;
    let arr: Quad[] | undefined = out.get(key);
    if (!arr) { arr = []; out.set(key, arr); }
    arr.push(q);
  }
  return out;
}

function objQuad(
  bySubject: Map<string, Quad[]>,
  subject: string,
  predicate: string,
): Quad | undefined {
  return (bySubject.get(subject) ?? []).find(q => q.predicate.value === predicate);
}

function resolveList(bySubject: Map<string, Quad[]>, head: string): string[] {
  const items: string[] = [];
  const seen = new Set<string>();
  let cur: string | undefined = head;
  while (cur && cur !== RDF_NIL && !seen.has(cur)) {
    seen.add(cur);
    const arr: Quad[] = bySubject.get(cur) ?? [];
    const first = arr.find((q: Quad) => q.predicate.value === RDF_FIRST);
    const rest: Quad | undefined = arr.find((q: Quad) => q.predicate.value === RDF_REST);
    if (first) items.push(first.object.value);
    cur = rest?.object.value;
  }
  return items;
}

function blankClosure(
  bySubject: Map<string, Quad[]>,
  start: string,
  acc: Quad[],
  seen: Set<string>,
): void {
  if (seen.has(start)) return;
  seen.add(start);
  const arr = bySubject.get(start);
  if (!arr) return;
  for (const q of arr) {
    acc.push(q);
    if (q.object.termType !== "Literal" && isBlankTerm(q.object)) {
      blankClosure(bySubject, q.object.value, acc, seen);
    }
  }
}

function stableHash(s: string): string {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16);
}

function pushUnique(out: LaconicAxiom[], part: LaconicAxiom): void {
  const k = axiomKey(part);
  for (const existing of out) {
    if (axiomKey(existing) === k) return;
  }
  out.push(part);
}

function makeTerm(value: string): ReturnType<typeof DataFactory.namedNode> | ReturnType<typeof DataFactory.blankNode> {
  return isBlankValue(value) ? DataFactory.blankNode(value) : DataFactory.namedNode(value);
}

function makeQuad(s: string, p: string, o: string): Quad {
  return DataFactory.quad(
    makeTerm(s) as any,
    DataFactory.namedNode(p) as any,
    makeTerm(o) as any,
    DataFactory.defaultGraph(),
  ) as Quad;
}

function buildSubClassAxiom(
  bySubject: Map<string, Quad[]>,
  subject: string,
  rhsTerm: string,
): LaconicAxiom | undefined {
  if (!subject || !rhsTerm) return undefined;
  const triples: Quad[] = [makeQuad(subject, RDFS_SUBCLASS_OF, rhsTerm)];
  if (isBlankValue(rhsTerm)) {
    blankClosure(bySubject, rhsTerm, triples, new Set<string>());
  }
  return triples;
}

function buildSomeValuesAxiom(
  bySubject: Map<string, Quad[]>,
  subject: string,
  prop: string,
  fillerTerm: string,
): LaconicAxiom | undefined {
  if (!subject || !prop || !fillerTerm) return undefined;
  const restr = `_:laconic-${stableHash(`${subject}|${prop}|${fillerTerm}`)}`;
  const triples: Quad[] = [
    makeQuad(subject, RDFS_SUBCLASS_OF, restr),
    makeQuad(restr, RDF_TYPE, OWL_RESTRICTION),
    makeQuad(restr, OWL_ON_PROPERTY, prop),
    makeQuad(restr, OWL_SOME_VALUES_FROM, fillerTerm),
  ];
  if (isBlankValue(fillerTerm)) {
    blankClosure(bySubject, fillerTerm, triples, new Set<string>());
  }
  return triples;
}

function splitIntersectionRhs(
  bySubject: Map<string, Quad[]>,
  subject: string,
  rhs: string,
): LaconicAxiom[] | undefined {
  if (!isBlankValue(rhs)) return undefined;
  const inter = objQuad(bySubject, rhs, OWL_INTERSECTION_OF);
  if (!inter) return undefined;
  const members = resolveList(bySubject, inter.object.value);
  if (members.length === 0) return undefined;

  const out: LaconicAxiom[] = [];
  for (const m of members) {
    const part = buildSubClassAxiom(bySubject, subject, m);
    if (part) pushUnique(out, part);
  }
  return out.length > 0 ? out : undefined;
}

function splitSomeValuesIntersection(
  bySubject: Map<string, Quad[]>,
  subject: string,
  rhs: string,
): LaconicAxiom[] | undefined {
  if (!isBlankValue(rhs)) return undefined;
  const onProp = objQuad(bySubject, rhs, OWL_ON_PROPERTY);
  const some = objQuad(bySubject, rhs, OWL_SOME_VALUES_FROM);
  if (!onProp || !some || some.object.termType === "Literal") return undefined;

  const filler = some.object.value;
  if (!isBlankValue(filler)) return undefined;
  const inter = objQuad(bySubject, filler, OWL_INTERSECTION_OF);
  if (!inter) return undefined;
  const members = resolveList(bySubject, inter.object.value);
  if (members.length === 0) return undefined;

  const out: LaconicAxiom[] = [];
  for (const m of members) {
    const part = buildSomeValuesAxiom(bySubject, subject, onProp.object.value, m);
    if (part) pushUnique(out, part);
  }
  return out.length > 0 ? out : undefined;
}

export function splitAxiom(axiom: LaconicAxiom): LaconicAxiom[] {
  if (axiom.length === 0) return [axiom];

  const bySubject = indexBySubject(axiom);
  const principal = axiom[0];
  const p = principal.predicate.value;

  if (p === OWL_EQUIVALENT_CLASS && principal.object.termType !== "Literal") {
    const a = principal.subject.value;
    const b = principal.object.value;
    const forward = buildSubClassAxiom(bySubject, a, b);
    const backward = buildSubClassAxiom(bySubject, b, a);
    if (forward && backward) {
      const out: LaconicAxiom[] = [];
      for (const part of splitAxiom(forward)) pushUnique(out, part);
      for (const part of splitAxiom(backward)) pushUnique(out, part);
      return out;
    }
    return [axiom];
  }

  if (p === RDFS_SUBCLASS_OF && principal.object.termType !== "Literal") {
    const a = principal.subject.value;
    const rhs = principal.object.value;

    const interParts = splitIntersectionRhs(bySubject, a, rhs);
    if (interParts) return interParts;

    const someInterParts = splitSomeValuesIntersection(bySubject, a, rhs);
    if (someInterParts) return someInterParts;

    return [axiom];
  }

  return [axiom];
}

export async function computeLaconicAsync(
  justification: LaconicAxiom[],
  entails: EntailsOracleAsync,
): Promise<LaconicResult> {
  const candidates: LaconicAxiom[] = [];
  const candidateKeys = new Set<string>();
  const sources = new Map<LaconicAxiom, LaconicAxiom>();

  for (const original of justification) {
    const parts = splitAxiom(original);
    for (const part of parts) {
      const k = axiomKey(part);
      if (candidateKeys.has(k)) continue;
      candidateKeys.add(k);
      candidates.push(part);
      sources.set(part, original);
    }
  }

  if (!(await entails(candidates))) {
    const fallbackSources = new Map<LaconicAxiom, LaconicAxiom>();
    for (const a of justification) fallbackSources.set(a, a);
    return { laconic: [...justification], sources: fallbackSources };
  }

  let current = [...candidates];
  for (const part of candidates) {
    const without = current.filter(c => c !== part);
    if (await entails(without)) {
      current = without;
    }
  }

  const laconicSources = new Map<LaconicAxiom, LaconicAxiom>();
  for (const part of current) {
    const src = sources.get(part);
    if (src) laconicSources.set(part, src);
  }

  return { laconic: current, sources: laconicSources };
}

export function groupQuadsIntoAxioms(
  quads: Quad[],
  fullBase?: Quad[],
): { axioms: LaconicAxiom[]; sourceQuads: Map<string, Quad[]> } {
  const all = fullBase ?? quads;
  const bySubject = indexBySubject(all);

  const axioms: LaconicAxiom[] = [];
  const sourceQuads = new Map<string, Quad[]>();
  const claimed = new Set<Quad>();

  for (const q of quads) {
    if (claimed.has(q)) continue;
    if (isBlankTerm(q.subject)) continue;

    const axiom: Quad[] = [q];
    claimed.add(q);

    const collectBlanks = (term: Term) => {
      if (isBlankTerm(term)) {
        const closure: Quad[] = [];
        blankClosure(bySubject, term.value, closure, new Set<string>());
        for (const cq of closure) {
          if (!claimed.has(cq) && quads.includes(cq)) {
            axiom.push(cq);
            claimed.add(cq);
          }
        }
      }
    };

    collectBlanks(q.object);
    collectBlanks(q.subject);

    axioms.push(axiom);
    sourceQuads.set(axiomKey(axiom), axiom);
  }

  return { axioms, sourceQuads };
}
