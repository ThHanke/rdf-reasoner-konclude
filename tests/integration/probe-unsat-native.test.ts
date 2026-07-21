/**
 * Integration test: unsatisfiability detection and justification.
 *
 * Verifies that:
 * 1. getUnsatisfiableClasses detects unsatisfiable classes
 * 2. explainEntailment(C, subClassOf, owl:Nothing) returns isEntailed=true
 * 3. validate() returns warnings with justification axioms
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { Store } from "n3";
import { RdfReasoner } from "../../ts/index.js";
import { loadFixture } from "../helpers/fixture.js";

const wasmPath = new URL("../../dist/konclude.wasm", import.meta.url).pathname;
const wasmExists = existsSync(wasmPath);

describe.skipIf(!wasmExists)("Unsatisfiability justification", () => {
  let reasoner: RdfReasoner;
  let store: Store;

  beforeAll(async () => {
    reasoner = new RdfReasoner();
    await reasoner.ready;

    const quads = loadFixture("unsatisfiable-class.nt");
    store = new Store();
    store.addQuads(quads);
  }, 30000);

  afterAll(() => {
    reasoner?.terminate();
  });

  it("getUnsatisfiableClasses finds A", async () => {
    const unsat = await reasoner.getUnsatisfiableClasses(store);
    expect(unsat).toContain("http://example.org/A");
  }, 30000);

  it("explainEntailment(A, subClassOf, Nothing) detects entailment", async () => {
    const explanation = await reasoner.explainEntailment(
      store,
      "http://example.org/A",
      "http://www.w3.org/2000/01/rdf-schema#subClassOf",
      "http://www.w3.org/2002/07/owl#Nothing",
    );
    expect(explanation.isEntailed).toBe(true);
  }, 60000);

  it("validate() returns warning with justification for unsatisfiable class", async () => {
    const result = await reasoner.validate(store, { maxJustificationsPerWarning: 1 });
    expect(result.consistent).toBe(true);
    expect(result.warnings.length).toBeGreaterThanOrEqual(1);
    const aWarning = result.warnings.find(w => w.classIRI === "http://example.org/A");
    expect(aWarning).toBeDefined();
    expect(aWarning!.justifications.length).toBe(1);
    expect(aWarning!.justifications[0].length).toBeGreaterThan(0);
  }, 60000);
});
