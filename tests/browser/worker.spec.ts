/**
 * Real browser worker integration tests.
 *
 * Runs the actual WASM reasoning kernel inside Chromium via Playwright.
 * Tests use n3.Store / n3.Parser / n3.DataFactory exactly as a browser
 * application would — no binary protocol, no mocked WASM.
 *
 * Primary goals:
 *   1. COOP/COEP headers are present → window.crossOriginIsolated === true
 *      → SharedArrayBuffer available → pthreads initialise.
 *   2. RdfReasoner.reason(store) pipeline works end-to-end in a real browser
 *      worker (would have deadlocked under the pre-plan-016 single-thread bug).
 *   3. Consistency check via checkConsistency(store) returns the correct boolean.
 *
 * Prerequisites:
 *   npm run build && npm run patch-wasm   (dist/ must exist)
 *   npx playwright install chromium       (browser binary must exist)
 */

import { test, expect } from "@playwright/test";

// ---------------------------------------------------------------------------
// Setup: navigate to the test harness page and wait for modules to load.
// ---------------------------------------------------------------------------

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/browser/index.html");
  // Wait until Vite finishes loading the entry module and RdfReasoner is
  // available on window.
  await page.waitForFunction(() => typeof (window as any).RdfReasoner !== "undefined", {
    timeout: 20_000,
  });
});

// ---------------------------------------------------------------------------
// Test 1: cross-origin isolation (prerequisite for SharedArrayBuffer)
// ---------------------------------------------------------------------------

test("SharedArrayBuffer is available — COOP/COEP headers correct", async ({
  page,
}) => {
  const isolated = await page.evaluate(() => window.crossOriginIsolated);
  expect(isolated).toBe(true);
});

// ---------------------------------------------------------------------------
// Test 2: reason(store) — subclass chain produces transitive inference
// ---------------------------------------------------------------------------

test("reason(store): A→B→C chain infers A→C via realization", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { RdfReasoner, INFERRED_GRAPH_IRI, DataFactory, Store } = window;
    const { namedNode, quad, defaultGraph } = DataFactory;

    const RDFS_SUB = namedNode(
      "http://www.w3.org/2000/01/rdf-schema#subClassOf",
    );
    const A = namedNode("http://example.org/A");
    const B = namedNode("http://example.org/B");
    const C = namedNode("http://example.org/C");

    const store = new Store();
    store.addQuad(quad(A, RDFS_SUB, B, defaultGraph()));
    store.addQuad(quad(B, RDFS_SUB, C, defaultGraph()));

    const reasoner = new RdfReasoner();
    await reasoner.ready;
    await reasoner.reason(store);
    reasoner.terminate();

    const inferredGraph = namedNode(INFERRED_GRAPH_IRI);
    return store
      .getQuads(null, null, null, inferredGraph)
      .map((q) => ({ s: q.subject.value, p: q.predicate.value, o: q.object.value }));
  });

  const RDFS_SUB = "http://www.w3.org/2000/01/rdf-schema#subClassOf";
  const transitiveClosure = result.some(
    (t) =>
      t.s === "http://example.org/A" &&
      t.p === RDFS_SUB &&
      t.o === "http://example.org/C",
  );

  expect(
    transitiveClosure,
    `Expected :A subClassOf :C in inferred triples.\nGot:\n${result.map((t) => `  <${t.s}> <${t.p}> <${t.o}>`).join("\n")}`,
  ).toBe(true);
});

// ---------------------------------------------------------------------------
// Test 3: checkConsistency(store) — trivially consistent ontology
// ---------------------------------------------------------------------------

test("checkConsistency(store): simple subclass chain is consistent", async ({
  page,
}) => {
  const consistent = await page.evaluate(async () => {
    const { RdfReasoner, DataFactory, Store } = window;
    const { namedNode, quad, defaultGraph } = DataFactory;

    const RDFS_SUB = namedNode(
      "http://www.w3.org/2000/01/rdf-schema#subClassOf",
    );
    const store = new Store();
    store.addQuad(
      quad(
        namedNode("http://example.org/A"),
        RDFS_SUB,
        namedNode("http://example.org/B"),
        defaultGraph(),
      ),
    );

    const reasoner = new RdfReasoner();
    await reasoner.ready;
    const result = await reasoner.checkConsistency(store);
    reasoner.terminate();
    return result;
  });

  expect(consistent).toBe(true);
});

// ---------------------------------------------------------------------------
// Test 4: reason(store) with Turtle parsed via n3.Parser
// ---------------------------------------------------------------------------

test("reason(store): parse Turtle via n3.Parser, run classification", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { RdfReasoner, INFERRED_GRAPH_IRI, DataFactory, Store, Parser } = window;
    const { namedNode } = DataFactory;

    const turtle = `
      @prefix ex: <http://example.org/> .
      @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
      ex:Mammal rdfs:subClassOf ex:Animal .
      ex:Dog    rdfs:subClassOf ex:Mammal .
      ex:Poodle rdfs:subClassOf ex:Dog .
    `;

    const store = new Store();
    await new Promise<void>((resolve, reject) => {
      const parser = new Parser({ format: "text/turtle" });
      parser.parse(turtle, (err, quad) => {
        if (err) { reject(err); return; }
        if (quad) store.addQuad(quad);
        else resolve();
      });
    });

    const reasoner = new RdfReasoner();
    await reasoner.ready;
    await reasoner.reason(store);
    reasoner.terminate();

    const inferredGraph = namedNode(INFERRED_GRAPH_IRI);
    return store
      .getQuads(null, null, null, inferredGraph)
      .map((q) => ({ s: q.subject.value, p: q.predicate.value, o: q.object.value }));
  });

  const RDFS_SUB = "http://www.w3.org/2000/01/rdf-schema#subClassOf";
  const ex = "http://example.org/";

  // Transitivity: Poodle → Animal
  expect(
    result.some(
      (t) => t.s === ex + "Poodle" && t.p === RDFS_SUB && t.o === ex + "Animal",
    ),
  ).toBe(true);

  // Transitivity: Dog → Animal
  expect(
    result.some(
      (t) => t.s === ex + "Dog" && t.p === RDFS_SUB && t.o === ex + "Animal",
    ),
  ).toBe(true);
});
