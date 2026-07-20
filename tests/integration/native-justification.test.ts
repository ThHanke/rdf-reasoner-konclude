/**
 * Integration test: native dep-chain justification (Phase 2 cache)
 *
 * Tests the O(1) justification fast-path that intercepts dep chain data
 * during classification and returns it via getSubClassJustification().
 *
 * These tests require the built WASM binary (`dist/konclude.wasm`).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";

import { RdfReasoner } from "../../ts/index.js";
import { loadFixture } from "../helpers/fixture.js";

const wasmPath = new URL("../../dist/konclude.wasm", import.meta.url).pathname;
const wasmExists = existsSync(wasmPath);

const ROBERTS = "http://www.co-ode.org/roberts/family-tree.owl#";

describe.skipIf(!wasmExists)("Native justification integration", () => {
  let reasoner: RdfReasoner;

  beforeAll(async () => {
    reasoner = new RdfReasoner();
    await reasoner.ready;
    await reasoner.classify(loadFixture("roberts-family.nt"));
  }, 360000);

  afterAll(() => {
    reasoner?.terminate();
  });

  it("direct subsumption returns NTriples justification", async () => {
    const r = reasoner as any;
    const has = await r._call("hasNativeJustification", [
      `${ROBERTS}Father`, `${ROBERTS}Parent`,
    ]);
    expect(has).toBe(true);

    const ntriples = (await r._call("getSubClassJustification", [
      `${ROBERTS}Father`, `${ROBERTS}Parent`,
    ])) as string;
    expect(ntriples).toContain("Father");
    expect(ntriples).toContain("Parent");
    expect(ntriples).toContain("subClassOf");
  }, 60000);

  it("transitive subsumption returns justification via taxonomy BFS", async () => {
    const r = reasoner as any;
    const ntriples = (await r._call("getSubClassJustification", [
      `${ROBERTS}Father`, `${ROBERTS}Person`,
    ])) as string;
    expect(ntriples.length).toBeGreaterThan(0);
    expect(ntriples).toContain("subClassOf");
  }, 60000);

  it("non-entailed subsumption returns empty", async () => {
    const r = reasoner as any;
    const ntriples = (await r._call("getSubClassJustification", [
      `${ROBERTS}Father`, `${ROBERTS}GrandParent`,
    ])) as string;
    expect(ntriples).toBe("");
  }, 60000);

  it("hasNativeJustification returns false for non-entailed", async () => {
    const r = reasoner as any;
    const has = await r._call("hasNativeJustification", [
      `${ROBERTS}Father`, `${ROBERTS}GrandParent`,
    ]);
    expect(has).toBe(false);
  }, 60000);
});
