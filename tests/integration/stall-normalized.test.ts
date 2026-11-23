/**
 * Integration test: known realization stall on two ROBOT-normalized W3C premises (SymmetricProperty-002,
 * TransitiveProperty-002; fixtures converted from the normalized RDF/XML). Consistency answers in about 0.3 s, but
 * realization (materialize) makes no progress: every kernel thread waits (diagnosis: docs/pr18-adoption-decisions.md, section 4).
 *
 * Not fixed. This test pins what IS guaranteed: the call does not hang forever, the idle watchdog rejects it with
 * ReasonerStalledError (the stall detector in C++ does not fire in this state), and the same reasoner works afterwards (the
 * worker is restarted). When the kernel stall is fixed, materialize completes and this test must be changed to expect that.
 * A native null-pointer crash on the first fixture was fixed (patch 002), but it did not remove the WebAssembly stall.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { Parser, Store } from "n3";

import { RdfReasoner, ReasonerStalledError } from "../../ts/index.js";

const wasmExists = existsSync(new URL("../../dist/konclude.wasm", import.meta.url).pathname);
const load = (f: string) => new Store(new Parser({ format: "N-Triples" }).parse(readFileSync(new URL(`../fixtures/pr18/${f}`, import.meta.url), "utf8")));

describe.skipIf(!wasmExists)("realization stall on normalized premises (known, detected, not fixed)", () => {
  let reasoner: RdfReasoner;
  beforeAll(async () => {
    reasoner = new RdfReasoner({ stallTimeoutMs: 6_000 });
    await reasoner.ready;
  }, 60_000);
  afterAll(() => reasoner?.terminate());

  for (const f of ["SymmetricProperty-002.normalized.nt", "TransitiveProperty-002.normalized.nt"]) {
    it(`${f}: consistency answers, materialize is rejected with ReasonerStalledError, the reasoner keeps working`, async () => {
      expect(await reasoner.checkConsistency(load(f))).toBe(true);
      await expect(reasoner.materialize(load(f))).rejects.toBeInstanceOf(ReasonerStalledError);
      expect(await reasoner.checkConsistency(load(f))).toBe(true);
    }, 120_000);
  }
});
