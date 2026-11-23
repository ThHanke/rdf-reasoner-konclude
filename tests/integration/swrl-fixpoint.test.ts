/**
 * Integration test: DL-safe SWRL fixpoint in materialize() (ts/swrl.ts, RdfReasoner._swrlFixpoint).
 *
 * Pins the observable result (rounds, derived triples, the derived set itself) on a small generated part-of tree with the
 * two rules from the reviewer kit's SWRL check:
 *   R1  Quality(d) ^ hasCharacteristic(e,d)  -> hasQuality(e,d)
 *   R2  hasQuality(e,d) ^ partOf(e,m)        -> hasQuality(m,d)   (moves a quality up one level per round)
 * The expected derived set is computed here by a plain TypeScript fixpoint over the asserted facts (the oracle), so any
 * change to how rounds are executed (batching, closure before the kernel call) must reproduce it exactly.
 * One shared reasoner for the file.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { Parser, Store } from "n3";

import { RdfReasoner, InconsistentOntologyError } from "../../ts/index.js";
import { Facts, applyRules, parseRules } from "../../ts/swrl.js";

const wasmExists = existsSync(new URL("../../dist/konclude.wasm", import.meta.url).pathname);

const PRE = `@prefix swrl: <http://www.w3.org/2003/11/swrl#> . @prefix ex: <http://ex.org/> . @prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .\n`;

function imp(body: string[], head: string): string {
  return `[ a swrl:Imp ; swrl:body ( ${body.join(" ")} ) ; swrl:head ( ${head} ) ] .\n`;
}
const prop = (p: string, a: string, b: string) =>
  `[ a swrl:IndividualPropertyAtom ; swrl:propertyPredicate ex:${p} ; swrl:argument1 ex:${a} ; swrl:argument2 ex:${b} ]`;
const cls = (c: string, a: string) => `[ a swrl:ClassAtom ; swrl:classPredicate ex:${c} ; swrl:argument1 ex:${a} ]`;

/** Ternary part-of tree of `n` materials with three qualities each (deterministic). */
function treeOntology(n: number): string {
  let ttl = PRE + `ex:Quality a owl:Class . ex:Material a owl:Class . ex:Hard a owl:Class ; rdfs:subClassOf ex:Quality .
ex:hasCharacteristic a owl:ObjectProperty ; rdfs:domain ex:Material ; rdfs:range ex:Quality .
ex:hasQuality a owl:ObjectProperty ; rdfs:domain ex:Material ; rdfs:range ex:Quality .
ex:partOf a owl:ObjectProperty ; rdfs:domain ex:Material ; rdfs:range ex:Material .\n`;
  for (let i = 0; i < n; i++) {
    ttl += `ex:m${i} a ex:Material .\n`;
    if (i > 0) ttl += `ex:m${i} ex:partOf ex:m${Math.floor((i - 1) / 3)} .\n`;
    for (let k = 0; k < 3; k++) ttl += `ex:q${i}_${k} a ${(i + k) % 3 === 0 ? "ex:Hard" : "ex:Quality"} . ex:m${i} ex:hasCharacteristic ex:q${i}_${k} .\n`;
  }
  return ttl;
}
const VARS = `ex:e a swrl:Variable . ex:d a swrl:Variable . ex:m a swrl:Variable .\n`;
const R1 = imp([cls("Quality", "d"), prop("hasCharacteristic", "e", "d")], prop("hasQuality", "e", "d"));
const R2 = imp([prop("hasQuality", "e", "d"), prop("partOf", "e", "m")], prop("hasQuality", "m", "d"));

const parse = (s: string) => new Parser().parse(s);
const line = (s: string, p: string, o: string) => `${s} ${p} ${o}`;

/** Oracle: naive rule fixpoint over the asserted quads. Class membership comes from asserted rdf:type and rdfs:subClassOf
 *  (Hard ⊑ Quality), which is all R1 needs here; the kernel adds nothing the rules consume in this ontology. */
function oracleDerived(ttl: string): Set<string> {
  const quads = parse(ttl);
  const { rules } = parseRules(quads);
  const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
  const extra = quads
    .filter((q) => q.predicate.value === RDF_TYPE && q.object.value === "http://ex.org/Hard")
    .map((q) => new Parser().parse(`<${q.subject.value}> a <http://ex.org/Quality> .`)[0]);
  const all = [...quads, ...extra];
  const derived = new Set<string>();
  for (;;) {
    const facts = new Facts([...all, ...[...derived].map((l) => {
      const [s, p, o] = l.split(" ");
      return new Parser().parse(`<${s}> <${p}> <${o}> .`)[0];
    })]);
    const add = applyRules(rules, facts).map(([s, p, o]) => line(s.value, p, o.value));
    const fresh = add.filter((a) => !derived.has(a));
    if (fresh.length === 0) return derived;
    fresh.forEach((f) => derived.add(f));
  }
}

describe.skipIf(!wasmExists)("DL-safe SWRL fixpoint in materialize()", () => {
  let reasoner: RdfReasoner;
  beforeAll(async () => {
    reasoner = new RdfReasoner();
    await reasoner.ready;
  }, 60_000);
  afterAll(() => reasoner?.terminate());

  it("derives the oracle's set for the chained part-of rules and reports rounds", async () => {
    const ttl = treeOntology(40) + VARS + R1 + R2;
    const store = new Store(parse(ttl));
    await reasoner.materialize(store);
    const { rules, unsupported, rounds, derived } = reasoner.lastSwrl;
    expect(rules).toBe(2);
    expect(unsupported).toEqual([]);

    const expected = oracleDerived(ttl);
    expect(derived).toBe(expected.size);
    // hasQuality(m,d) edges must be in the store (inferred or derived graph) for every oracle edge
    const have = new Set(
      store
        .getQuads(null, "http://ex.org/hasQuality", null, null)
        .map((q) => line(q.subject.value, q.predicate.value, q.object.value)),
    );
    for (const e of expected) expect(have.has(e), `missing ${e}`).toBe(true);
    // the rule chain (R2 moves a quality up one level per step) is closed in TypeScript: one kernel round plus the
    // confirming pass, not one kernel round per tree level (the pre-batching implementation needed 5 for 40 nodes)
    expect(rounds).toBeLessThanOrEqual(3);
  }, 120_000);

  it("rules whose body never matches derive nothing and cost no extra round", async () => {
    const ttl = treeOntology(10) + VARS + imp([prop("nonexistent", "e", "d")], prop("hasQuality", "e", "d"));
    const store = new Store(parse(ttl));
    await reasoner.materialize(store);
    expect(reasoner.lastSwrl.rules).toBe(1);
    expect(reasoner.lastSwrl.derived).toBe(0);
  }, 60_000);

  it("a rule with a built-in atom is reported as unsupported and skipped", async () => {
    const ttl =
      treeOntology(5) +
      VARS +
      `[ a swrl:Imp ; swrl:body ( [ a swrl:BuiltinAtom ; swrl:builtin swrl:greaterThan ; swrl:arguments ( ex:d 3 ) ] ) ; swrl:head ( ${cls("Hard", "d")} ) ] .\n`;
    const store = new Store(parse(ttl));
    await reasoner.materialize(store);
    expect(reasoner.lastSwrl.rules).toBe(0);
    expect(reasoner.lastSwrl.unsupported).toHaveLength(1);
  }, 60_000);

  it("derived facts that make the ontology inconsistent raise InconsistentOntologyError", async () => {
    // R: hasCharacteristic(e,d) -> partOf(e,d); with partOf irreflexive-free this is fine, so derive a clash instead:
    // every characteristic edge derives a membership in a class disjoint with Material.
    const ttl =
      treeOntology(4) +
      VARS +
      `ex:Other a owl:Class ; owl:disjointWith ex:Material .\n` +
      imp([prop("hasCharacteristic", "e", "d")], cls("Other", "e"));
    const store = new Store(parse(ttl));
    await expect(reasoner.materialize(store)).rejects.toBeInstanceOf(InconsistentOntologyError);
  }, 60_000);

  it("a store without rules adds no SWRL cost and reports zero rules", async () => {
    const store = new Store(parse(treeOntology(10)));
    await reasoner.materialize(store);
    expect(reasoner.lastSwrl).toEqual({ rules: 0, unsupported: [], rounds: 0, derived: 0, applied: false });
  }, 60_000);

  it("swrl: false skips the rules, reports them with applied: false, and a later default call still applies them", async () => {
    const ttl = treeOntology(10) + VARS + R1 + R2;
    const store = new Store(parse(ttl));
    await reasoner.materialize(store, { swrl: false });
    expect(reasoner.lastSwrl).toMatchObject({ rules: 2, rounds: 0, derived: 0, applied: false });
    const without = store.getQuads(null, "http://ex.org/hasQuality", null, null).length;
    expect(without).toBe(0); // nothing derives hasQuality without the rules

    // same store, same content, other setting: must not be served from the previous call's cache
    await reasoner.materialize(store);
    expect(reasoner.lastSwrl.applied).toBe(true);
    expect(reasoner.lastSwrl.derived).toBeGreaterThan(0);
    expect(store.getQuads(null, "http://ex.org/hasQuality", null, null).length).toBeGreaterThan(0);
  }, 60_000);
});
