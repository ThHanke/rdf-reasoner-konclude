// @vitest-environment node
// Diagnostic: find which specific subClassOf edges differ across fresh-instance runs
import { it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { Store, Parser, DataFactory } from "n3";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RdfReasoner } from "../../ts/index.js";

const { namedNode } = DataFactory;
const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, "../fixtures/pmdco.nt");
const INFERRED = "urn:konclude:inferred";
const SUB = "http://www.w3.org/2000/01/rdf-schema#subClassOf";

function loadStore() {
  const text = readFileSync(FIXTURE, "utf8");
  const store = new Store();
  store.addQuads(new Parser({ format: "N-Triples" }).parse(text));
  return store;
}
function getEdges(store: Store): Set<string> {
  return new Set(store.getQuads(null, namedNode(SUB), null, namedNode(INFERRED))
    .map(q => `${q.subject.value} ${q.object.value}`));
}

it("diagnostic: which edges differ across 5 fresh instances", async () => {
  const N = 5;
  const results: Array<{ count: number; edges: Set<string> }> = [];
  for (let i = 0; i < N; i++) {
    const r = new RdfReasoner();
    await r.ready;
    try {
      const store = loadStore();
      await r.materialize(store, { includeClassHierarchy: true, inferredGraph: INFERRED });
      const edges = getEdges(store);
      results.push({ count: edges.size, edges });
      console.log(`[diag] instance ${i+1}: ${edges.size} edges`);
    } finally { r.terminate(); }
  }
  const allEdges = new Set(results.flatMap(r => [...r.edges]));
  const counts = results.map(r => r.count);
  console.log(`[diag] counts: ${counts.join(", ")}`);
  for (const edge of allEdges) {
    const presence = results.map(r => r.edges.has(edge) ? "Y" : "N").join("");
    if (presence !== "Y".repeat(N)) {
      const m = edge.match(/PMD_\d+/g);
      const label = m ? m.join("→") : edge.slice(0, 100);
      console.log(`[diag-diff] [${presence}] ${label}`);
    }
  }
}, 600_000);
