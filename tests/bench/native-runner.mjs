// tests/bench/native-runner.mjs
// Runs native Konclude via Docker, parses timing from log output.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '../..');
const TESTS_DIR = join(REPO_ROOT, 'vendor/konclude/Tests');
const FIXTURES_DIR = join(REPO_ROOT, 'tests/fixtures');

const RE_VERSION  = /Version (v[\d.]+-\d+ - \w+)/;
const RE_PARSE    = /Ontology parsed in (\d+) ms/;
const RE_PREPROC  = /Finished preprocessing in (\d+) ms/;
const RE_PRECOMP  = /Finished precomputing in (\d+) ms/;
const RE_CLASSIFY = /Finished class classification in (\d+) ms/;
const RE_TOTAL    = /Total processing time:\s*(\d+) ms/;
const RE_THREADS  = /Reasoner initialized with (\d+) processing unit/;

function parseMs(log, re) {
  const m = log.match(re);
  return m ? parseInt(m[1], 10) : null;
}

function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : sorted[mid];
}

function checkDocker() {
  const r = spawnSync('docker', ['--version'], { encoding: 'utf8' });
  return r.status === 0 && !r.error;
}

// Generate tests/fixtures/lubm-combined.rdf.xml by merging lubm.nt + lubm-data.nt.
// Uses Python rdflib (available on this system). The file is .gitignored (derived).
function ensureLubmCombined() {
  const out = join(FIXTURES_DIR, 'lubm-combined.rdf.xml');
  if (existsSync(out)) return out;

  const script = `
from rdflib import Graph
g = Graph()
g.parse('${join(FIXTURES_DIR, 'lubm.nt')}', format='ntriples')
g.parse('${join(FIXTURES_DIR, 'lubm-data.nt')}', format='ntriples')
g.serialize('${out}', format='xml')
`;
  const r = spawnSync('python3', ['-c', script], { encoding: 'utf8' });
  if (r.status !== 0 || r.error) {
    return null;
  }
  return out;
}

export function benchOne(owlFile, mountDir, runs = 3) {
  if (!checkDocker()) {
    return { error: 'docker unavailable' };
  }

  const fullPath = join(mountDir, owlFile);
  if (!existsSync(fullPath)) {
    return { error: `fixture not found: ${fullPath}` };
  }

  const timings = [];
  let nativeVersion = null;
  let threads = null;

  for (let i = 0; i < runs; i++) {
    const r = spawnSync(
      'docker',
      [
        'run', '--rm',
        '-v', `${mountDir}:/tests:ro`,
        'konclude/konclude:latest',
        'classification', '-v', '-w', 'AUTO',
        '-i', `/tests/${owlFile}`,
        '-o', '/dev/null',
      ],
      { encoding: 'utf8', timeout: 120000 }
    );

    if (r.error) {
      return { error: `docker spawn failed: ${r.error.message}` };
    }

    const log = (r.stdout || '') + (r.stderr || '');

    if (r.status !== 0 && !log.includes('Finished class classification')) {
      return { error: `docker exited ${r.status}: ${log.slice(0, 300)}` };
    }

    if (!nativeVersion) {
      const m = log.match(RE_VERSION);
      if (m) nativeVersion = m[1];
    }
    if (threads == null) {
      const m = log.match(RE_THREADS);
      if (m) threads = parseInt(m[1], 10);
    }

    timings.push({
      parseMs:      parseMs(log, RE_PARSE),
      preprocessMs: parseMs(log, RE_PREPROC),
      precomputeMs: parseMs(log, RE_PRECOMP),
      classifyMs:   parseMs(log, RE_CLASSIFY),
      totalMs:      parseMs(log, RE_TOTAL),
    });
  }

  const fields = ['parseMs', 'preprocessMs', 'precomputeMs', 'classifyMs', 'totalMs'];
  const result = { nativeVersion, threads };
  for (const f of fields) {
    const vals = timings.map(t => t[f]).filter(v => v != null);
    result[f] = vals.length ? median(vals) : null;
  }
  return result;
}

export const NATIVE_CASES = [
  { name: 'LUBM schema',    owlFile: 'lubm-univ-bench.owl.xml',      dir: TESTS_DIR,    expressiveness: 'SHI' },
  { name: 'GALEN',          owlFile: 'galen.owl.xml',                 dir: TESTS_DIR,    expressiveness: 'SHIF' },
  { name: 'Roberts family', owlFile: 'roberts-family-full-D.owl.xml', dir: TESTS_DIR,    expressiveness: 'SROIQ' },
  // Combined TBox+ABox as RDF/XML — generated from lubm.nt + lubm-data.nt via rdflib
  { name: 'LUBM schema + data', owlFile: 'lubm-combined.rdf.xml',    dir: FIXTURES_DIR, expressiveness: 'SHI',
    generate: ensureLubmCombined },
];

export async function benchAll(cases = NATIVE_CASES, runs = 3) {
  const results = [];
  for (const c of cases) {
    process.stderr.write(`  native: ${c.name}... `);

    let dir = c.dir;
    if (c.generate) {
      const generated = c.generate();
      if (!generated) {
        process.stderr.write('skip (generation failed — python3/rdflib required)\n');
        results.push({ ...c, result: { error: 'generation failed' } });
        continue;
      }
      dir = dirname(generated);
    }

    const result = benchOne(c.owlFile, dir, runs);
    if (result.error) {
      process.stderr.write(`ERROR: ${result.error}\n`);
    } else {
      process.stderr.write(`${result.totalMs} ms total\n`);
    }
    results.push({ ...c, result });
  }
  return results;
}
