/**
 * Browser worker integration tests — real ontology fixtures.
 *
 * Mirrors the Node.js integration tests (pizza, lubm, galen, roberts-family)
 * but runs the full pipeline inside a real Chromium browser worker via Playwright.
 * Fixtures are fetched from the Vite dev server at /tests/fixtures/*.nt.
 * Where native Konclude reference fixtures exist, results are compared by set equality.
 *
 * Prerequisites:
 *   npm run build && npm run patch-wasm   (dist/ must exist)
 *   npx playwright install chromium       (browser binary must exist)
 */

import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

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
// Helpers
// ---------------------------------------------------------------------------

const SUBCLASS_OF    = "http://www.w3.org/2000/01/rdf-schema#subClassOf";
const EQUIV_CLASS    = "http://www.w3.org/2002/07/owl#equivalentClass";
const RDF_TYPE       = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

type Triple = { s: string; p: string; o: string };

function hasSub(triples: Triple[], sub: string, sup: string): boolean {
  return triples.some((t) => t.s === sub && t.p === SUBCLASS_OF && t.o === sup);
}

function loadNativeFixture(file: string): string[] {
  const raw = readFileSync(join(__dirname, "../fixtures", file), "utf8");
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
}

function assertNativeMatch(triples: Triple[], predicates: string[], fixtureFile: string): void {
  const predSet = new Set(predicates);
  const actual = triples
    .filter((t) => predSet.has(t.p))
    .map((t) => `<${t.s}> <${t.p}> <${t.o}> .`)
    .sort();
  const expected = loadNativeFixture(fixtureFile).sort();

  const actualSet   = new Set(actual);
  const expectedSet = new Set(expected);
  const missing = expected.filter((t) => !actualSet.has(t));
  const extra   = actual.filter((t)   => !expectedSet.has(t));

  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `Native mismatch in ${fixtureFile}:\n` +
      `  Missing from browser (${missing.length}): ${JSON.stringify(missing.slice(0, 5))}\n` +
      `  Extra in browser   (${extra.length}):   ${JSON.stringify(extra.slice(0, 5))}`,
    );
  }

  expect(actual).toEqual(expected);
}

/**
 * Fetch one or more NT fixtures, parse them, run reason(), return all inferred triples.
 */
async function classifyFixtures(page: any, fixtures: string[]): Promise<Triple[]> {
  return page.evaluate(async (fixturePaths: string[]) => {
    const { RdfReasoner, INFERRED_GRAPH_IRI, Store, Parser, DataFactory } = window;

    const store = new Store();
    for (const path of fixturePaths) {
      const text = await fetch(path).then((r) => r.text());
      await new Promise<void>((resolve, reject) => {
        new Parser({ format: "N-Triples" }).parse(text, (err: Error | null, quad: any) => {
          if (err) { reject(err); return; }
          if (quad) store.addQuad(quad);
          else resolve();
        });
      });
    }

    const reasoner = new RdfReasoner();
    await reasoner.ready;
    await reasoner.reason(store);
    reasoner.terminate();

    const inferredGraph = DataFactory.namedNode(INFERRED_GRAPH_IRI);
    return store
      .getQuads(null, null, null, inferredGraph)
      .map((q: any) => ({ s: q.subject.value, p: q.predicate.value, o: q.object.value }));
  }, fixtures);
}

// ---------------------------------------------------------------------------
// Pizza (2.4 KB) — no native reference; spot-check only
// ---------------------------------------------------------------------------

test("pizza ontology: browser worker classifies same as Node.js", async ({ page }) => {
  const triples = await classifyFixtures(page, ["/tests/fixtures/pizza.nt"]);

  expect(triples.length).toBeGreaterThan(0);

  const px = "http://example.org/pizza#";
  expect(hasSub(triples, px + "VegetarianPizza", px + "Pizza")).toBe(true);
  expect(hasSub(triples, px + "MeatyPizza",      px + "Pizza")).toBe(true);
  expect(hasSub(triples, px + "IceCream",        px + "Food")).toBe(true);
});

// ---------------------------------------------------------------------------
// LUBM (47 KB) — compare TBox against native Konclude reference
// ---------------------------------------------------------------------------

test("lubm ontology: browser worker matches native Konclude output", async ({ page }) => {
  test.setTimeout(120_000);

  const triples = await classifyFixtures(page, ["/tests/fixtures/lubm.nt"]);

  expect(triples.length).toBeGreaterThan(0);
  assertNativeMatch(triples, [SUBCLASS_OF, EQUIV_CLASS], "lubm-native-tbox.nt");
});

// ---------------------------------------------------------------------------
// Galen (3.9 MB) — compare TBox against native Konclude reference
// ---------------------------------------------------------------------------

test("galen ontology: browser worker matches native Konclude output", async ({ page }) => {
  test.setTimeout(300_000);

  const triples = await classifyFixtures(page, ["/tests/fixtures/galen.nt"]);

  expect(triples.length).toBeGreaterThan(0);
  assertNativeMatch(triples, [SUBCLASS_OF, EQUIV_CLASS], "galen-native-tbox.nt");
});

// ---------------------------------------------------------------------------
// Roberts family (614 KB) — compare TBox + ABox against native Konclude reference
// ---------------------------------------------------------------------------

test("roberts-family ontology: browser worker matches native Konclude output", async ({ page }) => {
  test.setTimeout(300_000);

  const triples = await classifyFixtures(page, ["/tests/fixtures/roberts-family.nt"]);

  expect(triples.length).toBeGreaterThan(0);
  assertNativeMatch(triples, [SUBCLASS_OF, EQUIV_CLASS], "roberts-native-tbox.nt");
  assertNativeMatch(triples, [RDF_TYPE],                 "roberts-native-abox.nt");
});

// ---------------------------------------------------------------------------
// LUBM schema + data (17 MB) — compare TBox against native; ABox spot-check
// ---------------------------------------------------------------------------

test("lubm schema + data: browser worker realization matches native TBox", async ({ page }) => {
  test.setTimeout(300_000);

  const triples = await classifyFixtures(page, [
    "/tests/fixtures/lubm.nt",
    "/tests/fixtures/lubm-data.nt",
  ]);

  expect(triples.length).toBeGreaterThan(0);

  // TBox should be identical to schema-only native output
  assertNativeMatch(triples, [SUBCLASS_OF, EQUIV_CLASS], "lubm-native-tbox.nt");

  // ABox spot-check: individuals get expected types via realization
  const lubm = "http://www.lehigh.edu/~zhp2/2004/0401/univ-bench.owl#";
  expect(hasSub(triples, lubm + "Article",            lubm + "Publication")).toBe(true);
  expect(hasSub(triples, lubm + "AssistantProfessor", lubm + "Professor")).toBe(true);
});
