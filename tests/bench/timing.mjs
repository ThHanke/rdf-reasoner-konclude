// tests/bench/timing.mjs
// Direct WASM timing benchmark — mirrors the Konclude desktop test matrix.
// Usage: node tests/bench/timing.mjs
// Requires dist/konclude.mjs from docker compose run build

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, '../fixtures');

const modulePath = join(__dirname, '../../dist/konclude.mjs');
const { default: createKoncludeModule } = await import(modulePath);

const cases = [
  { name: 'LUBM schema',        files: ['lubm.nt'],                    expressiveness: 'SHI',   desktopMs: 7 },
  { name: 'GALEN',              files: ['galen.nt'],                   expressiveness: 'SHIF',  desktopMs: 164 },
  { name: 'Roberts family',     files: ['roberts-family.nt'],          expressiveness: 'SROIQ', desktopMs: 2082 },
  { name: 'LUBM schema + data', files: ['lubm.nt', 'lubm-data.nt'],   expressiveness: 'SHI',   desktopMs: null },
];

function loadNT(file) {
  return readFileSync(join(FIXTURES, file), 'utf8');
}

function countTriples(nt) {
  return nt.split('\n').filter(l => l.trim() && !l.trim().startsWith('#')).length;
}

async function bench(Module, name, nts) {
  const reasoner = new Module.KoncludeReasoner();
  try {
    const tLoad0 = performance.now();
    for (const nt of nts) reasoner.loadNTriples(nt);
    const tLoad1 = performance.now();
    const ok = reasoner.classify();
    const tClassify = performance.now();
    const inferred = reasoner.getInferredNTriples();
    const tOutput = performance.now();

    if (!ok) throw new Error('classify() returned false');

    const inferredCount = countTriples(inferred);
    return {
      loadMs: Math.round(tLoad1 - tLoad0),
      classifyMs: Math.round(tClassify - tLoad1),
      outputMs: Math.round(tOutput - tClassify),
      totalMs: Math.round(tOutput - tLoad0),
      inferredTriples: inferredCount,
      ok: true,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    reasoner.delete();
  }
}

async function main() {
  console.log(`Loading WASM module (pthreads)...`);
  const Module = await createKoncludeModule();
  console.log('Module ready.\n');

  const results = [];

  for (const c of cases) {
    process.stdout.write(`Running ${c.name} (${c.files.join('+')})... `);
    let nts;
    try {
      nts = c.files.map(loadNT);
    } catch {
      console.log('SKIP (fixture missing)');
      results.push({ ...c, result: null });
      continue;
    }

    const tripleCount = nts.reduce((s, nt) => s + countTriples(nt), 0);
    const result = await bench(Module, c.name, nts);

    if (result.ok) {
      console.log(`${result.totalMs} ms total (load: ${result.loadMs} ms, classify: ${result.classifyMs} ms, output: ${result.outputMs} ms, inferred: ${result.inferredTriples} triples)`);
    } else {
      console.log(`FAIL: ${result.error}`);
    }
    results.push({ ...c, tripleCount, result });
  }

  const label = 'WASM classify';
  console.log('\n--- Results table ---');
  console.log(`| Ontology | Expressiveness | NTriples | Konclude desktop | ${label} | WASM total |`);
  console.log('|---|---|---|---|---|---|');
  for (const c of results) {
    const nt = c.tripleCount ?? 'TBD';
    const desktop = c.desktopMs != null ? `${c.desktopMs} ms` : '—';
    let wasmClassify = '—', wasmTotal = '—';
    if (c.result?.ok) {
      wasmClassify = `${c.result.classifyMs} ms`;
      wasmTotal = `${c.result.totalMs} ms`;
    } else if (c.result?.error) {
      wasmClassify = wasmTotal = `FAIL`;
    }
    console.log(`| ${c.name} | ${c.expressiveness} | ${nt} | ${desktop} | ${wasmClassify} | ${wasmTotal} |`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
