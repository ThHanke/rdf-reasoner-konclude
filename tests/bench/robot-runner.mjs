// tests/bench/robot-runner.mjs
// Runs HermiT reasoner via ROBOT (ODK Docker image), parses timing from log output.
// ROBOT is the CLI tool; HermiT is the actual OWL 2 DL tableau reasoner (Java).
//
// ROBOT does not emit per-phase timing, so we extract millisecond-precision
// timestamps from -vvv log lines to dissect: JVM startup + parse, reasoning,
// axiom generation + output write.
//
// Usage:
//   node tests/bench/robot-runner.mjs            (standalone)
//   import { benchAll, ROBOT_CASES } from './robot-runner.mjs'

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '../..');
const FIXTURES_DIR = join(REPO_ROOT, 'tests/fixtures');

const DOCKER_IMAGE = 'obolibrary/odkfull:latest';
const TIMEOUT_MS = 600_000; // 10 min per run (HermiT can be very slow on SROIQ)

// Parse a log timestamp like "2026-09-15 19:17:59,384" into epoch ms.
function parseLogTimestamp(line) {
  const m = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}),(\d{3})/);
  if (!m) return null;
  return new Date(m[1].replace(' ', 'T') + 'Z').getTime() + parseInt(m[2], 10);
}

// Extract timing phases from ROBOT -vvv log output.
// Returns { jvmParseMs, reasonMs, fillWriteMs, totalMs } or partial if some markers missing.
function extractTimings(log) {
  const lines = log.split('\n');

  let firstTs = null;
  let loadingTs = null;
  let loadedTs = null;
  let startReasonTs = null;
  let reasonDoneTs = null;
  let fillDoneTs = null;
  let lastTs = null;
  let subcommandMs = null;
  let reportedReasonSec = null;

  for (const line of lines) {
    const ts = parseLogTimestamp(line);
    if (ts != null) {
      if (firstTs == null) firstTs = ts;
      lastTs = ts;
    }

    if (line.includes('Loading ontology') && loadingTs == null) {
      loadingTs = ts;
    }
    if (line.includes('Loaded OntologyID') || line.includes('Ontology has') && line.includes('axioms.')) {
      if (loadedTs == null && ts != null) loadedTs = ts;
    }
    if (line.includes('Starting reasoning...')) {
      startReasonTs = ts;
    }
    if (line.includes('Reasoning took')) {
      reasonDoneTs = ts;
      const m = line.match(/Reasoning took (\d+) seconds/);
      if (m) reportedReasonSec = parseInt(m[1], 10);
    }
    if (line.includes('Filling took')) {
      fillDoneTs = ts;
    }
    if (line.includes('Subcommand Timing:')) {
      const m = line.match(/took ([\d.]+) seconds/);
      if (m) subcommandMs = Math.round(parseFloat(m[1]) * 1000);
    }
  }

  const result = {};

  // JVM startup + parse = first log line → "Starting reasoning..."
  if (firstTs != null && startReasonTs != null) {
    result.jvmParseMs = startReasonTs - firstTs;
  }

  // Pure reasoning = "Starting reasoning..." → "Reasoning took"
  if (startReasonTs != null && reasonDoneTs != null) {
    result.reasonMs = reasonDoneTs - startReasonTs;
  }

  // Axiom generation + output = "Reasoning took" → last log line
  if (reasonDoneTs != null && lastTs != null) {
    result.fillWriteMs = lastTs - reasonDoneTs;
  }

  // Total from ROBOT's own timer
  if (subcommandMs != null) {
    result.subcommandMs = subcommandMs;
  }

  // Total from first→last log timestamp
  if (firstTs != null && lastTs != null) {
    result.totalLogMs = lastTs - firstTs;
  }

  return result;
}

// Count axioms in ROBOT OWL Functional Syntax (.ofn) output.
// Each axiom is one line: SubClassOf(...), EquivalentClasses(...), ClassAssertion(...).
function countOfnAxioms(filePath) {
  try {
    const content = readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    let tbox = 0, types = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('SubClassOf(')) tbox++;
      else if (trimmed.startsWith('EquivalentClasses(')) {
        // EquivalentClasses(A B) = 2 directed axioms (A⊑B, B⊑A)
        const args = trimmed.slice('EquivalentClasses('.length, -1).trim().split(/\s+/);
        const n = args.filter(a => a.startsWith('<') || a.startsWith(':')).length;
        tbox += n * (n - 1);
      }
      else if (trimmed.startsWith('ClassAssertion(')) types++;
    }
    return { total: tbox + types, tboxCount: tbox, typeCount: types };
  } catch {
    return null;
  }
}

function checkDocker() {
  const r = spawnSync('docker', ['--version'], { encoding: 'utf8' });
  return r.status === 0 && !r.error;
}

function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : sorted[mid];
}

// Ensure LUBM combined RDF/XML exists (needed for ABox cases — ROBOT doesn't read NTriples well for large files).
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
  if (r.status !== 0 || r.error) return null;
  return out;
}

export function benchOne(inputFile, runs = 3, command = 'reason', axiomGenerators = null) {
  if (!checkDocker()) {
    return { error: 'docker unavailable' };
  }

  if (!existsSync(inputFile)) {
    return { error: `fixture not found: ${inputFile}` };
  }

  const inputDir = dirname(inputFile);
  const inputName = inputFile.split('/').pop();

  const outDir = mkdtempSync(join(tmpdir(), 'robot-out-'));
  const timings = [];
  let inferredCounts = null;
  let robotVersion = null;

  for (let i = 0; i < runs; i++) {
    const captureOutput = i === 0;
    const outFile = captureOutput ? '/out/result.ofn' : '/dev/null';

    // Build ROBOT command inside a bash wrapper that:
    // 1. Redirects full -vvv log to a temp file (avoids ENOBUFS on large ontologies)
    // 2. Greps only timing-relevant lines to stdout
    const robotCmd = [
      'robot', command, '-vvv',
      '--reasoner', 'HermiT',
      '--input', `/fixtures/${inputName}`,
      '-n', 'true',
    ];
    if (axiomGenerators) {
      robotCmd.push('-A', `"${axiomGenerators}"`);
    }
    robotCmd.push('--output', outFile);

    const bashScript = `
${robotCmd.join(' ')} 2>/tmp/robot.log
RC=$?
grep -E "(Loading ontology|Loaded OntologyID|Ontology has.*axioms|Starting reasoning|Reasoning took|Filling took|Subcommand Timing|ERROR|Exception)" /tmp/robot.log
echo "ROBOT_EXIT=$RC"
robot --version 2>/dev/null || true
`;

    const dockerArgs = [
      'run', '--rm',
      '-v', `${inputDir}:/fixtures:ro`,
      ...(captureOutput ? ['-v', `${outDir}:/out`] : []),
      DOCKER_IMAGE,
      'bash', '-c', bashScript,
    ];

    const wallStart = performance.now();
    const r = spawnSync('docker', dockerArgs, {
      encoding: 'utf8',
      timeout: TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    });
    const wallEnd = performance.now();

    if (r.error) {
      rmSync(outDir, { recursive: true, force: true });
      if (r.error.code === 'ETIMEDOUT' || r.error.message?.includes('TIMEOUT')) {
        return { error: `timeout (${TIMEOUT_MS / 1000}s)` };
      }
      return { error: `docker spawn failed: ${r.error.message}` };
    }

    const log = (r.stdout || '') + (r.stderr || '');

    const exitMatch = log.match(/ROBOT_EXIT=(\d+)/);
    const robotExit = exitMatch ? parseInt(exitMatch[1], 10) : r.status;

    if (robotExit !== 0 && !log.includes('Reasoning took')) {
      rmSync(outDir, { recursive: true, force: true });
      const snippet = log.split('\n').filter(l => l.includes('ERROR') || l.includes('Exception')).slice(0, 3).join('; ');
      return { error: `exit ${robotExit}: ${snippet || log.slice(0, 200)}` };
    }

    if (!robotVersion) {
      const m = log.match(/ROBOT version ([\d.]+)/);
      if (m) robotVersion = m[1];
    }

    const extracted = extractTimings(log);
    extracted.wallMs = Math.round(wallEnd - wallStart);
    timings.push(extracted);

    if (captureOutput) {
      const outPath = join(outDir, 'result.ofn');
      if (existsSync(outPath)) {
        inferredCounts = countOfnAxioms(outPath);
      }
    }
  }

  rmSync(outDir, { recursive: true, force: true });

  // Compute medians
  const fields = ['jvmParseMs', 'reasonMs', 'fillWriteMs', 'subcommandMs', 'totalLogMs', 'wallMs'];
  const result = { robotVersion };
  for (const f of fields) {
    const vals = timings.map(t => t[f]).filter(v => v != null);
    result[f] = vals.length ? median(vals) : null;
  }

  if (inferredCounts) {
    result.inferredTriples = inferredCounts.total;
    result.inferredTboxCount = inferredCounts.tboxCount;
    result.inferredTypeCount = inferredCounts.typeCount;
  }

  return result;
}

export const ROBOT_CASES = [
  {
    name: 'LUBM schema',
    inputFile: join(FIXTURES_DIR, 'lubm.nt'),
    expressiveness: 'SHI',
    command: 'reason',
    axiomGenerators: 'SubClass EquivalentClass',
    abox: false,
  },
  {
    name: 'GALEN',
    inputFile: join(FIXTURES_DIR, 'galen.nt'),
    expressiveness: 'SHIF',
    command: 'reason',
    axiomGenerators: 'SubClass EquivalentClass',
    abox: false,
  },
  {
    name: 'Roberts family',
    inputFile: join(FIXTURES_DIR, 'roberts-family.nt'),
    expressiveness: 'SROIQ',
    command: 'reason',
    axiomGenerators: 'SubClass EquivalentClass ClassAssertion',
    abox: true,
  },
  {
    name: 'LUBM schema + data',
    inputFile: join(FIXTURES_DIR, 'lubm-combined.rdf.xml'),
    expressiveness: 'SHI',
    command: 'reason',
    axiomGenerators: 'SubClass EquivalentClass ClassAssertion',
    abox: true,
    generate: ensureLubmCombined,
  },
];

export async function benchAll(cases = ROBOT_CASES, runs = 3) {
  const results = [];
  for (const c of cases) {
    process.stderr.write(`  hermit: ${c.name}... `);

    let inputFile = c.inputFile;
    if (c.generate) {
      const generated = c.generate();
      if (!generated) {
        process.stderr.write('skip (generation failed — python3/rdflib required)\n');
        results.push({ ...c, result: { error: 'generation failed' } });
        continue;
      }
      inputFile = generated;
    }

    if (!existsSync(inputFile)) {
      process.stderr.write('skip (fixture missing)\n');
      results.push({ ...c, result: { error: 'fixture missing' } });
      continue;
    }

    const result = benchOne(inputFile, runs, c.command, c.axiomGenerators);
    if (result.error) {
      process.stderr.write(`${result.error}\n`);
    } else {
      const reasonStr = result.reasonMs != null ? `reason: ${result.reasonMs} ms` : 'reason: —';
      const parseStr = result.jvmParseMs != null ? `jvm+parse: ${result.jvmParseMs} ms` : 'jvm+parse: —';
      process.stderr.write(`${result.wallMs} ms wall (${parseStr}, ${reasonStr})\n`);
    }
    results.push({ ...c, result });
  }
  return results;
}

// Standalone mode
if (process.argv[1] === __filename) {
  console.error('Running HermiT benchmark (via ROBOT/ODK Docker)...\n');
  benchAll(ROBOT_CASES, 3)
    .then(results => {
      console.log('\n--- HermiT Results (via ROBOT) ---');
      console.log('| Ontology | Exp. | JVM+Parse | HermiT Reason | Fill+Write | Wall | Inferred |');
      console.log('|---|---|---|---|---|---|---|');
      for (const c of results) {
        const r = c.result;
        if (r.error) {
          console.log(`| ${c.name} | ${c.expressiveness} | — | — | — | ${r.error} | — |`);
          continue;
        }
        const fmtMs = v => v != null ? `${v} ms` : '—';
        console.log(`| ${c.name} | ${c.expressiveness} | ${fmtMs(r.jvmParseMs)} | ${fmtMs(r.reasonMs)} | ${fmtMs(r.fillWriteMs)} | ${fmtMs(r.wallMs)} | ${r.inferredTriples ?? '—'} |`);
      }
    })
    .catch(e => { console.error(e); process.exit(1); });
}
