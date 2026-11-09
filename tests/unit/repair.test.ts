import { describe, it, expect } from "vitest";
import { Store, DataFactory } from "n3";
import type { Quad } from "@rdfjs/types";
import { computeRepairs, type RepairOracle } from "../../ts/repair.js";
import { minimalHittingSets } from "../../ts/hittingSets.js";
import { quadKey } from "../../ts/axiomGrouping.js";
import { ReasonerStalledError } from "../../ts/types.js";

const { namedNode: n, quad } = DataFactory;
const EX = "http://ex.org/";
const subClassOf = n("http://www.w3.org/2000/01/rdf-schema#subClassOf");
const ax = (i: number) => quad(n(`${EX}s${i}`), subClassOf, n(`${EX}o${i}`));
const ignore = new Set(["urn:konclude:inferred"]);

/** Fake ontology: inconsistent iff some clash set (indices of axioms) is fully present. */
function fakeOracle(clashes: number[][], hooks?: { explainThrows?: boolean; abortAfter?: number }): RepairOracle & { checks: number; explains: number } {
  let checks = 0;
  let explains = 0;
  const keys = (qs: Quad[]) => new Set(qs.map(quadKey));
  const present = (qs: Quad[], c: number[]) => c.every(i => keys(qs).has(quadKey(ax(i))));
  return {
    get checks() { return checks; },
    get explains() { return explains; },
    async inconsistent(qs) {
      checks++;
      if (hooks?.abortAfter !== undefined && checks > hooks.abortAfter) return "aborted";
      return clashes.some(c => present(qs, c));
    },
    async explain(qs, max) {
      explains++;
      if (hooks?.explainThrows) throw new Error("memory access out of bounds");
      return clashes.filter(c => present(qs, c)).slice(0, max).map(c => c.map(ax));
    },
  };
}

function setup(clashes: number[][], universe = 8) {
  const base = Array.from({ length: universe }, (_, i) => ax(i));
  return { store: new Store(base), base, clashes };
}
const idx = (q: Quad) => Number(q.subject.value.slice(`${EX}s`.length));
const removedIdx = (r: { remove: { principal: Quad }[] }) => r.remove.map(a => idx(a.principal)).sort();

describe("minimalHittingSets", () => {
  it("returns the shared element and the cross products, smallest first", () => {
    const hs = minimalHittingSets([["a", "b", "c"], ["a", "d"]]).map(h => h.sort().join("")).sort();
    expect(hs).toEqual(["a", "bd", "cd"]);
  });
  it("needs one element per disjoint set", () => {
    expect(minimalHittingSets([["a"], ["b"]]).map(h => h.sort())).toEqual([["a", "b"]]);
  });
  it("empty family has the empty hitting set", () => {
    expect(minimalHittingSets([])).toEqual([[]]);
  });
});

describe("computeRepairs", () => {
  const run = (clashes: number[][], opts?: Parameters<typeof computeRepairs>[0]["opts"], hooks?: Parameters<typeof fakeOracle>[1], universe?: number) => {
    const s = setup(clashes, universe);
    const oracle = fakeOracle(clashes, hooks);
    return computeRepairs({ store: s.store, base: s.base, graphsToIgnore: ignore, oracle, opts, deadline: Infinity }).then(r => ({ r, oracle }));
  };

  it("consistent input yields no repairs", async () => {
    const { r } = await run([]);
    expect(r).toMatchObject({ consistent: true, repairs: [], justifications: [], incomplete: false });
  });

  it("overlapping clashes collapse to the single shared axiom first, verified and minimal", async () => {
    const { r } = await run([[0, 1, 2], [0, 3]]);
    expect(r.incomplete).toBe(false);
    expect(removedIdx(r.repairs[0])).toEqual([0]);
    expect(r.repairs[0]).toMatchObject({ verifiedConsistent: true, minimal: true });
    expect(r.repairs[0].covers).toEqual([0, 1]);
    // the alternatives are complete repairs too
    expect(r.repairs.map(removedIdx).map(x => x.join(",")).sort()).toEqual(["0", "1,3", "2,3"]);
  });

  it("two independent clashes need two removals; each single axiom is not enough", async () => {
    const { r } = await run([[0, 1], [2, 3]]);
    expect(r.repairs.every(x => x.remove.length === 2)).toBe(true);
    expect(r.repairs.every(x => x.verifiedConsistent === true)).toBe(true);
  });

  it("refines when a candidate still fails: maxJustifications 1 finds the rest lazily", async () => {
    const { r, oracle } = await run([[0, 1], [2, 3], [4, 5]], { maxJustifications: 1 });
    expect(r.incomplete).toBe(false);
    expect(r.justifications).toHaveLength(3);
    expect(r.repairs.every(x => x.remove.length === 3 && x.verifiedConsistent)).toBe(true);
    expect(oracle.explains).toBeGreaterThanOrEqual(3);
  });

  it("orders by the cost function, then size", async () => {
    // prefer removing axiom 3 over axiom 0
    const { r } = await run([[0, 3]], { cost: a => (idx(a.principal) === 3 ? 0 : 5) });
    expect(removedIdx(r.repairs[0])).toEqual([3]);
  });

  it("verify:false reports unverified repairs without extra checks", async () => {
    const { r, oracle } = await run([[0, 1]], { verify: false });
    expect(r.repairs[0]).toMatchObject({ verifiedConsistent: null, minimal: null });
    expect(oracle.checks).toBe(1); // only the initial consistency check
  });

  it("stops at maxRepairs with reason solution-cap", async () => {
    const { r } = await run([[0, 1, 2], [0, 3]], { maxRepairs: 1 });
    expect(r.repairs).toHaveLength(1);
    expect(r).toMatchObject({ incomplete: true, reason: "solution-cap" });
  });

  it("returns incomplete with reason round-cap when refinement never converges within the cap", async () => {
    const { r } = await run([[0, 1], [2, 3], [4, 5]], { maxJustifications: 1, maxRounds: 1 });
    expect(r).toMatchObject({ incomplete: true, reason: "round-cap" });
  });

  it("a trap in explain becomes explain-failed, not an exception", async () => {
    const { r } = await run([[0, 1]], undefined, { explainThrows: true });
    expect(r).toMatchObject({ incomplete: true, reason: "explain-failed", repairs: [] });
  });

  it("a deadline during verification returns what was found with reason deadline", async () => {
    const { r } = await run([[0, 1, 2], [0, 3]], undefined, { abortAfter: 2 });
    expect(r.incomplete).toBe(true);
    expect(r.reason).toBe("deadline");
    expect(r.repairs[0]).toMatchObject({ verifiedConsistent: true });
  });

  it("does not swallow kernel stalls", async () => {
    const s = setup([[0, 1]]);
    const oracle: RepairOracle = {
      inconsistent: async () => true,
      explain: async () => { throw new ReasonerStalledError("kernel", 0); },
    };
    await expect(computeRepairs({ store: s.store, base: s.base, graphsToIgnore: ignore, oracle, deadline: Infinity })).rejects.toBeInstanceOf(ReasonerStalledError);
  });
});
