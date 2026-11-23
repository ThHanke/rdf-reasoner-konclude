/**
 * Integration test: W3C OWL 2 DL consistency verdicts for the constructs touched by PR #18.
 *
 * Table-driven from tests/fixtures/w3c-pr18/manifest.json:
 *   - status "pass":       the port must return the expected verdict (hasKey, bottom properties, disjoint data
 *                          properties, negative property assertions, OWL 1 boolean constructors as controls).
 *   - status "known-gap":  the port is known to return a WRONG verdict; the test asserts that recorded wrong verdict,
 *                          so fixing a gap (or regressing it further) fails here and forces a manifest update.
 *                          Reasons are in docs/solutions/capability-gaps/pr18-known-conformance-gaps-2026-11-23.md.
 *
 * All cases run in one shared reasoner, sequentially: this also guards the shared-Redland-world and use-after-free
 * fixes (a trap after many loads in one reasoner would fail every later case).
 * Fixtures: W3C approved test cases converted from RDF/XML to N-Triples (no extra parser dependency).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { Parser, Store } from "n3";

import { RdfReasoner } from "../../ts/index.js";

const wasmExists = existsSync(new URL("../../dist/konclude.wasm", import.meta.url).pathname);
const dir = new URL("../fixtures/w3c-pr18/", import.meta.url);

interface Entry {
  id: string;
  group: string;
  expected: "consistent" | "inconsistent";
  portVerdict: "consistent" | "inconsistent";
  status: "pass" | "known-gap";
}
const manifest: Entry[] = JSON.parse(readFileSync(new URL("manifest.json", dir), "utf8"));

describe.skipIf(!wasmExists)("W3C consistency verdicts (PR #18 constructs)", () => {
  let reasoner: RdfReasoner;
  beforeAll(async () => {
    reasoner = new RdfReasoner();
    await reasoner.ready;
  }, 60_000);
  afterAll(() => reasoner?.terminate());

  for (const e of manifest) {
    const want = e.status === "pass" ? e.expected : e.portVerdict;
    const label = e.status === "pass" ? `${e.expected}` : `KNOWN GAP: W3C expects ${e.expected}, port answers ${e.portVerdict}`;
    it(`[${e.group}] ${e.id}: ${label}`, async () => {
      const store = new Store(new Parser({ format: "N-Triples" }).parse(readFileSync(new URL(`${e.id}.nt`, dir), "utf8")));
      const consistent = await reasoner.checkConsistency(store);
      expect(consistent ? "consistent" : "inconsistent").toBe(want);
    }, 90_000);
  }
});
