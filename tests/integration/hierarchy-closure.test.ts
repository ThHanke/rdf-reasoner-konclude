/**
 * Integration test: opt-in `closure: true` writes the transitive closure of the class / property hierarchy into the
 * inferred graph. Default (off) keeps the reduced hierarchy; switching the option on the same unchanged store recomputes.
 * One shared reasoner for the file.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { DataFactory, Parser, Store } from "n3";

import { RdfReasoner, INFERRED_GRAPH_IRI } from "../../ts/index.js";

const wasmExists = existsSync(new URL("../../dist/konclude.wasm", import.meta.url).pathname);
const PRE = `@prefix : <http://ex.org/> . @prefix owl: <http://www.w3.org/2002/07/owl#> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .\n`;
const { namedNode } = DataFactory;
const SUB = "http://www.w3.org/2000/01/rdf-schema#subClassOf";
const SUBP = "http://www.w3.org/2000/01/rdf-schema#subPropertyOf";
const EQ = "http://www.w3.org/2002/07/owl#equivalentClass";
const EQP = "http://www.w3.org/2002/07/owl#equivalentProperty";
const ig = namedNode(INFERRED_GRAPH_IRI);
// asserted triples stay in the source graph and are not repeated in the inferred graph: look at both
const pairs = (s: Store, pred: string) => [...s.getQuads(null, namedNode(pred), null, ig), ...s.getQuads(null, namedNode(pred), null, DataFactory.defaultGraph())].map((q) => `${q.subject.value.replace("http://ex.org/", "")}>${q.object.value.replace(/.*[#/]/, "")}`).sort();

const classes = () => new Store(new Parser().parse(PRE + `:A a owl:Class ; rdfs:subClassOf :B . :B a owl:Class ; rdfs:subClassOf :C . :C a owl:Class ; rdfs:subClassOf :D . :D a owl:Class .
  :E a owl:Class ; owl:equivalentClass :D . :F a owl:Class .`));
const props = () => new Store(new Parser().parse(PRE + `:p a owl:ObjectProperty ; rdfs:subPropertyOf :q . :q a owl:ObjectProperty ; rdfs:subPropertyOf :t . :t a owl:ObjectProperty ; owl:equivalentProperty :u . :u a owl:ObjectProperty .`));

describe.skipIf(!wasmExists)("opt-in hierarchy closure", () => {
  let reasoner: RdfReasoner;
  beforeAll(async () => {
    reasoner = new RdfReasoner();
    await reasoner.ready;
  }, 60_000);
  afterAll(() => reasoner?.terminate());

  it("classify without closure writes only the direct hierarchy", async () => {
    const s = classes();
    await reasoner.classify(s);
    expect(pairs(s, SUB)).not.toContain("A>C");
    expect(pairs(s, SUB)).not.toContain("A>D");
  }, 60_000);

  it("classify with closure writes every entailed subsumption, nothing reflexive, nothing unrelated", async () => {
    const s = classes();
    await reasoner.classify(s, { closure: true });
    const sub = pairs(s, SUB);
    for (const x of ["A>B", "A>C", "A>D", "A>E", "B>C", "B>D", "B>E", "C>D", "C>E", "D>E", "E>D"]) expect(sub, x).toContain(x);
    expect(sub.some((x) => x.split(">")[0] === x.split(">")[1])).toBe(false); // no reflexive pair
    expect(sub.filter((x) => x.includes("F>") && !x.endsWith(">Thing"))).toEqual([]); // F is unrelated
    expect(pairs(s, EQ)).toEqual(expect.arrayContaining(["D>E", "E>D"]));
  }, 60_000);

  it("the same unchanged store with the option switched off (and on again) is recomputed, not served from the cache", async () => {
    const s = classes();
    await reasoner.classify(s, { closure: true });
    expect(pairs(s, SUB)).toContain("A>D");
    await reasoner.classify(s); // option off: the graph is rewritten without the closure
    expect(pairs(s, SUB)).not.toContain("A>D");
    await reasoner.classify(s, { closure: true });
    expect(pairs(s, SUB)).toContain("A>D");
  }, 90_000);

  it("classifyProperties with closure writes transitive subPropertyOf and equivalentProperty", async () => {
    const s = props();
    await reasoner.classifyProperties(s, { closure: true });
    const sub = pairs(s, SUBP);
    for (const x of ["p>q", "p>t", "p>u", "q>t", "q>u"]) expect(sub, x).toContain(x);
    expect(pairs(s, EQP)).toEqual(expect.arrayContaining(["t>u", "u>t"]));
    const plain = props();
    await reasoner.classifyProperties(plain);
    expect(pairs(plain, SUBP)).not.toContain("p>t");
  }, 90_000);

  it("materialize writes the class closure only together with includeClassHierarchy", async () => {
    const a = classes();
    await reasoner.materialize(a, { closure: true });
    expect(pairs(a, SUB)).not.toContain("A>D"); // hierarchy not requested: no closure written (only the asserted edges remain)
    const b = classes();
    await reasoner.materialize(b, { closure: true, includeClassHierarchy: true });
    expect(pairs(b, SUB)).toContain("A>D");
  }, 90_000);

  it("isEntailed agrees with the written closure", async () => {
    const s = classes();
    await reasoner.classify(s, { closure: true });
    const q = DataFactory.quad(namedNode("http://ex.org/A"), namedNode(SUB), namedNode("http://ex.org/D"));
    expect(await reasoner.isEntailed(s, q)).toBe(true);
  }, 60_000);
});
