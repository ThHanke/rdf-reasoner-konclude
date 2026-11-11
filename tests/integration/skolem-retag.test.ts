/**
 * Skolem IRIs (urn:vg:bnode:*, RFC 7511 genid) must reason exactly like blank nodes without the caller copying the
 * store: the encoder sends them as blank nodes and the decoder restores the original IRI. Before this, only
 * someValuesFrom / hasValue / allValuesFrom restrictions worked with skolem IRIs; cardinalities, complementOf and
 * every RDF-list expression (intersectionOf, unionOf, oneOf) were silently missed.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { Store, Parser, DataFactory } from "n3";
import { RdfReasoner, INFERRED_GRAPH_IRI } from "../../ts/index.js";

const wasmExists = existsSync(new URL("../../dist/konclude.wasm", import.meta.url).pathname);
const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const OWL = "http://www.w3.org/2002/07/owl#";
const RDFS = "http://www.w3.org/2000/01/rdf-schema#";
const XSD_NNI = "http://www.w3.org/2001/XMLSchema#nonNegativeInteger";
const T = `<${RDF}type>`;
const ex = (s: string) => `<http://x/${s}>`;
const owl = (s: string) => `<${OWL}${s}>`;

type Mode = "skolem" | "genid" | "blank";

class Doc {
  private readonly lines: string[] = [];
  constructor(private readonly mode: Mode) {
    for (const c of ["A", "B", "C", "D"]) this.add(ex(c), T, owl("Class"));
    this.add(ex("P"), T, owl("ObjectProperty"));
    for (const x of ["i", "j", "k"]) this.add(ex(x), T, owl("NamedIndividual"));
  }
  add(s: string, p: string, o: string): void {
    this.lines.push(`${s} ${p} ${o} .`);
  }
  node(label: string): string {
    if (this.mode === "blank") return `_:${label}`;
    if (this.mode === "skolem") return `<urn:vg:bnode:${label}>`;
    return `<http://example.org/.well-known/genid/${label}>`;
  }
  list(prefix: string, items: string[]): string {
    items.forEach((item, n) => {
      const cell = this.node(prefix + n);
      this.add(cell, `<${RDF}first>`, item);
      this.add(cell, `<${RDF}rest>`, n === items.length - 1 ? `<${RDF}nil>` : this.node(prefix + (n + 1)));
    });
    return this.node(prefix + "0");
  }
  restriction(label: string, prop: string, value: string): string {
    const r = this.node(label);
    this.add(r, T, owl("Restriction"));
    this.add(r, owl("onProperty"), ex("P"));
    this.add(r, prop, value);
    return r;
  }
  expression(label: string, keyword: string, value: string): string {
    const e = this.node(label);
    this.add(e, T, owl("Class"));
    this.add(e, owl(keyword), value);
    return e;
  }
  text(): string {
    return this.lines.join("\n");
  }
}

type Case =
  | { entails: [string, string]; build: (d: Doc) => void } // [subject, class]: subject gets rdf:type class
  | { inconsistent: true; build: (d: Doc) => void };

const cases: Record<string, Case> = {
  someValuesFrom: {
    entails: ["i", "A"],
    build: (d) => {
      d.add(ex("A"), owl("equivalentClass"), d.restriction("r", owl("someValuesFrom"), ex("B")));
      d.add(ex("i"), ex("P"), ex("j"));
      d.add(ex("j"), T, ex("B"));
    },
  },
  hasValue: {
    entails: ["i", "A"],
    build: (d) => {
      d.add(ex("A"), owl("equivalentClass"), d.restriction("r", owl("hasValue"), ex("j")));
      d.add(ex("i"), ex("P"), ex("j"));
    },
  },
  allValuesFrom: {
    entails: ["j", "C"],
    build: (d) => {
      d.add(ex("A"), `<${RDFS}subClassOf>`, d.restriction("r", owl("allValuesFrom"), ex("C")));
      d.add(ex("i"), T, ex("A"));
      d.add(ex("i"), ex("P"), ex("j"));
    },
  },
  minCardinality: {
    entails: ["i", "A"],
    build: (d) => {
      d.add(ex("A"), owl("equivalentClass"), d.restriction("r", owl("minCardinality"), `"2"^^<${XSD_NNI}>`));
      d.add(ex("i"), ex("P"), ex("j"));
      d.add(ex("i"), ex("P"), ex("k"));
      d.add(ex("j"), owl("differentFrom"), ex("k"));
    },
  },
  intersectionOf: {
    entails: ["i", "A"],
    build: (d) => {
      d.add(ex("A"), owl("equivalentClass"), d.expression("e", "intersectionOf", d.list("l", [ex("B"), ex("C")])));
      d.add(ex("i"), T, ex("B"));
      d.add(ex("i"), T, ex("C"));
    },
  },
  unionOf: {
    entails: ["i", "A"],
    build: (d) => {
      d.add(ex("A"), owl("equivalentClass"), d.expression("e", "unionOf", d.list("l", [ex("B"), ex("C")])));
      d.add(ex("i"), T, ex("B"));
    },
  },
  oneOf: {
    entails: ["i", "A"],
    build: (d) => {
      d.add(ex("A"), owl("equivalentClass"), d.expression("e", "oneOf", d.list("l", [ex("i"), ex("k")])));
    },
  },
  complementOf: {
    inconsistent: true,
    build: (d) => {
      d.add(ex("A"), `<${RDFS}subClassOf>`, d.expression("e", "complementOf", ex("B")));
      d.add(ex("i"), T, ex("A"));
      d.add(ex("i"), T, ex("B"));
    },
  },
  "intersectionOf with a nested someValuesFrom over a unionOf": {
    entails: ["i", "A"],
    build: (d) => {
      const union = d.expression("u", "unionOf", d.list("m", [ex("C"), ex("D")]));
      const r = d.restriction("r", owl("someValuesFrom"), union);
      d.add(ex("A"), owl("equivalentClass"), d.expression("e", "intersectionOf", d.list("l", [ex("B"), r])));
      d.add(ex("i"), T, ex("B"));
      d.add(ex("i"), ex("P"), ex("j"));
      d.add(ex("j"), T, ex("D"));
    },
  },
};

describe.skipIf(!wasmExists)("skolem IRIs reason like blank nodes", () => {
  let reasoner: RdfReasoner;
  beforeAll(async () => {
    reasoner = new RdfReasoner();
    await reasoner.ready;
  });
  afterAll(() => reasoner?.terminate());

  const inferredOf = (store: Store) =>
    store.getQuads(null, null, null, DataFactory.namedNode(INFERRED_GRAPH_IRI));

  for (const [name, c] of Object.entries(cases)) {
    for (const mode of ["blank", "skolem", "genid"] as const) {
      it(`${name} (${mode})`, async () => {
        const doc = new Doc(mode);
        c.build(doc);
        const store = new Store(new Parser({ format: "N-Triples" }).parse(doc.text()));
        if ("inconsistent" in c) {
          expect(await reasoner.checkConsistency(store)).toBe(false);
          return;
        }
        await reasoner.materialize(store, { includeClassHierarchy: true });
        // The wire label of a retagged node must never reach the caller, also where the kernel names an
        // anonymous class expression in its output (for example `i rdf:type <expression node>`).
        for (const q of inferredOf(store)) {
          for (const term of [q.subject, q.predicate, q.object]) expect(term.value.startsWith("sk_")).toBe(false);
        }
        const [subject, cls] = c.entails;
        const hit = inferredOf(store).some(
          (q) =>
            q.subject.value === `http://x/${subject}` &&
            q.predicate.value === `${RDF}type` &&
            q.object.value === `http://x/${cls}`,
        );
        expect(hit).toBe(true);
      });
    }
  }

  it("inferred triples about skolem nodes come back with the original IRI; real blank nodes stay blank", async () => {
    const skolem = "urn:vg:bnode:ind1";
    const genid = "http://example.org/.well-known/genid/zz9";
    const nt = [
      `${ex("A")} ${T} ${owl("Class")} .`,
      `${ex("B")} ${T} ${owl("Class")} .`,
      `${ex("B")} <${RDFS}subClassOf> ${ex("A")} .`,
      ...[`<${skolem}>`, `<${genid}>`, "_:real"].flatMap((n) => [`${n} ${T} ${ex("B")} .`, `${n} ${T} ${owl("NamedIndividual")} .`]),
    ].join("\n");
    const store = new Store(new Parser({ format: "N-Triples" }).parse(nt));
    await reasoner.materialize(store);
    const inferred = inferredOf(store);
    const typedA = inferred.filter((q) => q.object.value === "http://x/A");
    expect(typedA.some((q) => q.subject.termType === "NamedNode" && q.subject.value === skolem)).toBe(true);
    expect(typedA.some((q) => q.subject.termType === "NamedNode" && q.subject.value === genid)).toBe(true);
    expect(typedA.some((q) => q.subject.termType === "BlankNode")).toBe(true);
    expect(inferred.some((q) => q.subject.value.startsWith("sk_") || q.object.value.startsWith("sk_"))).toBe(false);
  });
});
