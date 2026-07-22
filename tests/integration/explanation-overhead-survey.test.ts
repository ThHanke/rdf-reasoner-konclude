/**
 * Survey: real explanation overhead across fixtures.
 * Each measurement uses a FRESH RdfReasoner to avoid cache effects.
 * Measures actual reasoning time, not cache-hit time.
 */

import { describe, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Store, Parser, DataFactory } from "n3";
import type { Quad } from "@rdfjs/types";

import { RdfReasoner, EXPLANATION_GRAPH_IRI, INFERRED_GRAPH_IRI } from "../../ts/index.js";
import { loadFixture } from "../helpers/fixture.js";

const wasmPath = new URL("../../dist/konclude.wasm", import.meta.url).pathname;
const wasmExists = existsSync(wasmPath);

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadAny(name: string): Quad[] {
  const path = join(__dirname, "../fixtures", name);
  const raw = readFileSync(path, "utf8");
  const isTurtle = name.endsWith(".ttl");
  const parser = new Parser({ format: isTurtle ? "Turtle" : "N-Triples" });
  return parser.parse(raw) as Quad[];
}

const FIXTURES = [
  "reasoning-demo.ttl",
  "pizza.nt",
  "lubm.nt",
  "galen.nt",
  "roberts-family.nt",
];

describe.skipIf(!wasmExists)("Explanation overhead survey (fresh reasoner per call)", () => {
  it("all fixtures — classify and materialize, no cache", async () => {
    const eg = DataFactory.namedNode(EXPLANATION_GRAPH_IRI);
    const ig = DataFactory.namedNode(INFERRED_GRAPH_IRI);

    type Row = {
      fixture: string;
      inputQuads: number;
      op: string;
      baseMs: number;
      explMs: number;
      overhead: string;
      inferredCount: number;
      explQuadCount: number;
    };
    const rows: Row[] = [];

    for (const file of FIXTURES) {
      let quads: Quad[];
      try {
        quads = file.endsWith(".ttl") ? loadAny(file) : loadFixture(file);
      } catch (e: any) {
        console.log(`  Skipping ${file}: ${e.message?.slice(0, 60)}`);
        continue;
      }
      const name = file.replace(/\.(nt|ttl)$/, "");
      console.log(`  ${name} (${quads.length} quads)...`);

      for (const op of ["classify", "materialize"] as const) {
        try {
          // Fresh reasoner for BASE
          const rBase = new RdfReasoner();
          await rBase.ready;
          const storeBase = new Store(quads);
          const t0 = performance.now();
          if (op === "classify") await rBase.classify(storeBase);
          else await rBase.materialize(storeBase);
          const baseMs = performance.now() - t0;
          const inferredCount = storeBase.getQuads(null, null, null, ig).length;
          rBase.terminate();

          // Fresh reasoner for EXPLANATIONS
          const rExpl = new RdfReasoner();
          await rExpl.ready;
          const storeExpl = new Store(quads);
          const t1 = performance.now();
          if (op === "classify") await rExpl.classify(storeExpl, { explanations: true });
          else await rExpl.materialize(storeExpl, { explanations: true });
          const explMs = performance.now() - t1;
          const explQuadCount = storeExpl.getQuads(null, null, null, eg).length;
          rExpl.terminate();

          const oh = baseMs > 100 ? `${(((explMs - baseMs) / baseMs) * 100).toFixed(0)}%` :
                     `+${(explMs - baseMs).toFixed(0)}ms`;

          rows.push({ fixture: name, inputQuads: quads.length, op, baseMs, explMs, overhead: oh, inferredCount, explQuadCount });
          console.log(`    ${op}: base=${baseMs.toFixed(0)}ms expl=${explMs.toFixed(0)}ms (${oh})`);
        } catch (e: any) {
          console.log(`    ${op} error: ${e.message?.slice(0, 80)}`);
          rows.push({ fixture: name, inputQuads: quads.length, op, baseMs: 0, explMs: 0, overhead: "ERR", inferredCount: 0, explQuadCount: 0 });
        }
      }
    }

    console.log("\n╔═══════════════════════════════════════════════════════════════════════════════════════════════╗");
    console.log("║   Explanation Overhead — Fresh Reasoner (no cache effects)                                   ║");
    console.log("╠═══════════════════════════════════════════════════════════════════════════════════════════════╣");
    console.log("║  " + "Fixture".padEnd(18) + "Op".padEnd(14) + "Input".padStart(6) + " Inferred".padStart(9) + " Base(ms)".padStart(9) + " Expl(ms)".padStart(9) + " Overhead".padStart(9) + " ExplQ".padStart(7));
    console.log("║  " + "─".repeat(82));
    for (const r of rows) {
      console.log("║  " +
        r.fixture.padEnd(18) +
        r.op.padEnd(14) +
        r.inputQuads.toString().padStart(6) +
        r.inferredCount.toString().padStart(9) +
        r.baseMs.toFixed(0).padStart(9) +
        r.explMs.toFixed(0).padStart(9) +
        r.overhead.padStart(9) +
        r.explQuadCount.toString().padStart(7),
      );
    }
    console.log("╚═══════════════════════════════════════════════════════════════════════════════════════════════╝");
  }, 600000);
});
