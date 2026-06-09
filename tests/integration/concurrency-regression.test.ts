/**
 * Regression tests for WASM singleton thread concurrency bugs.
 *
 * Each test here captures a specific sequential/concurrent call pattern that
 * previously caused hangs or stale state.  Keep these tests as narrow and
 * targeted as possible so failures point directly at the regression.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { Store } from "n3";

import { RdfReasoner } from "../../ts/index.js";
import { loadFixture } from "../helpers/fixture.js";

const wasmPath = new URL("../../dist/konclude.wasm", import.meta.url).pathname;
const wasmExists = existsSync(wasmPath);

describe.skipIf(!wasmExists)("concurrency regressions", () => {
  let reasoner: RdfReasoner;

  beforeAll(async () => {
    reasoner = new RdfReasoner();
    await reasoner.ready;
  });

  afterAll(() => {
    reasoner?.terminate();
  });

  // Regression: STPU stale semaphore caused validate() → checkConsistency()
  // sequential calls to hang.  Fixed by draining the semaphore in
  // startProcessing() (patch-007, mCurrRunningTestParallelCount reset).
  it("validate + classify sequential → no queue stall", async () => {
    const quads = loadFixture("inconsistent.nt");
    const store = new Store(quads);
    await reasoner.validate(store);
    const consistent = await reasoner.checkConsistency(store);
    expect(typeof consistent).toBe("boolean");
  }, 360000);
});
