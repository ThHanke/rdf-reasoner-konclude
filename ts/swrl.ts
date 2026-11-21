/**
 * DL-safe SWRL rules (Motik, Sattler, Studer 2005): rule variables bind only to named individuals (IRIs).
 *
 * Konclude has no SWRL support and its RDF mapper drops the rule triples, and the rules usually cannot become
 * OWL 2 DL axioms (the rolification of `C(d) ∧ p(e,d) → q(e,d)` needs the chain p ∘ R_C ⊑ q, which is irregular when
 * q ⊑ p, as for PMDco's "has quality ⊑ has characteristic"). `materialize()` therefore applies the rules to the
 * realized ABox, adds the head atoms to the reasoning input and realizes again, until no rule adds a statement.
 *
 * Supported atoms: ClassAtom with a named class, IndividualPropertyAtom, DatavaluedPropertyAtom, SameIndividualAtom,
 * DifferentIndividualsAtom. A rule with any other atom (BuiltinAtom, DataRangeAtom, a class expression as class
 * predicate) is skipped and reported in `unsupported`.
 * ponytail: the fixpoint is sound and matches DL-safe semantics whenever each body atom is entailed on its own; a body
 * that holds in every model only by case distinction (e.g. d is a quality or a disposition, neither entailed) does not fire.
 */
import type { Quad, Term } from "@rdfjs/types";

const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const OWL = "http://www.w3.org/2002/07/owl#";
const SWRL = "http://www.w3.org/2003/11/swrl#";
const TYPE = RDF + "type";

/** A rule argument: a variable name, or a fixed term (named individual or literal). */
export type Arg = { v: string } | { t: Term };
export type Atom =
  | { kind: "class"; cls: string; a: Arg }
  | { kind: "prop"; p: string; a: Arg; b: Arg }
  | { kind: "same" | "different"; a: Arg; b: Arg };
export interface Rule { id: string; body: Atom[]; head: Atom[] }

/** Read the swrl:Imp rules in `quads`. */
export function parseRules(quads: readonly Quad[]): { rules: Rule[]; unsupported: string[] } {
  const out = new Map<string, Quad[]>();
  for (const q of quads) {
    const k = termKey(q.subject);
    (out.get(k) ?? out.set(k, []).get(k)!).push(q);
  }
  const get = (s: Term, p: string): Term | undefined => out.get(termKey(s))?.find((q) => q.predicate.value === p)?.object;
  const isVar = (t: Term) => (out.get(termKey(t)) ?? []).some((q) => q.predicate.value === TYPE && q.object.value === SWRL + "Variable");
  const arg = (t: Term | undefined): Arg | null => (!t ? null : isVar(t) ? { v: t.value } : { t });
  const list = (head: Term | undefined): Term[] | null => {
    const items: Term[] = [];
    for (let n = head, guard = 0; n && n.value !== RDF + "nil"; n = get(n, RDF + "rest"), guard++) {
      const first = get(n, RDF + "first");
      if (!first || guard > 10_000) return null;
      items.push(first);
    }
    return items;
  };
  const atom = (t: Term): Atom | null => {
    const type = (out.get(termKey(t)) ?? []).find((q) => q.predicate.value === TYPE && q.object.value.startsWith(SWRL))?.object.value;
    const a1 = arg(get(t, SWRL + "argument1")), a2 = arg(get(t, SWRL + "argument2"));
    switch (type) {
      case SWRL + "ClassAtom": {
        const c = get(t, SWRL + "classPredicate");
        return c?.termType === "NamedNode" && a1 ? { kind: "class", cls: c.value, a: a1 } : null;
      }
      case SWRL + "IndividualPropertyAtom":
      case SWRL + "DatavaluedPropertyAtom": {
        const p = get(t, SWRL + "propertyPredicate");
        return p?.termType === "NamedNode" && a1 && a2 ? { kind: "prop", p: p.value, a: a1, b: a2 } : null;
      }
      case SWRL + "SameIndividualAtom": return a1 && a2 ? { kind: "same", a: a1, b: a2 } : null;
      case SWRL + "DifferentIndividualsAtom": return a1 && a2 ? { kind: "different", a: a1, b: a2 } : null;
      default: return null;
    }
  };
  const rules: Rule[] = [], unsupported: string[] = [];
  for (const q of quads) {
    if (q.predicate.value !== TYPE || q.object.value !== SWRL + "Imp") continue;
    const b = list(get(q.subject, SWRL + "body")), h = list(get(q.subject, SWRL + "head"));
    const body = b?.map(atom), head = h?.map(atom);
    if (!body || !head || body.some((x) => !x) || head.some((x) => !x)) { unsupported.push(q.subject.value); continue; }
    // DL-safety: every head variable must occur in the body.
    const bodyVars = new Set(body.flatMap((x) => vars(x!)));
    if (head.some((x) => vars(x!).some((v) => !bodyVars.has(v)))) { unsupported.push(q.subject.value); continue; }
    rules.push({ id: q.subject.value, body: body as Atom[], head: head as Atom[] });
  }
  return { rules, unsupported };
}

/** Facts over which rules are matched: types, property assertions, sameAs/differentFrom. */
export class Facts {
  readonly types = new Map<string, Map<string, Term>>(); // class → ind key → ind
  readonly props = new Map<string, Map<string, [Term, Term]>>(); // property → "s\0o" → pair
  readonly bySubject = new Map<string, Map<string, Term[]>>(); // property → s key → objects
  constructor(quads: Iterable<Quad>) { for (const q of quads) this.add(q.subject, q.predicate.value, q.object); }
  add(s: Term, p: string, o: Term): boolean {
    if (p === TYPE) {
      if (o.termType !== "NamedNode") return false;
      const m = this.types.get(o.value) ?? this.types.set(o.value, new Map()).get(o.value)!;
      if (m.has(termKey(s))) return false;
      m.set(termKey(s), s); return true;
    }
    const m = this.props.get(p) ?? this.props.set(p, new Map()).get(p)!;
    const k = termKey(s) + "\0" + termKey(o);
    if (m.has(k)) return false;
    m.set(k, [s, o]);
    const bs = this.bySubject.get(p) ?? this.bySubject.set(p, new Map()).get(p)!;
    (bs.get(termKey(s)) ?? bs.set(termKey(s), []).get(termKey(s))!).push(o);
    return true;
  }
  has(s: Term, p: string, o: Term): boolean {
    return p === TYPE ? !!this.types.get(o.value)?.has(termKey(s)) : !!this.props.get(p)?.has(termKey(s) + "\0" + termKey(o));
  }
}

/** One pass over all rules: the head statements (as s, p, o) that `facts` does not yet hold. */
export function applyRules(rules: readonly Rule[], facts: Facts): Array<[Term, string, Term]> {
  const found = new Map<string, [Term, string, Term]>();
  for (const r of rules) {
    for (const env of match(r.body, 0, new Map(), facts)) {
      for (const h of r.head) {
        const t = headTriple(h, env);
        if (!t || facts.has(...t)) continue;
        found.set(termKey(t[0]) + "\0" + t[1] + "\0" + termKey(t[2]), t);
      }
    }
  }
  return [...found.values()];
}

function* match(body: readonly Atom[], i: number, env: Map<string, Term>, f: Facts): Generator<Map<string, Term>> {
  if (i === body.length) { yield env; return; }
  const at = body[i]!;
  const val = (a: Arg) => ("v" in a ? env.get(a.v) : a.t);
  const bind = (a: Arg, t: Term, e: Map<string, Term> = env): Map<string, Term> | null => {
    if (!("v" in a)) return sameTerm(a.t, t) ? e : null;
    const cur = e.get(a.v);
    if (cur) return sameTerm(cur, t) ? e : null;
    return new Map(e).set(a.v, t);
  };
  if (at.kind === "class") {
    const bound = val(at.a);
    const members = f.types.get(at.cls);
    if (!members) return;
    const cands = bound ? (members.has(termKey(bound)) ? [bound] : []) : [...members.values()];
    for (const t of cands) if (isNamed(t)) { const e = bind(at.a, t); if (e) yield* match(body, i + 1, e, f); }
    return;
  }
  const p = at.kind === "prop" ? at.p : at.kind === "same" ? OWL + "sameAs" : OWL + "differentFrom";
  const s = val(at.a), o = val(at.b);
  let pairs: Array<[Term, Term]>;
  if (s) pairs = (f.bySubject.get(p)?.get(termKey(s)) ?? []).map((x) => [s, x] as [Term, Term]);
  else pairs = [...(f.props.get(p)?.values() ?? [])];
  if (at.kind === "same" && s && o && sameTerm(s, o)) pairs = [[s, o]]; // x = x needs no owl:sameAs fact
  for (const [x, y] of pairs) {
    if (!isNamed(x) || (y.termType !== "Literal" && !isNamed(y))) continue;
    const e1 = bind(at.a, x); if (!e1) continue;
    const e2 = bind(at.b, y, e1);
    if (e2) yield* match(body, i + 1, e2, f);
  }
}

function headTriple(h: Atom, env: Map<string, Term>): [Term, string, Term] | null {
  const val = (a: Arg) => ("v" in a ? env.get(a.v) : a.t);
  if (h.kind === "class") { const s = val(h.a); return s ? [s, TYPE, { termType: "NamedNode", value: h.cls } as Term] : null; }
  const s = val(h.a), o = val(h.b);
  if (!s || !o || s.termType === "Literal") return null;
  const p = h.kind === "prop" ? h.p : h.kind === "same" ? OWL + "sameAs" : OWL + "differentFrom";
  return [s, p, o];
}

function vars(a: Atom): string[] {
  const r: string[] = [];
  for (const x of a.kind === "class" ? [a.a] : [a.a, a.b]) if ("v" in x) r.push(x.v);
  return r;
}
const isNamed = (t: Term) => t.termType === "NamedNode";
const sameTerm = (a: Term, b: Term) => termKey(a) === termKey(b);
function termKey(t: Term): string {
  if (t.termType === "Literal") { const l = t as any; return `"${l.value}"^^${l.datatype?.value ?? ""}@${l.language ?? ""}`; }
  return (t.termType === "BlankNode" ? "_:" : "") + t.value;
}
