#!/usr/bin/env node
// wasm-seq-sample.mjs — N fresh-process runs of a scripted op sequence through the WASM build.
// usage: node scripts/wasm-seq-sample.mjs "m:empty,c:a.nt,m:b.nt~drop3,..." [N=3] [stepTimeoutSec=120]
// Same spec as konclude_repro --seq (m = materialize, c = classify, "empty" = no triples,
// "~dropK" removes the K-th non-empty line). A fresh Store is built per step, one RdfReasoner per process.
// A repeated identical step must produce the identical inferred-graph content as its first occurrence.
// Exit 0 ok, 1 mismatch/failure, 2 hang (step timeout).
import { spawn } from "node:child_process";
import { readFileSync, appendFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

async function child(spec) {
  const { RdfReasoner, INFERRED_GRAPH_IRI } = await import(join(root, "dist/index.node.mjs"));
  const { Store, Parser } = await import(join(root, "node_modules/n3/lib/index.js"));
  const traceFile = process.env.WASM_TRACE_FILE;
  const stall = process.env.STALL_MS ? { stallTimeoutMs: Number(process.env.STALL_MS) } : {};
  const r = new RdfReasoner({ ...stall, ...(traceFile ? { onTrace: (m) => appendFileSync(traceFile, m + "\n") } : {}) });
  await r.ready;
  const first = new Map();
  let n = 0, rc = 0;
  for (const step of spec.split(",")) {
    n++;
    const op = step[0], arg = step.slice(2);
    let path = arg, drop = -1;
    const t = arg.indexOf("~drop");
    if (t >= 0) { path = arg.slice(0, t); drop = Number(arg.slice(t + 5)); }
    let text = "";
    if (path !== "empty") {
      text = readFileSync(join(root, path), "utf8");
      if (drop >= 0) text = text.split("\n").filter((l) => l.trim()).filter((_, i) => i !== drop).join("\n");
    }
    const store = new Store(new Parser({ format: "N-Triples" }).parse(text));
    const t0 = Date.now();
    if (op === "m") await r.materialize(store); else await r.classify(store);
    const out = store.getQuads(null, null, null, { termType: "NamedNode", value: INFERRED_GRAPH_IRI })
      .map((q) => `${q.subject.value} ${q.predicate.value} ${q.object.value}`).sort().join("\n");
    if (process.env.WASM_OUT_DIR) {   // for scripts/seq-compare.py (canonical comparison)
      const term = (t) => t.termType === "NamedNode" ? `<${t.value}>` : t.termType === "BlankNode" ? `_:${t.value}` : `"${t.value}"` + (t.language ? `@${t.language}` : t.datatype ? `^^<${t.datatype.value}>` : "");
      const nt = store.getQuads(null, null, null, { termType: "NamedNode", value: INFERRED_GRAPH_IRI }).map((q) => `${term(q.subject)} ${term(q.predicate)} ${term(q.object)} .`).join("\n");
      mkdirSync(process.env.WASM_OUT_DIR, { recursive: true });
      writeFileSync(join(process.env.WASM_OUT_DIR, `seq${n}.nt`), nt + "\n");
    }
    const prev = first.get(step);
    if (prev === undefined) { first.set(step, out); console.log(`step ${n} ${step}: ${out ? out.split("\n").length : 0} inferred (${Date.now() - t0} ms)`); }
    else if (prev !== out) { console.log(`step ${n} MISMATCH ${step}: ${out ? out.split("\n").length : 0} inferred vs first ${prev ? prev.split("\n").length : 0}`); rc = 1; }
    else console.log(`step ${n} ${step}: same as first (${Date.now() - t0} ms)`);
  }
  r.terminate();
  console.log(rc ? "RESULT: FAIL" : `RESULT: PASS (${n} steps)`);
  process.exit(rc);
}

if (process.argv[2] === "--child") {
  child(process.argv[3]).catch((e) => { console.log("ERROR " + (e?.message ?? e)); process.exit(1); });
} else {
  const spec = process.argv[2], N = Number(process.argv[3] ?? 3), stepTimeout = Number(process.argv[4] ?? 120) * 1000;
  let worst = 0;
  for (let i = 1; i <= N; i++) {
    const code = await new Promise((resolve) => {
      const p = spawn(process.execPath, [fileURLToPath(import.meta.url), "--child", spec], { stdio: ["ignore", "pipe", "inherit"], env: process.env.WASM_OUT_BASE ? { ...process.env, WASM_OUT_DIR: `${process.env.WASM_OUT_BASE}/run${i}` } : process.env });
      let last = Date.now(), tail = "";
      p.stdout.on("data", (d) => { last = Date.now(); tail = (tail + d).split("\n").slice(-3).join("\n"); });
      const iv = setInterval(() => {
        if (Date.now() - last > stepTimeout) { clearInterval(iv); p.kill("SIGKILL"); console.log(`run ${i}: HANG (no progress for ${stepTimeout / 1000}s) after: ${tail.trim().split("\n").pop()}`); resolve(2); }
      }, 1000);
      p.on("exit", (c) => { clearInterval(iv); if (c !== null && c !== 2 || c === 0) { console.log(`run ${i}: exit=${c} ${tail.trim().split("\n").pop()}`); resolve(c ?? 1); } });
    });
    worst = Math.max(worst, code === 0 ? 0 : code);
  }
  process.exit(worst);
}
