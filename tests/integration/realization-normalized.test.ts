/**
 * Integration test: realization on two ROBOT-normalized W3C premises (SymmetricProperty-002, TransitiveProperty-002;
 * fixtures converted from the normalized RDF/XML). A named class {a, b} with self loops makes the backend-cache neighbour
 * expansion for nominals recurse about 3,400 frames deep (natively it needs more than 256 KiB of stack). The WebAssembly
 * pthreads had the Emscripten default of 64 KiB, the stack silently overflowed into the heap (ASSERTIONS=0, no stack check) and
 * the pipeline stalled: materialize never returned. Fixed by -sSTACK_SIZE / -sDEFAULT_PTHREAD_STACK_SIZE = 2 MiB (emscripten.cmake).
 * This test guards both: materialize completes, and a stalled call would still be rejected by the watchdog (short stallTimeoutMs).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { Parser, Store } from "n3";

import { RdfReasoner } from "../../ts/index.js";

const wasmExists = existsSync(new URL("../../dist/konclude.wasm", import.meta.url).pathname);
const load = (f: string) => new Store(new Parser({ format: "N-Triples" }).parse(readFileSync(new URL(`../fixtures/pr18/${f}`, import.meta.url), "utf8")));

describe.skipIf(!wasmExists)("realization on normalized premises with deep nominal recursion", () => {
  let reasoner: RdfReasoner;
  beforeAll(async () => {
    reasoner = new RdfReasoner({ stallTimeoutMs: 15_000 });
    await reasoner.ready;
  }, 60_000);
  afterAll(() => reasoner?.terminate());

  for (const f of ["SymmetricProperty-002.normalized.nt", "TransitiveProperty-002.normalized.nt"]) {
    it(`${f}: consistency, materialize and classify all complete`, async () => {
      expect(await reasoner.checkConsistency(load(f))).toBe(true);
      const store = load(f);
      await reasoner.materialize(store); // used to make no progress (stack overflow)
      await reasoner.classify(load(f));
      expect(await reasoner.checkConsistency(store)).toBe(true);
    }, 60_000);
  }

  it("repeated realization in one reasoner keeps working", async () => {
    for (let i = 0; i < 5; i++) await reasoner.materialize(load("SymmetricProperty-002.normalized.nt"));
    expect(await reasoner.checkConsistency(load("TransitiveProperty-002.normalized.nt"))).toBe(true);
  }, 120_000);
});
