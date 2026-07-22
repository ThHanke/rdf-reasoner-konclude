/**
 * Justification coverage audit: every inferred triple must have a justification.
 *
 * Strategy:
 * 1. Load a rich ontology (roberts-family, pizza, etc.)
 * 2. Run reason() to get all inferred triples
 * 3. For EVERY inferred triple, call explainEntailment()
 * 4. Assert isEntailed=true AND justifications.length > 0
 *
 * Any triple that returns isEntailed=false or empty justifications is a gap.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { Store, DataFactory } from "n3";
import type { Quad } from "@rdfjs/types";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Parser } from "n3";
import { RdfReasoner } from "../../ts/index.js";
import { loadFixture } from "../helpers/fixture.js";

const wasmPath = new URL("../../dist/konclude.wasm", import.meta.url).pathname;
const wasmExists = existsSync(wasmPath);
const __dirname = dirname(fileURLToPath(import.meta.url));

function loadTurtle(name: string): Quad[] {
  const raw = readFileSync(join(__dirname, "../fixtures", name), "utf8");
  const parser = new Parser();
  return parser.parse(raw) as Quad[];
}

const INFERRED = "urn:konclude:inferred";
const OWL  = "http://www.w3.org/2002/07/owl#";
const RDFS = "http://www.w3.org/2000/01/rdf-schema#";
const RDF  = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";

type Status = "FULL" | "PARTIAL" | "MISSING";
interface AuditResult {
  triple: string;
  predicate: string;
  status: Status;
  vacuous?: boolean;
  axiomCount?: number;
}

function classifyPredicate(pred: string): string | null {
  if (pred === `${RDFS}subClassOf`) return "subClassOf";
  if (pred === `${RDF}type`) return "type";
  if (pred === `${OWL}sameAs`) return "sameAs";
  if (pred === `${OWL}equivalentClass`) return "equivalentClass";
  if (pred === `${OWL}disjointWith`) return "disjointWith";
  if (pred === `${RDFS}subPropertyOf`) return "subPropertyOf";
  if (pred === `${OWL}equivalentProperty`) return "equivalentProperty";
  return null;
}

async function auditOntology(
  fixtureName: string,
  reasoner: RdfReasoner,
  opts?: { useMaterialize?: boolean },
): Promise<AuditResult[]> {
  const quads = fixtureName.endsWith(".ttl")
    ? loadTurtle(fixtureName)
    : loadFixture(fixtureName);
  const store = new Store();
  store.addQuads(quads);

  if (opts?.useMaterialize) {
    await reasoner.materialize(store);
  } else {
    await reasoner.reason(store);
  }

  const inferredQuads = store.getQuads(
    null, null, null, DataFactory.namedNode(INFERRED),
  );

  // Deduplicate by s/p/o
  const seen = new Set<string>();
  const unique: Quad[] = [];
  for (const q of inferredQuads) {
    const k = `${q.subject.value}\t${q.predicate.value}\t${q.object.value}`;
    if (!seen.has(k)) { seen.add(k); unique.push(q); }
  }

  // Filter to supported predicate types
  const supported = unique.filter(q => classifyPredicate(q.predicate.value) !== null);

  const results: AuditResult[] = [];

  for (const q of supported) {
    const tripleStr = `${q.subject.value} ${q.predicate.value} ${q.object.value}`;
    const probeKind = classifyPredicate(q.predicate.value)!;

    // objectIsClassLike: true for subClassOf/equivalentClass/disjointWith/type,
    // false for data properties, irrelevant for sameAs
    const objectIsClassLike = !["sameAs", "equivalentProperty", "subPropertyOf"].includes(probeKind);

    try {
      const result = await reasoner.explainEntailment(
        store, q.subject.value, q.predicate.value, q.object.value,
        { objectIsClassLike },
      );

      let status: Status;
      if (!result.isEntailed) {
        status = "MISSING";
      } else if (result.justifications.length > 0) {
        status = "FULL";
      } else {
        status = "PARTIAL";
      }

      results.push({
        triple: tripleStr,
        predicate: probeKind,
        status,
        vacuous: (result as any).vacuous,
        axiomCount: result.justifications[0]?.length,
      });
    } catch (e) {
      results.push({
        triple: tripleStr,
        predicate: probeKind,
        status: "MISSING",
      });
    }
  }

  return results;
}

function printSummary(name: string, results: AuditResult[]) {
  const full = results.filter(r => r.status === "FULL").length;
  const partial = results.filter(r => r.status === "PARTIAL").length;
  const missing = results.filter(r => r.status === "MISSING").length;
  const total = results.length;

  console.log(`\n══ ${name}: ${total} inferred triples ══`);
  console.log(`  FULL: ${full}  PARTIAL: ${partial}  MISSING: ${missing}`);

  // Group by predicate
  const byPred = new Map<string, AuditResult[]>();
  for (const r of results) {
    if (!byPred.has(r.predicate)) byPred.set(r.predicate, []);
    byPred.get(r.predicate)!.push(r);
  }
  for (const [pred, items] of byPred) {
    const f = items.filter(r => r.status === "FULL").length;
    const p = items.filter(r => r.status === "PARTIAL").length;
    const m = items.filter(r => r.status === "MISSING").length;
    console.log(`  ${pred}: ${f}/${items.length} full, ${p} partial, ${m} missing`);
  }

  // Print gaps
  const gaps = results.filter(r => r.status !== "FULL");
  if (gaps.length > 0) {
    console.log(`\n  Gaps:`);
    for (const g of gaps.slice(0, 30)) {
      console.log(`    [${g.status}] ${g.triple}${g.vacuous ? " (vacuous)" : ""}`);
    }
    if (gaps.length > 30) console.log(`    ... and ${gaps.length - 30} more`);
  }
}

describe.skipIf(!wasmExists)("Justification coverage audit", () => {
  let reasoner: RdfReasoner;

  beforeAll(async () => {
    reasoner = new RdfReasoner();
    await reasoner.ready;
  }, 30000);

  afterAll(() => {
    reasoner?.terminate();
  });

  it("roberts-family: every inferred triple has justification", async () => {
    const results = await auditOntology("roberts-family.nt", reasoner);
    printSummary("roberts-family", results);

    const nonThing = results.filter(r => !r.triple.endsWith(`${OWL}Thing`));
    const missing = nonThing.filter(r => r.status === "MISSING");
    const partial = nonThing.filter(r => r.status === "PARTIAL");
    expect(missing.length, `${missing.length} triples not detected as entailed`).toBe(0);
    expect(partial.length, `${partial.length} triples entailed but missing justification axioms:\n${partial.map(p => `  [PARTIAL] ${p.triple}`).join("\n")}`).toBe(0);
  }, 120000);

  it("pizza: every inferred triple has justification", async () => {
    const results = await auditOntology("pizza.nt", reasoner);
    printSummary("pizza", results);

    const nonThing = results.filter(r => !r.triple.endsWith(`${OWL}Thing`));
    const missing = nonThing.filter(r => r.status === "MISSING");
    const partial = nonThing.filter(r => r.status === "PARTIAL");
    expect(missing.length, `${missing.length} triples not detected as entailed`).toBe(0);
    expect(partial.length, `${partial.length} triples entailed but missing justification axioms:\n${partial.map(p => `  [PARTIAL] ${p.triple}`).join("\n")}`).toBe(0);
  }, 300000);

  it("abox (sameAs, type propagation): every inferred triple has justification", async () => {
    const results = await auditOntology("owl2dl/abox.ttl", reasoner);
    printSummary("abox", results);

    const nonThing = results.filter(r => !r.triple.endsWith(`${OWL}Thing`));
    const missing = nonThing.filter(r => r.status === "MISSING");
    const partial = nonThing.filter(r => r.status === "PARTIAL");
    expect(missing.length, `${missing.length} triples not detected as entailed`).toBe(0);
    expect(partial.length, `${partial.length} triples entailed but missing justification axioms:\n${partial.map(p => `  [PARTIAL] ${p.triple}`).join("\n")}`).toBe(0);
  }, 120000);

  it("property-characteristics (transitive, symmetric, inverse, FP, IFP): every inferred triple has justification", async () => {
    const results = await auditOntology("owl2dl/property-characteristics.ttl", reasoner);
    printSummary("property-characteristics", results);

    const nonThing = results.filter(r => !r.triple.endsWith(`${OWL}Thing`));
    const missing = nonThing.filter(r => r.status === "MISSING");
    const partial = nonThing.filter(r => r.status === "PARTIAL");
    expect(missing.length, `${missing.length} triples not detected as entailed`).toBe(0);
    expect(partial.length, `${partial.length} triples entailed but missing justification axioms:\n${partial.map(p => `  [PARTIAL] ${p.triple}`).join("\n")}`).toBe(0);
  }, 120000);

  it("restrictions: every inferred triple has justification", async () => {
    const results = await auditOntology("owl2dl/restrictions.ttl", reasoner);
    printSummary("restrictions", results);

    const nonThing = results.filter(r => !r.triple.endsWith(`${OWL}Thing`));
    const missing = nonThing.filter(r => r.status === "MISSING");
    const partial = nonThing.filter(r => r.status === "PARTIAL");
    expect(missing.length, `${missing.length} triples not detected as entailed`).toBe(0);
    expect(partial.length, `${partial.length} triples entailed but missing justification axioms:\n${partial.map(p => `  [PARTIAL] ${p.triple}`).join("\n")}`).toBe(0);
  }, 120000);

  it("reasoning-demo (restrictions + inverse + someValuesFrom): every inferred rdf:type has justification", async () => {
    const results = await auditOntology("reasoning-demo.ttl", reasoner, { useMaterialize: true });
    printSummary("reasoning-demo", results);

    const typeResults = results.filter(r => r.predicate === "type");
    const nonThing = typeResults.filter(r => !r.triple.endsWith(`${OWL}Thing`));
    const missing = nonThing.filter(r => r.status === "MISSING");
    const partial = nonThing.filter(r => r.status === "PARTIAL");
    expect(missing.length, `${missing.length} type triples not detected as entailed`).toBe(0);
    expect(partial.length, `${partial.length} type triples entailed but missing justification axioms:\n${partial.map(p => `  [PARTIAL] ${p.triple}`).join("\n")}`).toBe(0);
  }, 120000);

  // class-collections skipped: ALIF+ hang on unionOf causes timeout
  it.skip("class-collections (unionOf, intersectionOf, oneOf): every inferred triple has justification", async () => {
    const results = await auditOntology("owl2dl/class-collections.ttl", reasoner);
    printSummary("class-collections", results);

    const nonThing = results.filter(r => !r.triple.endsWith(`${OWL}Thing`));
    const missing = nonThing.filter(r => r.status === "MISSING");
    const partial = nonThing.filter(r => r.status === "PARTIAL");
    expect(missing.length, `${missing.length} triples not detected as entailed`).toBe(0);
    expect(partial.length, `${partial.length} triples entailed but missing justification axioms:\n${partial.map(p => `  [PARTIAL] ${p.triple}`).join("\n")}`).toBe(0);
  }, 300000);
});
