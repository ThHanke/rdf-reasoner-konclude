/**
 * Incremental reasoning test: cold/warm timing + TBox/ABox incremental updates.
 *
 * Uses the reasoning-demo fixture:
 * 1. Cold materialize (first call)
 * 2. Warm materialize (cache hit — same store content)
 * 3. Add TBox class with subclass relation → materialize again
 * 4. Add ABox individual with connections → materialize again
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { Store, DataFactory, Parser } from "n3";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Quad } from "@rdfjs/types";
import { RdfReasoner } from "../../ts/index.js";

const { namedNode, quad } = DataFactory;
const wasmPath = new URL("../../dist/konclude.wasm", import.meta.url).pathname;
const wasmExists = existsSync(wasmPath);
const __dirname = dirname(fileURLToPath(import.meta.url));

const INFERRED = "urn:konclude:inferred";
const EX = "http://example.com/reasoning-demo#";
const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const RDFS = "http://www.w3.org/2000/01/rdf-schema#";
const OWL = "http://www.w3.org/2002/07/owl#";

function loadStore(): Store {
  const raw = readFileSync(
    join(__dirname, "../fixtures/reasoning-demo.ttl"),
    "utf8",
  );
  const parser = new Parser();
  const quads = parser.parse(raw) as Quad[];
  const store = new Store();
  store.addQuads(quads);
  return store;
}

function inferredQuads(store: Store): Quad[] {
  return store.getQuads(null, null, null, namedNode(INFERRED));
}

function hasInferred(store: Store, s: string, p: string, o: string): boolean {
  return (
    store.getQuads(namedNode(s), namedNode(p), namedNode(o), namedNode(INFERRED))
      .length > 0
  );
}

describe.skipIf(!wasmExists)("Incremental reasoning", () => {
  let reasoner: RdfReasoner;

  beforeAll(async () => {
    reasoner = new RdfReasoner();
    await reasoner.ready;
  }, 30000);

  afterAll(() => {
    reasoner?.terminate();
  });

  it("cold → warm → TBox increment → ABox increment", async () => {
    const store = loadStore();
    const timings: Record<string, number> = {};

    function inputCount(): number {
      return store.size - inferredQuads(store).length;
    }

    const baseInputCount = store.size;
    expect(inferredQuads(store).length).toBe(0);

    // ── 1. Cold materialize ──
    const t0 = performance.now();
    await reasoner.materialize(store, { includeClassHierarchy: true });
    timings.cold = performance.now() - t0;

    const coldInferred = inferredQuads(store).length;
    const coldInput = inputCount();
    const coldTotal = store.size;
    expect(coldInferred).toBeGreaterThan(0);
    expect(coldInput).toBe(baseInputCount);
    expect(coldTotal).toBe(coldInput + coldInferred);

    // Sanity: existing inferences present
    expect(hasInferred(store, `${EX}alice`, `${RDF}type`, `${EX}Manager`)).toBe(
      true,
    );
    expect(
      hasInferred(store, `${EX}alice`, `${RDF}type`, `${EX}Employee`),
    ).toBe(true);

    // New class should NOT be inferred yet
    expect(
      hasInferred(store, `${EX}alice`, `${RDF}type`, `${EX}SeniorExec`),
    ).toBe(false);

    // ── 2. Warm materialize (same store, expect cache hit) ──
    const t1 = performance.now();
    await reasoner.materialize(store, { includeClassHierarchy: true });
    timings.warm = performance.now() - t1;

    const warmInferred = inferredQuads(store).length;
    const warmTotal = store.size;
    expect(warmInferred).toBe(coldInferred);
    expect(warmTotal).toBe(coldTotal);
    expect(inputCount()).toBe(coldInput);

    // ── 3. TBox increment: add ex:SeniorExec rdfs:subClassOf ex:Executive ──
    store.addQuad(
      quad(
        namedNode(`${EX}SeniorExec`),
        namedNode(`${RDF}type`),
        namedNode(`${OWL}Class`),
      ),
    );
    store.addQuad(
      quad(
        namedNode(`${EX}SeniorExec`),
        namedNode(`${RDFS}subClassOf`),
        namedNode(`${EX}Executive`),
      ),
    );
    const tboxInputAdded = 2;
    const tboxInputCount = coldInput + tboxInputAdded;
    expect(inputCount()).toBe(tboxInputCount);

    const t2 = performance.now();
    await reasoner.materialize(store, { includeClassHierarchy: true });
    timings.tboxIncrement = performance.now() - t2;

    const tboxInferred = inferredQuads(store).length;
    const tboxTotal = store.size;
    expect(inputCount()).toBe(tboxInputCount);
    expect(tboxTotal).toBe(tboxInputCount + tboxInferred);

    // New class should appear in hierarchy (direct: subClassOf Executive)
    expect(
      hasInferred(
        store,
        `${EX}SeniorExec`,
        `${RDFS}subClassOf`,
        `${EX}Executive`,
      ),
    ).toBe(true);

    // More inferred triples than before (new subclass chain)
    expect(tboxInferred).toBeGreaterThan(coldInferred);

    // ── 4. ABox increment: add ex:grace a ex:SeniorExec, connected to alice ──
    store.addQuad(
      quad(
        namedNode(`${EX}grace`),
        namedNode(`${RDF}type`),
        namedNode(`${OWL}NamedIndividual`),
      ),
    );
    store.addQuad(
      quad(
        namedNode(`${EX}grace`),
        namedNode(`${RDF}type`),
        namedNode(`${EX}SeniorExec`),
      ),
    );
    // grace manages bob → triggers domain(manages)=Manager inference
    store.addQuad(
      quad(
        namedNode(`${EX}grace`),
        namedNode(`${EX}manages`),
        namedNode(`${EX}bob`),
      ),
    );
    // grace works on projectAlpha → triggers ProjectContributor
    store.addQuad(
      quad(
        namedNode(`${EX}grace`),
        namedNode(`${EX}worksOn`),
        namedNode(`${EX}projectAlpha`),
      ),
    );
    const aboxInputAdded = 4;
    const aboxInputCount = tboxInputCount + aboxInputAdded;
    expect(inputCount()).toBe(aboxInputCount);

    const t3 = performance.now();
    await reasoner.materialize(store, { includeClassHierarchy: true });
    timings.aboxIncrement = performance.now() - t3;

    const aboxInferred = inferredQuads(store).length;
    const aboxTotal = store.size;
    expect(inputCount()).toBe(aboxInputCount);
    expect(aboxTotal).toBe(aboxInputCount + aboxInferred);

    // grace should inherit full chain: SeniorExec → Executive → Manager → Employee → Person
    expect(
      hasInferred(store, `${EX}grace`, `${RDF}type`, `${EX}Executive`),
    ).toBe(true);
    expect(
      hasInferred(store, `${EX}grace`, `${RDF}type`, `${EX}Manager`),
    ).toBe(true);
    expect(
      hasInferred(store, `${EX}grace`, `${RDF}type`, `${EX}Employee`),
    ).toBe(true);
    expect(
      hasInferred(store, `${EX}grace`, `${RDF}type`, `${EX}Person`),
    ).toBe(true);

    // grace worksOn projectAlpha → ProjectContributor
    expect(
      hasInferred(
        store,
        `${EX}grace`,
        `${RDF}type`,
        `${EX}ProjectContributor`,
      ),
    ).toBe(true);

    // bob isManagedBy grace (inverse of manages)
    expect(
      hasInferred(store, `${EX}bob`, `${EX}isManagedBy`, `${EX}grace`),
    ).toBe(true);

    // More inferred triples with new individual
    expect(aboxInferred).toBeGreaterThan(tboxInferred);

    // ── Monotonic growth: only adding, never removing ──
    expect(coldTotal).toBeGreaterThan(baseInputCount);
    expect(warmTotal).toBe(coldTotal);
    expect(tboxTotal).toBeGreaterThan(coldTotal);
    expect(aboxTotal).toBeGreaterThan(tboxTotal);

    // ── Accounting: total = input + inferred at every step ──
    console.log("\n══ Store triple accounting ══");
    console.log(`  Base input:         ${baseInputCount} triples`);
    console.log(`  After cold:         ${coldTotal} total = ${coldInput} input + ${coldInferred} inferred`);
    console.log(`  After warm:         ${warmTotal} total = ${coldInput} input + ${warmInferred} inferred (unchanged)`);
    console.log(`  After TBox (+${tboxInputAdded} input): ${tboxTotal} total = ${tboxInputCount} input + ${tboxInferred} inferred (+${tboxInferred - coldInferred} inf)`);
    console.log(`  After ABox (+${aboxInputAdded} input): ${aboxTotal} total = ${aboxInputCount} input + ${aboxInferred} inferred (+${aboxInferred - tboxInferred} inf)`);

    // ── Timing report ──
    console.log("\n══ Incremental reasoning timings ══");
    console.log(`  Cold materialize:   ${timings.cold.toFixed(0)} ms  (${coldInferred} inferred)`);
    console.log(`  Warm (cache hit):   ${timings.warm.toFixed(0)} ms  (${warmInferred} inferred)`);
    console.log(`  TBox increment:     ${timings.tboxIncrement.toFixed(0)} ms  (${tboxInferred} inferred, +${tboxInferred - coldInferred})`);
    console.log(`  ABox increment:     ${timings.aboxIncrement.toFixed(0)} ms  (${aboxInferred} inferred, +${aboxInferred - tboxInferred})`);

    // Warm should be significantly faster than cold (cache hit)
    expect(timings.warm).toBeLessThan(timings.cold * 0.5);
  }, 120000);
});
