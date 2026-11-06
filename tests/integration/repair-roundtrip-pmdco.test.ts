/**
 * Integration test (opt-in, slow): the interactive repair round trip on PMDco-size input, A2's reproducer.
 *
 *   load ontology -> checkConsistency -> explainInconsistencyAxioms -> remove an axiom -> checkConsistency -> classify
 *
 * Logs wall time of every step. Run with REPRO_PMDCO=1. The first clash (BFO continuant x occurrent) traps today
 * with "memory access out of bounds" after ~112 s (plan 2026-11-05-003, piece A2); the other clashes show whether
 * the trap is specific to that pair.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { DataFactory, Parser, Store } from "n3";

import { RdfReasoner } from "../../ts/index.js";

const wasmExists = existsSync(new URL("../../dist/konclude.wasm", import.meta.url).pathname);
const enabled = process.env.REPRO_PMDCO === "1";

const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const BFO = "http://purl.obolibrary.org/obo/BFO_";
const { namedNode: n, quad } = DataFactory;
const fixture = new URL("../fixtures/pmdco.nt", import.meta.url).pathname;

// The known-trap clash runs LAST: after a WASM trap the shared reasoner does not recover, so later tests would hang.
const CLASHES: Array<[string, string, string]> = [
  ["0000004 x 0000020", `${BFO}0000004`, `${BFO}0000020`],
  ["0000016 x 0000023", `${BFO}0000016`, `${BFO}0000023`],
  ["continuant x occurrent (known trap)", `${BFO}0000002`, `${BFO}0000003`],
];

const secs = (t0: number) => ((performance.now() - t0) / 1000).toFixed(2) + "s";

describe.skipIf(!wasmExists || !enabled)("repair round trip on PMDco (A2 reproducer)", () => {
  let reasoner: RdfReasoner;
  let base: ReturnType<Parser["parse"]>;

  beforeAll(() => {
    reasoner = new RdfReasoner();
    base = new Parser({ format: "N-Triples" }).parse(readFileSync(fixture, "utf8"));
  });
  afterAll(async () => {
    await reasoner.terminate?.();
  });

  for (const [label, c1, c2] of CLASHES) {
    it(
      `${label}: explain once, remove an axiom, re-check and classify`,
      async () => {
        const ind = n(`http://ex.org/x-${c1.slice(-7)}-${c2.slice(-7)}`);
        const store = new Store([...base, quad(ind, n(RDF_TYPE), n(c1)), quad(ind, n(RDF_TYPE), n(c2))]);

        let t = performance.now();
        expect(await reasoner.checkConsistency(store)).toBe(false);
        console.log(`[roundtrip] ${label}: checkConsistency(inconsistent) ${secs(t)}`);

        t = performance.now();
        const js = await reasoner.explainInconsistencyAxioms(store, { maxJustifications: 1 });
        console.log(`[roundtrip] ${label}: explainInconsistencyAxioms ${secs(t)} -> ${js.length} justification(s), sizes ${js.map(j => j.axioms.length)}`);
        expect(js.length).toBeGreaterThanOrEqual(1);

        // Remove the first axiom of the first justification (whole unit, every graph copy).
        const victim = js[0].axioms[0];
        for (const q of victim.quads) store.removeQuad(q);

        t = performance.now();
        const consistent = await reasoner.checkConsistency(store);
        console.log(`[roundtrip] ${label}: checkConsistency after removal ${secs(t)} -> ${consistent}`);

        t = performance.now();
        await reasoner.classify(store);
        console.log(`[roundtrip] ${label}: classify after removal ${secs(t)}`);
      },
      420_000,
    );
  }

  it(
    "0000004 x 0000020 has two justifications; the AllDisjointClasses axiom is one grouped unit",
    async () => {
      const ind = n("http://ex.org/x-two-justifications");
      const store = new Store([...base, quad(ind, n(RDF_TYPE), n(`${BFO}0000004`)), quad(ind, n(RDF_TYPE), n(`${BFO}0000020`))]);
      const t = performance.now();
      const js = await reasoner.explainInconsistencyAxioms(store, { maxJustifications: 3 });
      console.log(`[roundtrip] two-justifications: explain ${secs(t)} -> sizes ${js.map(j => j.axioms.length)}`);
      expect(js.length).toBe(2);
      const adc = js.flatMap(j => j.axioms).find(a => a.principal.object.value === "http://www.w3.org/2002/07/owl#AllDisjointClasses");
      expect(adc).toBeDefined();
      expect(adc!.quads.length).toBeGreaterThanOrEqual(5); // type, members, two list cells (first/rest), not 5 singletons
      // the two type assertions are in both justifications: removing one of them alone restores consistency
      const shared = js[0].axioms.find(a => a.principal.subject.value === ind.value);
      expect(shared).toBeDefined();
      for (const q of shared!.quads) store.removeQuad(q);
      expect(await reasoner.checkConsistency(store)).toBe(true);
    },
    420_000,
  );

  it(
    "repair(): PMDco 0000004 x 0000020 -> one-axiom repair, verified, store untouched, round trip after applying",
    async () => {
      const ind = n("http://ex.org/x-repair");
      const store = new Store([...base, quad(ind, n(RDF_TYPE), n(`${BFO}0000004`)), quad(ind, n(RDF_TYPE), n(`${BFO}0000020`))]);
      const sizeBefore = store.size;
      const t = performance.now();
      const r = await reasoner.repair(store);
      console.log(`[roundtrip] repair(): ${secs(t)} -> ${r.repairs.length} repair(s) sizes ${r.repairs.map(x => x.remove.length)} justifications ${r.justifications.length} incomplete=${r.incomplete} ${r.reason ?? ""}`);
      expect(store.size).toBe(sizeBefore);
      expect(r.consistent).toBe(false);
      expect(r.repairs.length).toBeGreaterThanOrEqual(1);
      const best = r.repairs[0];
      expect(best).toMatchObject({ verifiedConsistent: true, minimal: true });
      expect(best.remove).toHaveLength(1); // a type assertion shared by both justifications
      for (const q of best.remove.flatMap(a => a.quads)) store.removeQuad(q);
      let t2 = performance.now();
      expect(await reasoner.checkConsistency(store)).toBe(true);
      console.log(`[roundtrip] repair(): checkConsistency after applying ${secs(t2)}`);
      t2 = performance.now();
      await reasoner.classify(store);
      console.log(`[roundtrip] repair(): classify after applying ${secs(t2)}`);
    },
    600_000,
  );

  it(
    "assessEdit(): cost of each repair of the real BFO clash on PMDco",
    async () => {
      const ind = n("http://ex.org/x-assess");
      const store = new Store([...base, quad(ind, n(RDF_TYPE), n(`${BFO}0000004`)), quad(ind, n(RDF_TYPE), n(`${BFO}0000020`))]);
      const rep = await reasoner.repair(store);
      expect(rep.repairs.length).toBeGreaterThanOrEqual(3);
      const short = (iri: string) => iri.replace("http://purl.obolibrary.org/obo/", "obo:");
      for (const r of rep.repairs) {
        const label = r.remove.map((a) => `${short(a.principal.subject.value)} ${short(a.principal.predicate.value.replace(/^.*[#/]/, ""))}`).join(" + ");
        const t = performance.now();
        const cost = await reasoner.assessEdit(store, { remove: r.remove.flatMap((a) => a.quads) });
        console.log(`[roundtrip] assessEdit [${label}]: ${secs(t)}; consistent=${cost.consistent}; pairs checked=${cost.pairsChecked.length}; lost=${cost.lostDisjointPairs?.length}${cost.lostDisjointPairs?.length ? " e.g. " + cost.lostDisjointPairs.slice(0, 3).map((p) => `${short(p.a)}/${short(p.b)}`).join(", ") : ""}`);
        expect(cost.consistent).toBe(true);
        expect(cost.incomplete).toBe(false);
        const removesDisjointness = r.remove.some((a) => a.principal.predicate.value.endsWith("disjointWith") || a.principal.object.value.endsWith("AllDisjointClasses"));
        if (!removesDisjointness) expect(cost.lostDisjointPairs).toEqual([]);
        else expect(cost.lostDisjointPairs!.length).toBeGreaterThan(0);
      }
    },
    900_000,
  );

  it(
    "weaken(): real PMDco hierarchy, a useful generalization through multiple inheritance, and the redundant case",
    async () => {
      const SUB = n("http://www.w3.org/2000/01/rdf-schema#subClassOf");
      const CLASS = n("http://www.w3.org/2002/07/owl#Class");
      const DISJOINT = n("http://www.w3.org/2002/07/owl#disjointWith");
      const short = (iri: string) => iri.replace("http://purl.obolibrary.org/obo/", "obo:").replace("http://ex.org/", "ex:");
      const describe = (r: Awaited<ReturnType<typeof reasoner.weaken>>) =>
        `incomplete=${r.incomplete}${r.reason ? " " + r.reason : ""}; ` + r.weakenings.map((x) => `${x.strategy}${x.change ? " " + short(x.change.from) + " -> " + (x.change.to ? short(x.change.to) : "-") : ""}`).join(" | ");
      const applied = (store: InstanceType<typeof Store>, x: { remove: any[]; add: any[] }) => {
        const copy = new Store(store.getQuads(null, null, null, null));
        for (const q of x.remove) copy.removeQuad(q);
        for (const q of x.add) copy.addQuad(q);
        return copy;
      };

      // (1) CHEBI_194541 has two named parents (CHEBI_23367, CHEBI_25585). W is under it and under Z, which is disjoint from CHEBI_25585.
      const CHEBI = (id: string) => n(`http://purl.obolibrary.org/obo/CHEBI_${id}`);
      const W = n("http://ex.org/W"), Z = n("http://ex.org/Z"), w1 = n("http://ex.org/w1");
      const culpritQuad = quad(W, SUB, CHEBI("194541"));
      const store = new Store([...base, quad(W, n(RDF_TYPE), CLASS), quad(Z, n(RDF_TYPE), CLASS), culpritQuad, quad(W, SUB, Z), quad(Z, DISJOINT, CHEBI("25585")), quad(w1, n(RDF_TYPE), W)]);
      expect(await reasoner.checkConsistency(store)).toBe(false);
      let t = performance.now();
      const r = await reasoner.weaken(store, { principal: culpritQuad, quads: [culpritQuad] });
      console.log(`[roundtrip] weaken(W subClassOf CHEBI_194541), ${secs(t)}: ${describe(r)}`);
      expect(r.incomplete).toBe(false);
      expect(r.weakenings.at(-1)!.strategy).toBe("delete");
      const gen = r.weakenings.filter((x) => x.strategy === "generalize");
      expect(gen.map((x) => x.change!.to)).toContain(CHEBI("23367").value);
      expect(gen.map((x) => x.change!.to)).not.toContain(CHEBI("25585").value); // disjoint from Z: not a repair
      for (const x of r.weakenings) expect(await reasoner.checkConsistency(applied(store, x))).toBe(true);

      // (2) BFO: every superclass of BFO_0000004 is already entailed through W subClassOf BFO_0000020, so only the deletion is offered.
      const W2 = n("http://ex.org/W2"), cq2 = quad(W2, SUB, n(`${BFO}0000004`));
      const store2 = new Store([...base, quad(W2, n(RDF_TYPE), CLASS), cq2, quad(W2, SUB, n(`${BFO}0000020`)), quad(n("http://ex.org/w2"), n(RDF_TYPE), W2)]);
      t = performance.now();
      const r2 = await reasoner.weaken(store2, { principal: cq2, quads: [cq2] });
      console.log(`[roundtrip] weaken(W2 subClassOf BFO_0000004), ${secs(t)}: ${describe(r2)}`);
      expect(r2.weakenings.map((x) => x.strategy)).toEqual(["delete"]);
    },
    900_000,
  );

  it(
    "isEntailed(owl:disjointWith) on PMDco: derived pairs, a large batch, and an independent oracle on a sample",
    async () => {
      const DISJOINT = n("http://www.w3.org/2002/07/owl#disjointWith");
      const store = new Store(base);
      const obo = (id: string) => n(`http://purl.obolibrary.org/obo/${id}`);

      // continuant vs history: not asserted, derived through the BFO hierarchy (history is below process, below occurrent)
      expect(await reasoner.isEntailed(store, quad(obo("BFO_0000002"), DISJOINT, obo("BFO_0000182")))).toBe(true);

      // a batch over the BFO classes of the ontology: every unordered pair
      const bfo = [...new Set(base.filter((q) => q.predicate.value === RDF_TYPE && q.object.value === "http://www.w3.org/2002/07/owl#Class" && q.subject.value.includes("/BFO_")).map((q) => q.subject.value))].slice(0, 45);
      const axioms = bfo.flatMap((a, i) => bfo.slice(i + 1).map((b) => quad(n(a), DISJOINT, n(b))));
      let t = performance.now();
      const results = await reasoner.isEntailed(store, axioms);
      const entailed = results.filter((r) => r === true).length;
      console.log(`[roundtrip] isEntailed batch: ${axioms.length} disjointWith axioms in ${secs(t)}; entailed=${entailed}, not=${results.filter((r) => r === false).length}, null=${results.filter((r) => r === null).length}`);
      expect(results.every((r) => r === true || r === false)).toBe(true);
      expect(entailed).toBeGreaterThan(0);
      expect(entailed).toBeLessThan(axioms.length);

      // independent oracle: an individual typed with both classes is inconsistent exactly when the pair is disjoint (satisfiable classes)
      const picks = [...results.keys()].filter((i) => results[i] === true).slice(0, 6).concat([...results.keys()].filter((i) => results[i] === false).slice(0, 6));
      let agree = 0;
      for (const i of picks) {
        const x = n(`http://ex.org/oracle-${i}`);
        const probe = new Store([...base, quad(x, n(RDF_TYPE), axioms[i].subject as never), quad(x, n(RDF_TYPE), axioms[i].object as never)]);
        const inconsistent = !(await reasoner.checkConsistency(probe));
        if (inconsistent === (results[i] === true)) agree++;
        else console.log(`[roundtrip] DISAGREE on ${axioms[i].subject.value} / ${axioms[i].object.value}: isEntailed=${results[i]} but individual-typed-in-both inconsistent=${inconsistent}`);
      }
      console.log(`[roundtrip] independent oracle agrees on ${agree} of ${picks.length} sampled pairs`);
      expect(agree).toBe(picks.length);
    },
    900_000,
  );
});
