import { describe, expect, it } from "vitest";
import { Parser } from "n3";
import { applyRules, Facts, parseRules } from "../../ts/swrl.js";

const PRE = `@prefix swrl: <http://www.w3.org/2003/11/swrl#> . @prefix ex: <http://ex.org/> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .`;
// PMDco form: quality(d) ∧ hasCharacteristic(e,d) → hasQuality(e,d)
const RULE = `${PRE}
ex:e a swrl:Variable . ex:d a swrl:Variable .
[ a swrl:Imp ;
  swrl:body ( [ a swrl:ClassAtom ; swrl:classPredicate ex:Quality ; swrl:argument1 ex:d ]
              [ a swrl:IndividualPropertyAtom ; swrl:propertyPredicate ex:hasCharacteristic ; swrl:argument1 ex:e ; swrl:argument2 ex:d ] ) ;
  swrl:head ( [ a swrl:IndividualPropertyAtom ; swrl:propertyPredicate ex:hasQuality ; swrl:argument1 ex:e ; swrl:argument2 ex:d ] ) ] .`;
const parse = (s: string) => new Parser().parse(s);
const keys = (t: ReturnType<typeof applyRules>) => t.map(([s, p, o]) => `${s.value} ${p} ${o.value}`).sort();

describe("DL-safe SWRL", () => {
  it("parses the PMDco rule form and derives the head for named individuals only", () => {
    const { rules, unsupported } = parseRules(parse(RULE));
    expect(rules).toHaveLength(1);
    expect(unsupported).toEqual([]);
    const facts = new Facts(parse(`${PRE}
      ex:q1 a ex:Quality . ex:steel ex:hasCharacteristic ex:q1 .
      ex:q2 a ex:Disposition . ex:steel ex:hasCharacteristic ex:q2 .
      _:b a ex:Quality . ex:steel ex:hasCharacteristic _:b .`));
    expect(keys(applyRules(rules, facts))).toEqual(["http://ex.org/steel http://ex.org/hasQuality http://ex.org/q1"]);
  });

  it("reports nothing once the head is present", () => {
    const { rules } = parseRules(parse(RULE));
    const facts = new Facts(parse(`${PRE} ex:q1 a ex:Quality . ex:steel ex:hasCharacteristic ex:q1 . ex:steel ex:hasQuality ex:q1 .`));
    expect(applyRules(rules, facts)).toEqual([]);
  });

  it("skips a rule with a built-in atom", () => {
    const { rules, unsupported } = parseRules(parse(`${PRE} ex:x a swrl:Variable .
      ex:r a swrl:Imp ; swrl:body ( [ a swrl:BuiltinAtom ; swrl:builtin swrl:greaterThan ; swrl:arguments ( ex:x 3 ) ] ) ;
        swrl:head ( [ a swrl:ClassAtom ; swrl:classPredicate ex:Big ; swrl:argument1 ex:x ] ) .`));
    expect(rules).toEqual([]);
    expect(unsupported).toEqual(["http://ex.org/r"]);
  });

  it("joins on a shared variable and supports class heads", () => {
    const { rules } = parseRules(parse(`${PRE} ex:x a swrl:Variable . ex:y a swrl:Variable .
      [ a swrl:Imp ; swrl:body ( [ a swrl:IndividualPropertyAtom ; swrl:propertyPredicate ex:partOf ; swrl:argument1 ex:x ; swrl:argument2 ex:y ]
                                 [ a swrl:ClassAtom ; swrl:classPredicate ex:Alloy ; swrl:argument1 ex:y ] ) ;
        swrl:head ( [ a swrl:ClassAtom ; swrl:classPredicate ex:Constituent ; swrl:argument1 ex:x ] ) ] .`));
    const facts = new Facts(parse(`${PRE} ex:fe ex:partOf ex:fesi . ex:fesi a ex:Alloy . ex:c ex:partOf ex:block .`));
    expect(keys(applyRules(rules, facts))).toEqual(["http://ex.org/fe http://www.w3.org/1999/02/22-rdf-syntax-ns#type http://ex.org/Constituent"]);
  });
});
