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
});
