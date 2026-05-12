// tests/bench/bench.mjs
// Unified comparative benchmark: native Konclude (Docker) vs WASM port.
// Markdown output to stdout; progress to stderr.
// Usage: node tests/bench/bench.mjs
//        npm run bench
//        npm run bench > results.md

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { benchAll as nativeBenchAll, NATIVE_CASES } from './native-runner.mjs';
import { benchAll as wasmBenchAll, WASM_CASES } from './wasm-runner.mjs';
import { benchAll as tsBenchAll, TS_CASES } from './ts-runner.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '../..');

function getPortedCommit() {
  const r = spawnSync('git', ['-C', join(REPO_ROOT, 'vendor/konclude'), 'rev-parse', '--short', 'HEAD'], {
    encoding: 'utf8',
  });
  return r.status === 0 ? r.stdout.trim() : 'unknown';
}

function fmtMs(ms) {
  return ms != null ? `${ms} ms` : '—';
}

function ratioStr(wasmMs, nativeMs) {
  if (!wasmMs || !nativeMs) return '—';
  return `~${(wasmMs / nativeMs).toFixed(1)}×`;
}

async function main() {
  console.error('Running native Konclude benchmark (Docker)...');
  const nativeResults = await nativeBenchAll(NATIVE_CASES, 3);

  console.error('\nRunning WASM benchmark...');
  let wasmResults;
  try {
    wasmResults = await wasmBenchAll(WASM_CASES, { warmup: 1, runs: 3 });
  } catch (e) {
    console.error(`WASM benchmark failed: ${e.message}`);
    process.exit(1);
  }

  console.error('\nRunning TypeScript-layer benchmark...');
  let tsResults;
  try {
    tsResults = await tsBenchAll(TS_CASES, { warmup: 1, runs: 3 });
  } catch (e) {
    console.error(`TS benchmark failed: ${e.message}`);
    tsResults = [];
  }

  const nativeVersionRow = nativeResults.find(r => r.result?.nativeVersion);
  const nativeVersion = nativeVersionRow?.result?.nativeVersion ?? 'unknown';
  const nativeThreads = nativeVersionRow?.result?.threads ?? 'unknown';
  const portedCommit = getPortedCommit();

  // ── Markdown output ──────────────────────────────────────────────────────────

  console.log('## Benchmark Results\n');
  console.log('```');
  console.log(`Native:  Konclude ${nativeVersion} (konclude/konclude:latest)`);
  console.log(`Ported:  vendor/konclude @ ${portedCommit} (submodule)`);
  console.log(`Threads: ${nativeThreads} (native -w AUTO / WASM pthreads)`);
  console.log(`Date:    ${new Date().toISOString().slice(0, 10)}`);
  console.log('```\n');

  const nativeByName = Object.fromEntries(nativeResults.map(r => [r.name, r]));
  const wasmByName   = Object.fromEntries(wasmResults.map(r => [r.name, r]));
  const tsByName     = Object.fromEntries(tsResults.map(r => [r.name, r]));

  const header = '| Ontology | Exp. | NTriples | Native parse ¹ | Native preprocess+precompute+classify ² | WASM load ¹ | WASM classify ² | WASM total | TS total ³ | Ratio ² |';
  const sep    = '|---|---|---|---|---|---|---|---|---|---|';
  console.log(header);
  console.log(sep);

  for (const c of WASM_CASES) {
    const nc = nativeByName[c.name];
    const wc = wasmByName[c.name];
    const tc = tsByName[c.name];

    const nt  = wc?.tripleCount ?? '—';
    const exp = c.expressiveness;

    let nParse = '—', nClassify = '—';
    if (nc?.result && !nc.result.error) {
      nParse = fmtMs(nc.result.parseMs);
      const combined =
        (nc.result.preprocessMs ?? 0) +
        (nc.result.precomputeMs  ?? 0) +
        (nc.result.classifyMs    ?? 0);
      nClassify = combined > 0 ? `${combined} ms` : '—';
    } else if (nc?.result?.error) {
      nParse = nClassify = 'N/A';
    }

    let wLoad = '—', wClassify = '—', wTotal = '—';
    if (wc?.result?.ok) {
      wLoad     = fmtMs(wc.result.loadMs);
      wClassify = fmtMs(wc.result.classifyMs);
      wTotal    = fmtMs(wc.result.totalMs);
    } else if (wc?.result?.error) {
      wLoad = wClassify = wTotal = 'FAIL';
    }

    let tsTotal = '—';
    if (tc?.result?.ok) {
      tsTotal = fmtMs(tc.result.totalMs);
    } else if (tc?.result?.error) {
      tsTotal = tc.result.error === 'fixture missing' ? 'SKIP' : 'FAIL';
    }

    const nativeClassifyMs =
      nc?.result && !nc.result.error
        ? (nc.result.preprocessMs ?? 0) + (nc.result.precomputeMs ?? 0) + (nc.result.classifyMs ?? 0)
        : null;
    const wasmClassifyMs = wc?.result?.ok ? wc.result.classifyMs : null;

    console.log(`| ${c.name} | ${exp} | ${nt} | ${nParse} | ${nClassify} | ${wLoad} | ${wClassify} | ${wTotal} | ${tsTotal} | ${ratioStr(wasmClassifyMs, nativeClassifyMs)} |`);
  }

  console.log('');
  console.log('**Notes:**');
  console.log('¹ Native parse (OWL 2 XML) and WASM load (NTriples/Raptor2) use different input formats — **not comparable**.');
  console.log('² "Native preprocess+precompute+classify" and "WASM classify" perform the same logical work (in-memory OWL model → class hierarchy) and are **directly comparable**.');
  console.log('³ "TS total" measures the full TypeScript layer: n3.Writer serialization + Worker postMessage RTT + n3.Parser + store.addQuad loop. JS overhead = TS total − WASM total.');
  console.log(`- Native: 3 runs per ontology, median reported. WASM / TS: 1 warm-up discarded, median of 3 measured runs.`);
  console.log(`- WASM runtime: Node.js ${process.version} with Emscripten pthreads build.`);
  console.log('- LUBM+data native input: NTriples merged to RDF/XML via rdflib (auto-generated, .gitignored).');
}

main().catch(e => { console.error(e); process.exit(1); });
