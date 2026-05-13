// tests/bench/binary-runner.mjs
// JS-only micro-benchmark: encodeToBuffers (binary protocol) vs n3.Writer
// (old NTriples path). Measures encoding overhead in isolation — no WASM.
// Usage: node tests/bench/binary-runner.mjs
//        import { benchAll as binaryBenchAll, BINARY_CASES } from './binary-runner.mjs'

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Parser as N3Parser, Writer as N3Writer } from 'n3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURES = join(__dirname, '../fixtures');
const INTERN_PATH = join(__dirname, '../../dist/intern.js');

function loadNT(file) {
  return readFileSync(join(FIXTURES, file), 'utf8');
}

function parseQuads(nt) {
  return new Promise((resolve, reject) => {
    const parser = new N3Parser({ format: 'N-Triples' });
    const quads = [];
    parser.parse(nt, (err, quad) => {
      if (err) reject(err);
      else if (quad) quads.push(quad);
      else resolve(quads);
    });
  });
}

function serializeNTriples(quads) {
  return new Promise((resolve, reject) => {
    const w = new N3Writer({ format: 'application/n-triples' });
    for (const q of quads) w.addQuad(q.subject, q.predicate, q.object);
    w.end((err, result) => (err ? reject(err) : resolve(result)));
  });
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? Math.round((s[m - 1] + s[m]) / 2) : s[m];
}

export const BINARY_CASES = [
  { name: 'LUBM schema',    files: ['lubm.nt'] },
  { name: 'GALEN',          files: ['galen.nt'] },
  { name: 'Roberts family', files: ['roberts-family.nt'] },
];

export async function benchAll(cases = BINARY_CASES, opts = { warmup: 2, runs: 5 }) {
  if (!existsSync(INTERN_PATH)) {
    throw new Error(`dist/intern.js not found: ${INTERN_PATH}\nRun 'npm run build' first.`);
  }

  const { encodeToBuffers } = await import(INTERN_PATH);

  const results = [];

  for (const c of cases) {
    let ntContents;
    try {
      ntContents = c.files.map(loadNT);
    } catch {
      results.push({ ...c, result: { error: 'fixture missing' } });
      continue;
    }

    const quads = [];
    for (const nt of ntContents) {
      quads.push(...(await parseQuads(nt)));
    }
    const tripleCount = quads.length;

    process.stderr.write(`  binary-enc: ${c.name} (${tripleCount} quads)... `);

    // Warm-up
    for (let i = 0; i < opts.warmup; i++) {
      encodeToBuffers(quads);
      await serializeNTriples(quads);
    }

    // Measure encodeToBuffers (binary protocol JS encoding)
    const binaryRuns = [];
    for (let i = 0; i < opts.runs; i++) {
      const t0 = performance.now();
      encodeToBuffers(quads);
      binaryRuns.push(Math.round(performance.now() - t0));
    }

    // Measure n3.Writer (old NTriples serialisation, for reference)
    const writerRuns = [];
    for (let i = 0; i < opts.runs; i++) {
      const t0 = performance.now();
      await serializeNTriples(quads);
      writerRuns.push(Math.round(performance.now() - t0));
    }

    const binaryMs = median(binaryRuns);
    const writerMs = median(writerRuns);

    process.stderr.write(`binary ${binaryMs} ms, writer ${writerMs} ms\n`);
    results.push({ ...c, tripleCount, result: { ok: true, binaryMs, writerMs } });
  }

  return results;
}

function fmtMs(ms) {
  return ms != null ? `${ms} ms` : '—';
}

// Standalone mode — prints a markdown comparison table
if (process.argv[1] === __filename) {
  console.error('Running binary encoding micro-benchmark...\n');

  benchAll(BINARY_CASES, { warmup: 2, runs: 5 }).then(results => {
    console.log('## Binary Encoding Micro-benchmark\n');
    console.log('Compares `encodeToBuffers` (binary protocol) vs `n3.Writer` (old NTriples path).');
    console.log('JS-only — no WASM. Median of 5 runs after 2 warm-up rounds.\n');
    console.log('| Ontology | Triples | Binary encode | n3.Writer (ref) |');
    console.log('|---|---|---|---|');
    for (const r of results) {
      if (r.result?.error) {
        console.log(`| ${r.name} | — | SKIP | SKIP |`);
      } else {
        console.log(`| ${r.name} | ${r.tripleCount} | ${fmtMs(r.result.binaryMs)} | ${fmtMs(r.result.writerMs)} |`);
      }
    }
    console.log('');
    console.log('**Note:** JS encoding times are comparable. The main speedup comes from eliminating');
    console.log('Raptor NTriples parsing on the WASM side — visible in `ts-runner` total times.');
  }).catch(e => { console.error(e); process.exit(1); });
}
