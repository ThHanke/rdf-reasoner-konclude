// tests/bench/ab-compare.mjs — A/B harness: drive one checkout's WASM module directly through Embind.
// usage: node tests/bench/ab-compare.mjs <checkoutRoot> <fixture.nt[,more.nt]> <classify|realize> [runs=5]
// Supports both API generations: loadTripleBuffer (<= v0.7.x, eager mapping) and syncTripleBuffer (>= v0.8.0, lazy).
// Prints one JSON line per run: phase timings, end-to-end, kernel step times scraped from the module's stderr.
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { cpus, loadavg } from 'node:os';
import { Parser } from 'n3';

const [root, fixture, op, runsArg] = process.argv.slice(2);
const runs = Number(runsArg ?? 5);
const abox = op === 'realize';

const { encodeToBuffers, decodeBuffers } = await import(`${root}/dist/intern.js`);
const { default: createModule } = await import(`${root}/dist/konclude.mjs`);
const quads = fixture.split(',').flatMap((f) => new Parser({ format: 'N-Triples' }).parse(readFileSync(f, 'utf8')));
const wasmSha = createHash('sha256').update(readFileSync(`${root}/dist/konclude.wasm`)).digest('hex').slice(0, 12);

const STEP = /(Finished [A-Za-z()' -]+? in (\d+) ms)/;
const ms = (a, b) => Math.round(b - a);

async function once() {
  const log = [];
  const t0 = performance.now();
  const Module = await createModule({ print: () => {}, printErr: (l) => log.push(String(l)) });
  const r = new Module.KoncludeReasoner();
  const t1 = performance.now();
  try {
    const { tripleBuffer, strTableBuffer } = encodeToBuffers(quads);
    const tp = Module._malloc(tripleBuffer.byteLength), sp = Module._malloc(strTableBuffer.byteLength);
    Module.HEAPU8.set(new Uint8Array(tripleBuffer), tp);
    Module.HEAPU8.set(new Uint8Array(strTableBuffer), sp);
    const tEnc = performance.now();
    const api = typeof r.syncTripleBuffer === 'function' ? 'sync' : 'load';
    if (api === 'sync') r.syncTripleBuffer(tp, tripleBuffer.byteLength / 12, sp, strTableBuffer.byteLength);
    else r.loadTripleBuffer(tp, tripleBuffer.byteLength / 12, sp, strTableBuffer.byteLength, abox);
    Module._free(tp); Module._free(sp);
    const t2 = performance.now();
    const ok = abox ? r.realization() : r.classification();
    const t3 = performance.now();
    const len = r.buildInferredTripleBuffer();
    let inferred = 0; if (len > 0) inferred = decodeBuffers(Module.HEAPU8.slice(r.getInferredTripleBufferPtr() >>> 0, (r.getInferredTripleBufferPtr() >>> 0) + len).buffer).length;
    const t4 = performance.now();
    const steps = {};
    for (const l of log) { const m = STEP.exec(l); if (m) steps[m[1].replace(/ in \d+ ms/, '')] = Number(m[2]); }
    return { api, ok, inferred, initMs: ms(t0, t1), loadMs: ms(tEnc, t2), reasonMs: ms(t2, t3), outputMs: ms(t3, t4),
      ingestToResultMs: ms(tEnc, t4), procCount: typeof r.processorCount === 'function' ? r.processorCount() : null, steps, logLines: log.length, ...(process.env.DUMP ? { log } : {}) };
  } finally { r.delete(); }
}

console.log(JSON.stringify({ meta: { root, fixture: fixture.split(',').map((f) => f.split('/').pop()).join('+'), op, wasmSha, cpu: cpus()[0].model, cores: cpus().length, load: loadavg()[0].toFixed(2) } }));
for (let i = 0; i < runs; i++) console.log(JSON.stringify(await once()));
process.exit(0);
