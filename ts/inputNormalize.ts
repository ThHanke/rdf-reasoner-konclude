/**
 * Equivalence-preserving rewrites of the reasoning input for constructs that Konclude's RDF mapper
 * (vendor/konclude/Source/Reasoner/Generator/CConcreteOntologyRedlandTriplesDataExpressionMapper.cpp) reads wrongly.
 * Diagnosed on the W3C OWL 2 test cases: native Konclude v0.7.0 reading the same RDF/XML (Raptor parser) gives the same
 * wrong verdicts and the right ones on functional syntax; the rewritten input is read correctly by both.
 *
 * 1. owl:NegativePropertyAssertion: the filters read the wrong predicates (.cpp:2442-2444) and the literal branch builds a
 *    negative OBJECT property assertion (.cpp:454), so the axiom is lost. NegativePropertyAssertion(P a v) is rewritten to
 *    the equivalent class assertion a : ¬∃P.{v}.
 * 2. owl:bottomDataProperty is registered as the top object property (.cpp:2576-2577). It is replaced by a fresh data
 *    property whose range is the complement of rdfs:Literal (empty); `mapBackIri` restores the name in results.
 * 3. OWL 1 style boolean class definitions on a named class (`C owl:intersectionOf L`, also unionOf, oneOf,
 *    complementOf) are ignored (.cpp:1411). They are rewritten to `C owl:equivalentClass [ owl:intersectionOf L ]`.
 * 4. owl:propertyDisjointWith / owl:AllDisjointProperties between data properties are not enforced by the kernel.
 *    For every literal in the input and every disjoint pair (p, q) the axiom `owl:Thing ⊑ ¬(∃p.{v} ⊓ ∃q.{v})` is added
 *    (skipped above DISJOINT_DP_LIMIT literal/pair combinations).
 * 6. A reflexive assertion `a P a` does not make `a` an instance of `ObjectHasSelf(P)` in the kernel. When the input uses owl:hasSelf,
 *    `a rdf:type [ owl:onProperty P ; owl:hasSelf true ]` is added for each such assertion on a named individual.
 * 5. owl:hasKey is ignored by the kernel. Named individuals that are asserted instances of the key class (or of a
 *    subclass; owl:Thing = all) and share a value for every key property are made owl:sameAs (the DL-safe reading of
 *    HasKey: it only applies to named individuals and asserted values).
 */
import { canonicalizeXmlLiteral } from "./xmlLiteral.js";
import type { Quad, Term } from "@rdfjs/types";
import { DataFactory } from "n3";
import { isSkolemIri } from "./intern.js";

const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const RDFS = "http://www.w3.org/2000/01/rdf-schema#";
const OWL = "http://www.w3.org/2002/07/owl#";
const TYPE = RDF + "type";
export const NPA = OWL + "NegativePropertyAssertion";
export const BOTTOM_DP = OWL + "bottomDataProperty";
export const BOTTOM_DP_PROXY = "urn:konclude:bottomDataProperty";
/** Boolean class constructors that OWL 2 RDF puts on an anonymous class and OWL 1 also allowed on a named one. */
export const CLASS_CONSTRUCTORS: readonly string[] = ["intersectionOf", "unionOf", "oneOf", "complementOf"].map((n) => OWL + n);
const CONSTRUCTOR_SET = new Set(CLASS_CONSTRUCTORS);
/** A named class, not an anonymous class expression (Ontosphere stores blank nodes as skolem IRIs). */
const namedClass = (t: Term) => t.termType === "NamedNode" && !isSkolemIri(t.value);

const { namedNode, blankNode, quad, literal } = DataFactory;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const nn = (iri: string): any => namedNode(iri);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const q4 = (s: any, p: any, o: any, g?: any): Quad => quad(s, p, o, g) as unknown as Quad;

export const HAS_SELF = OWL + "hasSelf";
export const HAS_KEY = OWL + "hasKey";
export const PROP_DISJOINT = OWL + "propertyDisjointWith";
export const ALL_DISJOINT_PROPS = OWL + "AllDisjointProperties";
const DATATYPE_PROP = OWL + "DatatypeProperty";
/** Largest number of (literal, disjoint pair) axioms the DisjointDataProperties rewrite adds. */
export const DISJOINT_DP_LIMIT = 50000;

export const XML_LITERAL = RDF + "XMLLiteral";
const isXmlLiteral = (t: Term) => t.termType === "Literal" && (t as { datatype?: { value: string } }).datatype?.value === XML_LITERAL;
/** 4. rdf:XMLLiteral values in canonical form (the kernel compares the strings; see ts/xmlLiteral.ts); the term itself when it is already canonical or not well-formed. */
function canonicalXmlTerm(t: Term): Term {
  const canon = canonicalizeXmlLiteral(t.value);
  return canon === null || canon === t.value ? t : literal(canon, namedNode(XML_LITERAL));
}

/** True when the input contains a construct that one of the rewrites changes. */
export function needsRewrite(quads: Iterable<Quad>): boolean {
  for (const q of quads) {
    if (isXmlLiteral(q.object) && canonicalXmlTerm(q.object) !== q.object) return true;
    if (q.predicate.value === HAS_KEY || q.predicate.value === PROP_DISJOINT || q.predicate.value === HAS_SELF) return true;
    if (q.predicate.value === TYPE && (q.object.value === NPA || q.object.value === ALL_DISJOINT_PROPS)) return true;
    if (q.subject.value === BOTTOM_DP || q.predicate.value === BOTTOM_DP || q.object.value === BOTTOM_DP) return true;
    if (namedClass(q.subject) && CONSTRUCTOR_SET.has(q.predicate.value)) return true;
  }
  return false;
}

/** Applies the rewrites to a quad list; input without these constructs is returned as it is. */
export function normalizeQuads(input: readonly Quad[]): Quad[] {
  if (!needsRewrite(input)) return [...input];
  const bySubject = new Map<string, Quad[]>();
  for (const q of input) {
    const k = key(q.subject);
    (bySubject.get(k) ?? bySubject.set(k, []).get(k)!).push(q);
  }
  const get = (s: Term, p: string) => bySubject.get(key(s))?.find((q) => q.predicate.value === p)?.object;
  const drop = new Set<string>();
  const out: Quad[] = [];
  // 1. negative property assertions
  for (const q of input) {
    if (q.predicate.value !== TYPE || q.object.value !== NPA) continue;
    const n = q.subject;
    const src = get(n, OWL + "sourceIndividual"), prop = get(n, OWL + "assertionProperty");
    const target = get(n, OWL + "targetValue") ?? get(n, OWL + "targetIndividual");
    if (!src || !prop || !target) continue; // incomplete: left to the mapper as before
    drop.add(key(n));
    const id = `npa_${key(n).replace(/[^A-Za-z0-9]/g, "_")}`;
    const r = blankNode(`${id}_r`), c = blankNode(`${id}_c`);
    out.push(q4(r, nn(TYPE), nn(OWL + "Restriction")), q4(r, nn(OWL + "onProperty"), prop), q4(r, nn(OWL + "hasValue"), target),
      q4(c, nn(TYPE), nn(OWL + "Class")), q4(c, nn(OWL + "complementOf"), r), q4(src, nn(TYPE), c));
  }
  let usesBottom = false;
  const swap = (t: Term): Term => (t.termType === "NamedNode" && t.value === BOTTOM_DP ? ((usesBottom = true), namedNode(BOTTOM_DP_PROXY)) : isXmlLiteral(t) ? canonicalXmlTerm(t) : t);
  for (const q of input) {
    if (drop.has(key(q.subject))) continue;
    // 3. OWL 1 style constructor on a named class
    if (namedClass(q.subject) && CONSTRUCTOR_SET.has(q.predicate.value)) {
      // one class per constructor triple (a class with several owl:oneOf lists is the intersection of them: W3C description-logic-502); the label comes from the triple, not from a counter, so it is the same on every call
      const e = blankNode(`owl1_${q.predicate.value.slice(OWL.length)}_${q.subject.value.replace(/[^A-Za-z0-9]/g, "_")}_${q.object.value.replace(/[^A-Za-z0-9]/g, "_")}`);
      out.push(q4(q.subject, nn(OWL + "equivalentClass"), e, q.graph), q4(e, nn(TYPE), nn(OWL + "Class"), q.graph), q4(e, q.predicate, q.object, q.graph));
      continue;
    }
    // 2. bottom data property
    out.push(q4(swap(q.subject), swap(q.predicate), swap(q.object), q.graph));
  }
  if (usesBottom) {
    const e = blankNode("konclude_empty_data_range");
    out.push(q4(nn(BOTTOM_DP_PROXY), nn(TYPE), nn(OWL + "DatatypeProperty")), q4(nn(BOTTOM_DP_PROXY), nn(RDFS + "range"), e),
      q4(e, nn(TYPE), nn(RDFS + "Datatype")), q4(e, nn(OWL + "datatypeComplementOf"), nn(RDFS + "Literal")),
      q4(nn(RDFS + "Literal"), nn(TYPE), nn(RDFS + "Datatype")));
  }
  out.push(...disjointDataPropertyAxioms(input, bySubject), ...keySameAs(input, bySubject), ...selfAssertions(input));
  return out;
}

/** 6. `a rdf:type [ owl:onProperty P ; owl:hasSelf true ]` for each asserted `a P a`, when the input uses owl:hasSelf. */
function selfAssertions(input: readonly Quad[]): Quad[] {
  if (!input.some((q) => q.predicate.value === HAS_SELF)) return [];
  const out: Quad[] = [];
  const restriction = new Map<string, Term>();
  const seen = new Set<string>();
  for (const q of input) {
    const p = q.predicate.value;
    if (q.subject.termType !== "NamedNode" || q.object.termType !== "NamedNode" || q.subject.value !== q.object.value) continue;
    if (p.startsWith(RDF) || p.startsWith(RDFS) || p.startsWith(OWL)) continue;
    const id = `${q.subject.value}|${p}`;
    if (seen.has(id)) continue;
    seen.add(id);
    let r = restriction.get(p);
    if (!r) {
      r = blankNode(`self_${p.replace(/[^A-Za-z0-9]/g, "_")}`);
      restriction.set(p, r);
      out.push(q4(r, nn(TYPE), nn(OWL + "Restriction")), q4(r, nn(OWL + "onProperty"), q.predicate), q4(r, nn(HAS_SELF), literal("true", nn("http://www.w3.org/2001/XMLSchema#boolean"))));
    }
    out.push(q4(q.subject, nn(TYPE), r));
  }
  return out;
}

/** Members of an RDF list, empty when the list is malformed or cyclic. */
function rdfList(bySubject: Map<string, Quad[]>, head: Term | undefined): Term[] {
  const items: Term[] = [];
  const seen = new Set<string>();
  let cur = head;
  while (cur && !(cur.termType === "NamedNode" && cur.value === RDF + "nil")) {
    const k = key(cur);
    if (seen.has(k)) return [];
    seen.add(k);
    const qs = bySubject.get(k);
    const first = qs?.find((q) => q.predicate.value === RDF + "first")?.object;
    if (!first) return [];
    items.push(first);
    cur = qs?.find((q) => q.predicate.value === RDF + "rest")?.object;
  }
  return items;
}

/** 4. `owl:Thing ⊑ ¬(∃p.{v} ⊓ ∃q.{v})` for each data-property pair declared disjoint and each literal v of the input. */
function disjointDataPropertyAxioms(input: readonly Quad[], bySubject: Map<string, Quad[]>): Quad[] {
  const isDataProp = (t: Term) => input.some((q) => q.subject.equals(t) && q.predicate.value === TYPE && q.object.value === DATATYPE_PROP);
  const pairs: [Term, Term][] = [];
  const addAll = (props: Term[]) => {
    for (let i = 0; i < props.length; i++) for (let j = i + 1; j < props.length; j++) if (isDataProp(props[i]) && isDataProp(props[j])) pairs.push([props[i], props[j]]);
  };
  for (const q of input) {
    if (q.predicate.value === PROP_DISJOINT) addAll([q.subject, q.object]);
    else if (q.predicate.value === TYPE && q.object.value === ALL_DISJOINT_PROPS) {
      const members = bySubject.get(key(q.subject))?.find((m) => m.predicate.value === OWL + "members")?.object;
      addAll(rdfList(bySubject, members));
    }
  }
  if (!pairs.length) return [];
  const literals = new Map<string, Term>();
  for (const q of input) if (q.object.termType === "Literal") literals.set(`${q.object.value}|${(q.object as any).datatype?.value}|${(q.object as any).language}`, q.object);
  if (literals.size * pairs.length > DISJOINT_DP_LIMIT) return [];
  const out: Quad[] = [];
  let n = 0;
  for (const [p, q] of pairs) {
    for (const lit of literals.values()) {
      const id = `kdp_${n++}`;
      const rp = blankNode(`${id}_p`), rq = blankNode(`${id}_q`), l1 = blankNode(`${id}_l1`), l2 = blankNode(`${id}_l2`), inter = blankNode(`${id}_i`), comp = blankNode(`${id}_c`);
      out.push(
        q4(rp, nn(TYPE), nn(OWL + "Restriction")), q4(rp, nn(OWL + "onProperty"), p), q4(rp, nn(OWL + "hasValue"), lit),
        q4(rq, nn(TYPE), nn(OWL + "Restriction")), q4(rq, nn(OWL + "onProperty"), q), q4(rq, nn(OWL + "hasValue"), lit),
        q4(l1, nn(RDF + "first"), rp), q4(l1, nn(RDF + "rest"), l2), q4(l2, nn(RDF + "first"), rq), q4(l2, nn(RDF + "rest"), nn(RDF + "nil")),
        q4(inter, nn(TYPE), nn(OWL + "Class")), q4(inter, nn(OWL + "intersectionOf"), l1),
        q4(comp, nn(TYPE), nn(OWL + "Class")), q4(comp, nn(OWL + "complementOf"), inter),
        q4(nn(OWL + "Thing"), nn(RDFS + "subClassOf"), comp));
    }
  }
  return out;
}

/** 5. owl:sameAs between named individuals that fall under a key and share a value for every key property. */
function keySameAs(input: readonly Quad[], bySubject: Map<string, Quad[]>): Quad[] {
  const keys: { cls: Term; props: Term[] }[] = [];
  for (const q of input) if (q.predicate.value === HAS_KEY) keys.push({ cls: q.subject, props: rdfList(bySubject, q.object) });
  if (!keys.length) return [];
  // asserted subclass closure (named classes) and asserted types of named individuals
  const subs = new Map<string, Set<string>>();
  for (const q of input) if (q.predicate.value === RDFS + "subClassOf" && namedClass(q.subject) && namedClass(q.object)) (subs.get(q.object.value) ?? subs.set(q.object.value, new Set()).get(q.object.value)!).add(q.subject.value);
  const under = (cls: string): Set<string> => { const r = new Set([cls]); const todo = [cls]; while (todo.length) for (const s of subs.get(todo.pop()!) ?? []) if (!r.has(s)) { r.add(s); todo.push(s); } return r; };
  const types = new Map<string, Set<string>>();
  for (const q of input) if (q.predicate.value === TYPE && q.subject.termType === "NamedNode") (types.get(q.subject.value) ?? types.set(q.subject.value, new Set()).get(q.subject.value)!).add(q.object.value);
  const valueKey = (t: Term) => (t.termType === "Literal" ? `L${t.value}|${(t as any).datatype?.value}|${(t as any).language}` : t.termType === "NamedNode" ? `N${t.value}` : null);
  const out: Quad[] = [];
  const emitted = new Set<string>();
  for (const { cls, props } of keys) {
    if (!props.length || cls.termType !== "NamedNode") continue;
    const classes = under(cls.value);
    const isThing = cls.value === OWL + "Thing";
    // per key property: value -> subjects asserting it
    const perProp = props.map((p) => {
      const m = new Map<string, Set<string>>();
      for (const q of input) {
        if (q.predicate.value !== p.value || q.subject.termType !== "NamedNode") continue;
        const vk = valueKey(q.object);
        if (vk === null) continue;
        (m.get(vk) ?? m.set(vk, new Set()).get(vk)!).add(q.subject.value);
      }
      return m;
    });
    const candidate = (s: string) => isThing || [...(types.get(s) ?? [])].some((t) => classes.has(t));
    // pairs sharing a value of the first key property, then required to share one for each of the others
    for (const subjects of perProp[0].values()) {
      const list = [...subjects].filter(candidate);
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
        const [x, y] = list[i] < list[j] ? [list[i], list[j]] : [list[j], list[i]];
        const ok = perProp.every((m) => [...m.values()].some((set) => set.has(x) && set.has(y)));
        const id = `${x}|${y}`;
        if (ok && !emitted.has(id)) { emitted.add(id); out.push(q4(nn(x), nn(OWL + "sameAs"), nn(y))); }
      }
    }
  }
  return out;
}

/** Restores IRIs that the rewrites replaced, for terms coming back from the reasoner. */
export function mapBackIri(iri: string): string {
  return iri === BOTTOM_DP_PROXY ? BOTTOM_DP : iri;
}

const key = (t: Term) => (t.termType === "BlankNode" ? "_:" : "") + t.value;
