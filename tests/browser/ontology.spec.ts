/**
 * Browser worker integration tests — real ontology fixtures.
 *
 * Mirrors the Node.js integration tests (pizza, lubm, galen, roberts-family)
 * but runs the full pipeline inside a real Chromium browser worker via Playwright.
 * Fixtures are fetched from the Vite dev server at /tests/fixtures/*.nt.
 *
 * Prerequisites:
 *   npm run build && npm run patch-wasm   (dist/ must exist)
 *   npx playwright install chromium       (browser binary must exist)
 */

import { test, expect } from "@playwright/test";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

test.beforeEach(async ({ page }) => {
  page.on("console", (msg) => {
    if (msg.type() === "error") console.log(`[browser:${msg.type()}]`, msg.text());
  });
  page.on("pageerror", (err) => console.log("[browser:pageerror]", err.message));

  await page.goto("/tests/browser/index.html");
  await page.waitForFunction(() => typeof (window as any).RdfReasoner !== "undefined", {
    timeout: 20_000,
  });
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

type Triple = { s: string; p: string; o: string };
const RDFS_SUB = "http://www.w3.org/2000/01/rdf-schema#subClassOf";

function hasSub(triples: Triple[], sub: string, sup: string): boolean {
  return triples.some((t) => t.s === sub && t.p === RDFS_SUB && t.o === sup);
}

/** Fetch a fixture, parse it, run reason(), return inferred triples. */
async function classifyFixture(page: any, fixture: string): Promise<{ count: number; triples: Triple[] }> {
  return page.evaluate(async (fixturePath: string) => {
    const { RdfReasoner, INFERRED_GRAPH_IRI, Store, Parser, DataFactory } = window;

    const text = await fetch(fixturePath).then((r) => r.text());

    const store = new Store();
    await new Promise<void>((resolve, reject) => {
      const parser = new Parser({ format: "N-Triples" });
      parser.parse(text, (err: Error | null, quad: any) => {
        if (err) { reject(err); return; }
        if (quad) store.addQuad(quad);
        else resolve();
      });
    });

    const reasoner = new RdfReasoner();
    await reasoner.ready;
    await reasoner.reason(store);
    reasoner.terminate();

    const inferredGraph = DataFactory.namedNode(INFERRED_GRAPH_IRI);
    const quads = store.getQuads(null, null, null, inferredGraph);
    return {
      count: quads.length,
      triples: quads.map((q: any) => ({ s: q.subject.value, p: q.predicate.value, o: q.object.value })),
    };
  }, fixture);
}

// ---------------------------------------------------------------------------
// Pizza (2.4 KB)
// ---------------------------------------------------------------------------

test("pizza ontology: browser worker classifies same as Node.js", async ({ page }) => {
  const result = await classifyFixture(page, "/tests/fixtures/pizza.nt");

  expect(result.count).toBeGreaterThan(0);

  const px = "http://example.org/pizza#";
  expect(hasSub(result.triples, px + "VegetarianPizza", px + "Pizza")).toBe(true);
  expect(hasSub(result.triples, px + "MeatyPizza",      px + "Pizza")).toBe(true);
  expect(hasSub(result.triples, px + "IceCream",        px + "Food")).toBe(true);
});

// ---------------------------------------------------------------------------
// LUBM (47 KB)
// ---------------------------------------------------------------------------

test("lubm ontology: browser worker classifies same as Node.js", async ({ page }) => {
  test.setTimeout(120_000);

  const result = await classifyFixture(page, "/tests/fixtures/lubm.nt");

  expect(result.count).toBeGreaterThan(0);

  const lubm = "http://www.lehigh.edu/~zhp2/2004/0401/univ-bench.owl#";
  expect(hasSub(result.triples, lubm + "Article",            lubm + "Publication")).toBe(true);
  expect(hasSub(result.triples, lubm + "AssistantProfessor", lubm + "Professor")).toBe(true);
  expect(hasSub(result.triples, lubm + "AssociateProfessor", lubm + "Professor")).toBe(true);
});

// ---------------------------------------------------------------------------
// Galen (3.9 MB)
// ---------------------------------------------------------------------------

test("galen ontology: browser worker classifies same as Node.js", async ({ page }) => {
  test.setTimeout(300_000);

  const result = await classifyFixture(page, "/tests/fixtures/galen.nt");

  expect(result.count).toBeGreaterThan(0);

  const g = "http://ex.test/galen#";
  expect(hasSub(result.triples, g + "Abdomen", g + "NAMEDTrunkBodyPart")).toBe(true);
});

// ---------------------------------------------------------------------------
// Roberts family (614 KB)
// ---------------------------------------------------------------------------

test("roberts-family ontology: browser worker classifies same as Node.js", async ({ page }) => {
  test.setTimeout(300_000);

  const result = await classifyFixture(page, "/tests/fixtures/roberts-family.nt");

  expect(result.count).toBeGreaterThan(0);

  const r = "http://www.co-ode.org/roberts/family-tree.owl#";
  expect(hasSub(result.triples, r + "Ancestor",         r + "BloodRelation")).toBe(true);
  expect(hasSub(result.triples, r + "AncestorOfRobert", r + "Ancestor")).toBe(true);
});
