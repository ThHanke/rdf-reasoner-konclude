/**
 * ALIF+ regression tests — formerly-hanging 1-filler FP/IFP cases.
 *
 * FIXED (2026-09-16, patches 020-021):
 *   - Patch 020: setAllIncompletelyHandledIndividualsRetrieved(true) in 3
 *     trivial-consistency branches → fixes checkConsistency + classify
 *   - Patch 021: null guard in createOntologyFixedCacheReader() → fixes materialize
 *
 * All 9 cases now pass. Test names retain "HANG:" prefix for traceability.
 */

import { describe, it, expect, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { Parser } from "n3";
import type { Quad } from "@rdfjs/types";

import { RdfReasoner } from "../../ts/index.js";

const wasmPath = new URL("../../dist/konclude.wasm", import.meta.url).pathname;
const wasmExists = existsSync(wasmPath);

function parseNT(nt: string): Quad[] {
  const parser = new Parser({ format: "N-Triples" });
  const quads: Quad[] = [];
  parser.parse(nt, (err, quad) => {
    if (err) throw err;
    if (quad) quads.push(quad as Quad);
  });
  return quads;
}

// ── Minimal fixtures (NTriples) ──────────────────────────────────────────────

// 3 triples: absolute minimum FP + 1 ABox assertion
const FP_1FILLER = `\
<http://ex.org/p> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#ObjectProperty> .
<http://ex.org/p> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#FunctionalProperty> .
<http://ex.org/a> <http://ex.org/p> <http://ex.org/b> .`;

// 4 triples: FP + 2 fillers → merge needed (JS workaround handles this)
const FP_2FILLER = `\
<http://ex.org/p> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#ObjectProperty> .
<http://ex.org/p> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#FunctionalProperty> .
<http://ex.org/a> <http://ex.org/p> <http://ex.org/b> .
<http://ex.org/a> <http://ex.org/p> <http://ex.org/c> .`;

// 3 triples: IFP + 1 subject
const IFP_1SUBJ = `\
<http://ex.org/q> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#ObjectProperty> .
<http://ex.org/q> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#InverseFunctionalProperty> .
<http://ex.org/a> <http://ex.org/q> <http://ex.org/x> .`;

// 4 triples: IFP + 2 subjects → merge needed (JS workaround handles this)
const IFP_2SUBJ = `\
<http://ex.org/q> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#ObjectProperty> .
<http://ex.org/q> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#InverseFunctionalProperty> .
<http://ex.org/a> <http://ex.org/q> <http://ex.org/x> .
<http://ex.org/b> <http://ex.org/q> <http://ex.org/x> .`;

// 4 triples: FP+IFP on same role, 1 filler
const FP_IFP_1FILLER = `\
<http://ex.org/r> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#ObjectProperty> .
<http://ex.org/r> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#FunctionalProperty> .
<http://ex.org/r> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#InverseFunctionalProperty> .
<http://ex.org/a> <http://ex.org/r> <http://ex.org/b> .`;

// 2 triples: FP-only TBox — no ABox individuals
const FP_TBOX_ONLY = `\
<http://ex.org/p> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#ObjectProperty> .
<http://ex.org/p> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#FunctionalProperty> .`;

// 3 triples: non-FP warmup
const WARMUP = `\
<http://ex.org/A> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#Class> .
<http://ex.org/B> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#Class> .
<http://ex.org/B> <http://www.w3.org/2000/01/rdf-schema#subClassOf> <http://ex.org/A> .`;

// ── Test matrix ──────────────────────────────────────────────────────────────

describe.skipIf(!wasmExists)("ALIF+ hang — minimal reproducer matrix", () => {
  let reasoner: RdfReasoner;

  afterEach(() => {
    reasoner?.terminate();
  });

  // =========================================================================
  // Controls (PASS) — these confirm the workarounds and non-ALIF+ paths work
  // =========================================================================

  it("CONTROL: FP-TBox-only / materialize → PASS (no ABox)", { timeout: 5000 }, async () => {
    reasoner = new RdfReasoner();
    await reasoner.ready;
    const result = await reasoner.materialize(parseNT(FP_TBOX_ONLY));
    expect(result).toBeDefined();
  });

  it("CONTROL: FP-2filler / materialize → PASS (C++ strips FP decl for multi-filler)", { timeout: 5000 }, async () => {
    reasoner = new RdfReasoner();
    await reasoner.ready;
    const result = await reasoner.materialize(parseNT(FP_2FILLER));
    expect(result).toBeDefined();
  });

  it("CONTROL: IFP-2subj / materialize → PASS (C++ strips IFP decl for multi-subject)", { timeout: 5000 }, async () => {
    reasoner = new RdfReasoner();
    await reasoner.ready;
    const result = await reasoner.materialize(parseNT(IFP_2SUBJ));
    expect(result).toBeDefined();
  });

  // =========================================================================
  // HANG cases — all 1-filler ALIF+ ontologies
  // Minimal reproducer: 3 NTriples (FP decl + ObjectProperty decl + 1 assertion)
  // =========================================================================

  it("HANG: COLD / FP-1filler / checkConsistency (3 triples)", { timeout: 5000 }, async () => {
    reasoner = new RdfReasoner();
    await reasoner.ready;
    const ok = await reasoner.checkConsistency(parseNT(FP_1FILLER));
    expect(typeof ok).toBe("boolean");
  });

  it("HANG: COLD / FP-1filler / classify (3 triples)", { timeout: 5000 }, async () => {
    reasoner = new RdfReasoner();
    await reasoner.ready;
    const result = await reasoner.classify(parseNT(FP_1FILLER));
    expect(result).toBeDefined();
  });

  it("HANG: COLD / FP-1filler / materialize (3 triples)", { timeout: 5000 }, async () => {
    reasoner = new RdfReasoner();
    await reasoner.ready;
    const result = await reasoner.materialize(parseNT(FP_1FILLER));
    expect(result).toBeDefined();
  });

  it("HANG: COLD / IFP-1subj / materialize (3 triples)", { timeout: 5000 }, async () => {
    reasoner = new RdfReasoner();
    await reasoner.ready;
    const result = await reasoner.materialize(parseNT(IFP_1SUBJ));
    expect(result).toBeDefined();
  });

  it("HANG: COLD / FP+IFP-1filler / materialize (4 triples)", { timeout: 5000 }, async () => {
    reasoner = new RdfReasoner();
    await reasoner.ready;
    const result = await reasoner.materialize(parseNT(FP_IFP_1FILLER));
    expect(result).toBeDefined();
  });

  it("HANG: WARM / FP-1filler / materialize (warmup irrelevant — same result)", { timeout: 5000 }, async () => {
    reasoner = new RdfReasoner();
    await reasoner.ready;
    await reasoner.checkConsistency(parseNT(WARMUP));
    const result = await reasoner.materialize(parseNT(FP_1FILLER));
    expect(result).toBeDefined();
  });
});
