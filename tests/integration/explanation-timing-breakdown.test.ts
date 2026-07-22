/**
 * Diagnostic: full pipeline timing breakdown.
 *
 * Measures old path vs new (direct N3 injection) for both
 * INPUT (Store → binary) and OUTPUT (binary → Store) paths.
 */

import { describe, it } from "vitest";
import { existsSync } from "node:fs";
import { Store, DataFactory } from "n3";

import { RdfReasoner, INFERRED_GRAPH_IRI, EXPLANATION_GRAPH_IRI } from "../../ts/index.js";
import { encodeToBuffers, decodeBuffers, computeStoreFingerprint } from "../../ts/intern.js";
import { serializeExplanations } from "../../ts/explanationSerializer.js";
import { injectExplanationsFromBuffer, injectInferredFromBuffer, encodeStoreToBuffers, computeStoreFingerprintDirect } from "../../ts/n3Inject.js";
import { loadFixture } from "../helpers/fixture.js";

const wasmPath = new URL("../../dist/konclude.wasm", import.meta.url).pathname;
const wasmExists = existsSync(wasmPath);

function timeIt(fn: () => void): number {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
}

async function timeItAsync(fn: () => Promise<void>): Promise<number> {
  const t0 = performance.now();
  await fn();
  return performance.now() - t0;
}

describe.skipIf(!wasmExists)("Full pipeline timing breakdown (roberts-family)", () => {
  it("input + output cost breakdown (materialize + explanations)", async () => {
    const baseQuads = loadFixture("roberts-family.nt");
    const r = new RdfReasoner();
    await r.ready;

    const allTimings: Record<string, number[]> = {};
    const record = (key: string, ms: number) => {
      (allTimings[key] ??= []).push(ms);
    };

    const store = new Store(baseQuads);

    // === INPUT: old path (getQuads + encodeToBuffers) ===
    let encoded!: ReturnType<typeof encodeToBuffers>;
    record("IN_old_getQuads+encode", timeIt(() => {
      const allQuads = store.getQuads(null, null, null, null);
      encoded = encodeToBuffers(allQuads);
    }));

    // === INPUT: old fingerprint (getQuads + computeStoreFingerprint) ===
    record("IN_old_getQuads+fingerprint", timeIt(() => {
      computeStoreFingerprint(store.getQuads(null, null, null, null));
    }));

    // === INPUT: new path (encodeStoreToBuffers — no getQuads) ===
    record("IN_new_encode", timeIt(() => {
      encodeStoreToBuffers(store);
    }));

    // === INPUT: new fingerprint (no getQuads) ===
    record("IN_new_fingerprint", timeIt(() => {
      computeStoreFingerprintDirect(store);
    }));

    // === WASM: load + realize ===
    record("WASM_load+realize", await timeItAsync(async () => {
      await (r as any)._call("loadTripleBuffer",
        [encoded.tripleBuffer, encoded.strTableBuffer, true],
        [encoded.tripleBuffer, encoded.strTableBuffer]);
      await (r as any)._call("realization", []);
    }));

    // Get buffer WITH explanations
    let bufExpl!: ArrayBuffer;
    record("OUT_getBuffer_expl", await timeItAsync(async () => {
      bufExpl = (await (r as any)._call("getInferredTripleBuffer", [true])) as ArrayBuffer;
    }));

    // === OUTPUT OLD: decode + addQuad + serializeExplanations ===
    let decoded!: ReturnType<typeof decodeBuffers> & { quads: any; justifications: any };
    record("OUT_old_decode", timeIt(() => {
      decoded = decodeBuffers(bufExpl, { withJustifications: true }) as any;
    }));

    const ig = DataFactory.namedNode(INFERRED_GRAPH_IRI);
    const storeOld = new Store();
    record("OUT_old_addQuad_inferred", timeIt(() => {
      for (const q of decoded.quads) {
        storeOld.addQuad(DataFactory.quad(q.subject, q.predicate, q.object, ig));
      }
    }));

    record("OUT_old_serializeExpl", timeIt(() => {
      serializeExplanations(storeOld, decoded.justifications, decoded.quads, EXPLANATION_GRAPH_IRI);
    }));

    const oldInferredCount = decoded.quads.length;
    const oldExplCount = storeOld.getQuads(null, null, null, DataFactory.namedNode(EXPLANATION_GRAPH_IRI)).length;
    const oldJustCount = decoded.justifications.entries.length;

    // === OUTPUT NEW: injectInferredFromBuffer + injectExplanationsFromBuffer ===
    const storeNew = new Store();
    let newInferredCount = 0;
    record("OUT_new_injectInferred", timeIt(() => {
      newInferredCount = injectInferredFromBuffer(storeNew, bufExpl, INFERRED_GRAPH_IRI);
    }));

    record("OUT_new_injectExpl", timeIt(() => {
      injectExplanationsFromBuffer(storeNew, bufExpl, EXPLANATION_GRAPH_IRI);
    }));

    const newExplCount = storeNew.getQuads(null, null, null, DataFactory.namedNode(EXPLANATION_GRAPH_IRI)).length;

    // Compute values
    const t: Record<string, number> = {};
    for (const [k, v] of Object.entries(allTimings)) {
      t[k] = v[0];
    }

    const wasmTime = t["WASM_load+realize"];
    const oldInputCost = t["IN_old_getQuads+encode"] + t["IN_old_getQuads+fingerprint"];
    const newInputCost = t["IN_new_encode"] + t["IN_new_fingerprint"];
    const oldOutputCost = t["OUT_getBuffer_expl"] + t["OUT_old_decode"] + t["OUT_old_addQuad_inferred"] + t["OUT_old_serializeExpl"];
    const newOutputCost = t["OUT_getBuffer_expl"] + t["OUT_new_injectInferred"] + t["OUT_new_injectExpl"];
    const oldTotal = oldInputCost + wasmTime + oldOutputCost;
    const newTotal = newInputCost + wasmTime + newOutputCost;

    console.log("\n╔════════════════════════════════════════════════════════════════════╗");
    console.log("║   Full Pipeline Timing (roberts-family)                          ║");
    console.log("╠════════════════════════════════════════════════════════════════════╣");
    console.log(`║  Input quads:    ${baseQuads.length.toString().padStart(6)}     Inferred quads: ${oldInferredCount.toString().padStart(6)} (old) / ${newInferredCount.toString().padStart(6)} (new)`);
    console.log(`║  Justifications: ${oldJustCount.toString().padStart(6)}     Expl quads:     ${oldExplCount.toString().padStart(6)} (old) / ${newExplCount.toString().padStart(6)} (new)`);
    console.log("║");
    console.log("║  Per-phase (ms):");
    for (const [k, v] of Object.entries(t)) {
      console.log(`║    ${k.padEnd(34)} ${v.toFixed(2).padStart(8)} ms`);
    }
    console.log("║");
    console.log("║  ══════ INPUT PATH ══════");
    console.log(`║  Old (getQuads→encode+fp):        ${oldInputCost.toFixed(2).padStart(8)} ms`);
    console.log(`║  New (direct read):               ${newInputCost.toFixed(2).padStart(8)} ms`);
    console.log(`║  Input speedup:                   ${(oldInputCost / newInputCost).toFixed(1)}x`);
    console.log("║");
    console.log("║  ══════ OUTPUT PATH (inferred + explanations) ══════");
    console.log(`║  Old (decode+addQuad+serialize):   ${oldOutputCost.toFixed(2).padStart(8)} ms`);
    console.log(`║  New (inject inferred+expl):       ${newOutputCost.toFixed(2).padStart(8)} ms`);
    console.log(`║  Output speedup:                   ${(oldOutputCost / newOutputCost).toFixed(1)}x`);
    console.log("║");
    console.log("║  ══════ TOTAL PIPELINE ══════");
    console.log(`║  WASM reasoning:                  ${wasmTime.toFixed(2).padStart(8)} ms`);
    console.log(`║  Old total:                       ${oldTotal.toFixed(2).padStart(8)} ms`);
    console.log(`║  New total:                       ${newTotal.toFixed(2).padStart(8)} ms`);
    console.log(`║  End-to-end speedup:              ${(oldTotal / newTotal).toFixed(2)}x`);
    console.log(`║  JS overhead (old):               ${(oldTotal - wasmTime).toFixed(2).padStart(8)} ms  (${(((oldTotal - wasmTime) / oldTotal) * 100).toFixed(1)}% of pipeline)`);
    console.log(`║  JS overhead (new):               ${(newTotal - wasmTime).toFixed(2).padStart(8)} ms  (${(((newTotal - wasmTime) / newTotal) * 100).toFixed(1)}% of pipeline)`);
    console.log("╚════════════════════════════════════════════════════════════════════╝");

    r.terminate();
  }, 600000);
});
