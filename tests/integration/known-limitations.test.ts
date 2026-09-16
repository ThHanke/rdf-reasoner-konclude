/**
 * Documents known gaps between WASM Konclude and OWL 2 DL semantics.
 *
 * Tests here use it.skip to keep them visible without polluting the passing
 * suite.  Each skip has a label that matches a plan/issue for tracking.
 */

import { describe, it } from "vitest";
import { existsSync } from "node:fs";

const wasmPath = new URL("../../dist/konclude.wasm", import.meta.url).pathname;
const wasmExists = existsSync(wasmPath);

// All previously tracked gaps have been resolved:
//   - ALIF+ FP+IFP 1-filler hang    → fixed by patches 020-021 (tests: alif-hang-minimal.test.ts)
//   - minCardinality ABox realization → fixed (tests: owl2dl-parity.test.ts)
//   - owl:oneOf ABox realization      → fixed (tests: owl2dl-parity.test.ts)
//   - hasSelf + propertyDisjointWith  → fixed by patch-022 (tests: issue13-owl-violations.test.ts)
//   - R7a/R7b materialize hang        → fixed by patch-030 (tests: owl2dl-parity.test.ts)

// No active known limitations. Add new it.skip blocks here as gaps are discovered.
describe("known-limitations: registry", () => {
  it.skip("placeholder — remove when a new gap is added", () => {
    void wasmExists;
  });
});
