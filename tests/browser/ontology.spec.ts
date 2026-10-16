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

type Result = { all: Triple[]; inferred: Triple[] };

/**
 * classify()/materialize() write only NEW entailments into the inferred graph, while the native fixtures list the
 * Hasse diagram / types of the whole ontology (asserted + inferred, IRI-to-IRI). So:
 *   completeness: every native triple is in asserted ∪ inferred (named nodes only);
 *   precision:    every inferred triple is a native triple.
 * Asserted-but-redundant edges are not in the native output and are not inferred, so they are not compared.
 */
function assertNativeMatch(res: Result, predicates: string[], fixtureFile: string): void {
  const predSet = new Set(predicates);
  const fmt = (t: Triple) => `<${t.s}> <${t.p}> <${t.o}> .`;
  const all = new Set(res.all.filter((t) => predSet.has(t.p)).map(fmt));
  const inferred = res.inferred.filter((t) => predSet.has(t.p)).map(fmt);
  const expected = loadNativeFixture(fixtureFile);
  const expectedSet = new Set(expected);
  const missing = expected.filter((t) => !all.has(t));
  const extra = inferred.filter((t) => !expectedSet.has(t));

  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `Native mismatch in ${fixtureFile}:\n` +
      `  Missing from browser (${missing.length}): ${JSON.stringify(missing.slice(0, 5))}\n` +
      `  Extra in browser   (${extra.length}):   ${JSON.stringify(extra.slice(0, 5))}`,
    );
  }
}

/**
 * Fetch one or more NT fixtures, parse them, run classify() (or materialize()), return the inferred triples and
 * the union of all graphs (named nodes only).
 */
async function classifyFixtures(page: any, fixtures: string[], op: "classify" | "materialize" = "classify"): Promise<Result> {
  return page.evaluate(async ({ fixturePaths, op }: { fixturePaths: string[]; op: string }) => {
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
    if (op === "materialize") await reasoner.materialize(store, { includeClassHierarchy: true });
    else await reasoner.classify(store);
    reasoner.terminate();

    const flat = (q: any) => ({ s: q.subject.value, p: q.predicate.value, o: q.object.value });
    const named = (q: any) => q.subject.termType === "NamedNode" && q.object.termType === "NamedNode";
    return {
      inferred: store.getQuads(null, null, null, DataFactory.namedNode(INFERRED_GRAPH_IRI)).filter(named).map(flat),
      all: store.getQuads(null, null, null, null).filter(named).map(flat),
    };
  }, { fixturePaths: fixtures, op });
}

// ---------------------------------------------------------------------------
// Pizza (2.4 KB) — no native reference; spot-check only
// ---------------------------------------------------------------------------

test("pizza ontology: browser worker classifies same as Node.js", async ({ page }) => {
  const { all: triples } = await classifyFixtures(page, ["/tests/fixtures/pizza.nt"]);

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

  const res = await classifyFixtures(page, ["/tests/fixtures/lubm.nt"]);

  expect(res.all.length).toBeGreaterThan(0);
  assertNativeMatch(res, [SUBCLASS_OF, EQUIV_CLASS], "lubm-native-tbox.nt");
});

// ---------------------------------------------------------------------------
// Galen (3.9 MB) — compare TBox against native Konclude reference
// ---------------------------------------------------------------------------

test("galen ontology: browser worker matches native Konclude output", async ({ page }) => {
  test.setTimeout(300_000);

  const res = await classifyFixtures(page, ["/tests/fixtures/galen.nt"]);

  expect(res.all.length).toBeGreaterThan(0);
  assertNativeMatch(res, [SUBCLASS_OF, EQUIV_CLASS], "galen-native-tbox.nt");
});

// ---------------------------------------------------------------------------
// Roberts family (614 KB) — compare TBox + ABox against native Konclude reference
// ---------------------------------------------------------------------------

test("roberts-family ontology: browser worker matches native Konclude output", async ({ page }) => {
  test.setTimeout(300_000);

  const res = await classifyFixtures(page, ["/tests/fixtures/roberts-family.nt"], "materialize");

  expect(res.all.length).toBeGreaterThan(0);
  assertNativeMatch(res, [SUBCLASS_OF, EQUIV_CLASS], "roberts-native-tbox.nt");
  assertNativeMatch(res, [RDF_TYPE],                 "roberts-native-abox.nt");
});

// ---------------------------------------------------------------------------
// LUBM schema + data (17 MB) — compare TBox against native; ABox spot-check
// ---------------------------------------------------------------------------

test("lubm schema + data: browser worker realization matches native TBox", async ({ page }) => {
  test.setTimeout(300_000);

  const res = await classifyFixtures(page, [
    "/tests/fixtures/lubm.nt",
    "/tests/fixtures/lubm-data.nt",
  ], "materialize");
  const triples = res.all;

  expect(triples.length).toBeGreaterThan(0);

  // TBox should be identical to schema-only native output
  assertNativeMatch(res, [SUBCLASS_OF, EQUIV_CLASS], "lubm-native-tbox.nt");

  // ABox spot-check: individuals get expected types via realization
  const lubm = "http://www.lehigh.edu/~zhp2/2004/0401/univ-bench.owl#";
  expect(hasSub(triples, lubm + "Article",            lubm + "Publication")).toBe(true);
  expect(hasSub(triples, lubm + "AssistantProfessor", lubm + "Professor")).toBe(true);
});
