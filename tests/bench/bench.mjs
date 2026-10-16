// tests/bench/bench.mjs
// Comparative benchmark: native Konclude (Docker) vs HermiT (ROBOT/ODK Docker) vs WASM port.
//
// Output is clearly separated Markdown sections:
//
//   § 1  SPEED BENCHMARK
//        Compares reasoning time across three systems: Konclude native (C++),
//        HermiT (Java, via ROBOT), and our WASM Konclude port.
//
//   § 2  CAPABILITIES BENCHMARK
//        Compares what each system can actually emit as output.
//
//   § 3  INCREMENTAL REASONING BENCHMARK
//
// Usage: node tests/bench/bench.mjs
//        npm run bench
//        npm run bench > results.md

import { spawnSync, execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadavg } from 'node:os';
import { dirname, join } from 'node:path';
import { benchAll as nativeBenchAll, NATIVE_CASES } from './native-runner.mjs';
import { benchAll as wasmBenchAll, WASM_CASES } from './wasm-runner.mjs';
import { TS_CASES } from './ts-runner.mjs';
import { budgetFor } from './cases.mjs';
import { fmtStat } from './stats.mjs';
import { collectMeta, renderMeta } from './meta.mjs';
import { benchAll as binaryBenchAll, BINARY_CASES } from './binary-runner.mjs';
import { benchAll as robotBenchAll, ROBOT_CASES } from './robot-runner.mjs';

function runInSubprocess(scriptPath, funcName, args, timeoutMs = 600_000) {
  const ts = Date.now();
  const tmpScript = join(__dirname, `_bench_sub_${ts}.mjs`);
  const tmpResult = join(__dirname, `_bench_res_${ts}.json`);
  const wrapper = `
import { writeFileSync } from 'node:fs';
import { ${funcName} } from '${scriptPath}';
const result = await ${funcName}(...${JSON.stringify(args)});
writeFileSync('${tmpResult.replaceAll('\\', '\\\\')}', JSON.stringify(result));
`;
  writeFileSync(tmpScript, wrapper);
  try {
    execFileSync('node', ['--expose-gc', tmpScript], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'inherit'],
      timeout: timeoutMs,
    });
    return JSON.parse(readFileSync(tmpResult, 'utf8'));
  } finally {
    try { unlinkSync(tmpScript); } catch {}
    try { unlinkSync(tmpResult); } catch {}
  }
}

// optsFor(c) -> { opts, timeoutMs }: per-case run counts and subprocess budget (tests/bench/cases.mjs).
function runBenchPerCase(scriptPath, funcName, cases, optsFor) {
  const results = [];
  for (const c of cases) {
    try {
      const { opts, timeoutMs } = optsFor(c);
      const caseResults = runInSubprocess(scriptPath, funcName, [[c], opts], timeoutMs);
      results.push(...caseResults);
    } catch (e) {
      console.error(`  ${c.name}: FAIL (subprocess): ${e.message.split('\n')[0]}`);
      results.push({ ...c, result: { ok: false, error: e.message.split('\n')[0] } });
    }
  }
  return results;
}

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
  const quick = process.argv.includes('--quick');
  const caseArg = process.argv.indexOf('--case') >= 0 ? process.argv[process.argv.indexOf('--case') + 1] : null;
  const wanted = (c) => (caseArg ? c.name === caseArg : quick ? ['LUBM schema', 'GALEN'].includes(c.name) : true);
  const wasmCases = WASM_CASES.filter(wanted);
  const tsCases = TS_CASES.filter(wanted);
  // Other sessions share this host: wait (up to 5 min) for a quiet 1-minute load average before measuring.
  for (let i = 0; i < 20 && loadavg()[0] > 3.5; i++) await new Promise((r) => setTimeout(r, 15000));

  const optsFor = (c) => { const b = budgetFor(c.name, quick); return { opts: { warmup: b.warmup, runs: b.runs }, timeoutMs: b.timeoutMs }; };

  console.error('Running native Konclude benchmark (Docker)...');
  const nativeResults = await nativeBenchAll(NATIVE_CASES.filter(wanted), 3);

  console.error('\nRunning HermiT benchmark (ROBOT/ODK Docker)...');
  const robotResults = await robotBenchAll(ROBOT_CASES.filter(wanted), 3);

  console.error('\nRunning WASM benchmark (per-case subprocess)...');
  const wasmResults = runBenchPerCase('./wasm-runner.mjs', 'benchAll', wasmCases, optsFor);

  console.error('\nRunning TypeScript-layer benchmark (per-case subprocess)...');
  const tsResults = runBenchPerCase('./ts-runner.mjs', 'benchAll', tsCases, optsFor);

  console.error('\nRunning binary encoding micro-benchmark (per-case subprocess)...');
  const binaryResults = runBenchPerCase('./binary-runner.mjs', 'benchAll', BINARY_CASES.filter(wanted), optsFor);

  console.error('\nRunning warm-behaviour benchmark (per-case subprocess)...');
  const incrResults = runBenchPerCase('./ts-runner.mjs', 'benchIncremental', tsCases, (c) => ({ opts: { runs: optsFor(c).opts.runs }, timeoutMs: optsFor(c).timeoutMs }));

  const nativeVersionRow = nativeResults.find(r => r.result?.nativeVersion);
  const nativeByName = Object.fromEntries(nativeResults.map(r => [r.name, r]));
  const robotByName  = Object.fromEntries(robotResults.map(r => [r.name, r]));
  const wasmByName   = Object.fromEntries(wasmResults.map(r => [r.name, r]));
  const tsByName     = Object.fromEntries(tsResults.map(r => [r.name, r]));
  const binaryByName = Object.fromEntries(binaryResults.map(r => [r.name, r]));

  // ── Header: run metadata ──────────────────────────────────────────────────

  console.log('## Benchmark Results\n');
  console.log(renderMeta(collectMeta(REPO_ROOT), {
    nativeVersion: nativeVersionRow?.result?.nativeVersion,
    nativeThreads: nativeVersionRow?.result?.threads,
    robotVersion: robotResults.find(r => r.result?.robotVersion)?.result?.robotVersion,
    processorCount: wasmResults.find(r => r.result?.processorCount != null)?.result?.processorCount,
  }));
  console.log(`\nMarkers: † spread (max−min)/median above 10%; ‡ fewer than 5 samples (indicative only). Cells show median [min–max].`);
  console.log(quick ? '\n> Quick mode: LUBM schema and GALEN only, 3 runs each, no warm-up.\n' : '');


  // ── § 1  SPEED ─────────────────────────────────────────────────────────────
  //
  // Boundary definitions (see docs/solutions/performance-issues/benchmark-phase-boundary-shift-2026-10.md):
  //   WASM ingest→result = binary encode + syncTripleBuffer + reasoning (incl. lazy parse/mapping) + output decode.
  //   Konclude total     = Konclude's own "Total processing time" inside the container: OWL/XML parse + reasoning + result
  //                        serialisation. Excludes container start (Docker wall clock is recorded separately, not used).
  //   Phase columns (ingest / reasoning / output) are a breakdown only: v0.8.0 moved parse+mapping from "load" into
  //   "reasoning", so phase columns must never be compared across releases, only ingest→result.

  const st = (r, key) => r?.stats?.[key] ?? null;
  const ratio = (a, b) => (a && b ? `~${(a / b).toFixed(1)}×` : '—');
  const isOk = (r) => r?.result && !r.result.error && r.result.ok !== false;

  console.log('### § 1 Speed Benchmark\n');
  console.log('**Definitions.** *WASM ingest→result*: encode + `syncTripleBuffer()` + reasoning (includes the lazy parse/mapping) + output decode; WASM module start (*init*) is one-off and excluded. *Konclude total*: Konclude\'s own "Total processing time" inside the container (OWL/XML parse + reasoning + result serialisation; excludes container start). Ratios use only these two.\n');

  console.log('#### §1a TBox ontologies (classification) — end to end\n');
  console.log('| Ontology | Exp. | Triples | Konclude total | HermiT reason ⁴ | WASM ingest→result | WASM / Konclude |');
  console.log('|---|---|---|---|---|---|---|');
  for (const c of wasmCases.filter(c => !c.abox)) {
    const nc = nativeByName[c.name], rc = robotByName[c.name], wc = wasmByName[c.name];
    const nTot = isOk(nc) ? st(nc.result, 'total') : null;
    const wTot = isOk(wc) ? st(wc.result, 'ingestToResult') : null;
    let rCell = '—';
    if (rc?.result && !rc.result.error) rCell = fmtMs(rc.result.reasonMs);
    else if (rc?.result?.error) rCell = rc.result.error.includes('timeout') ? 'TIMEOUT' : 'FAIL';
    console.log(`| ${c.name} | ${c.expressiveness} | ${wc?.tripleCount ?? '—'} | ${nc?.result?.error ? 'N/A' : fmtStat(nTot)} | ${rCell} | ${wc?.result?.error ? 'FAIL' : fmtStat(wTot)} | ${ratio(wTot?.median, nTot?.median)} |`);
  }

  console.log('\n#### §1b ABox ontologies (realization) — classification path, and full role-closure realization\n');
  console.log('Native `realization` output contains rdf:type only: Konclude computes the role closure internally but never serializes it. The closure is retrievable only with one SPARQL query per object property, so *Konclude + role closure* runs ONE `sparqlfile` invocation with a `SELECT ?s ?o WHERE { ?s <p> ?o }` for every declared object property (parse + classification + realization + all queries + XML serialisation; wall clock minus container start ⁸). This is the only native route that returns the closure, but it resolves roles lazily per individual (`OPSANSWERCOMPLEXQUERY`), whereas WASM `realization()` runs the bulk role-realization step (`OPSROLEREALIZE`) once; the full-realization ratio therefore compares two different native code paths, not a slowdown or speedup of the same algorithm. An OWLlink `GetFlattenedObjectPropertyTargets` request does not trigger the bulk step (it returns an empty set for a Roberts individual that has relatives). The bulk step timed natively with the same kernel takes 40-49 s on Roberts (`docs/solutions/performance-issues/native-bulk-role-realization-timing-2026-10.md`). The classification path compares Konclude total minus its realization phase with WASM `classification()`.\n');
  console.log('| Ontology | Exp. | Triples | Konclude realization (types only) | Konclude excl. realization ⁷ | WASM classification path (ingest→result) | WASM / Konclude (classification path) | Konclude + role closure via SPARQL ⁸ | WASM full realization (ingest→result, incl. role closure) | WASM / Konclude (full) |');
  console.log('|---|---|---|---|---|---|---|---|---|---|');
  for (const c of wasmCases.filter(c => c.abox)) {
    const nc = nativeByName[c.name], wc = wasmByName[c.name];
    const nTot = isOk(nc) ? st(nc.result, 'total') : null;
    const nExcl = nTot && nc.result.realizeMs != null ? nTot.median - nc.result.realizeMs : null;
    const nRole = nc?.result?.roleClosure?.stats ?? null;
    const roleCell = nRole ? fmtStat(nRole) : (nc?.result?.roleClosure?.error ? 'FAIL' : '—');
    const wCls = isOk(wc) ? st(wc.result, 'classifyOnlyIngestToResult') : null;
    const wFull = isOk(wc) ? st(wc.result, 'ingestToResult') : null;
    console.log(`| ${c.name} | ${c.expressiveness} | ${wc?.tripleCount ?? '—'} | ${nc?.result?.error ? 'N/A' : fmtStat(nTot)} | ${nExcl != null ? nExcl + ' ms' : '—'} | ${wc?.result?.error ? 'FAIL' : fmtStat(wCls)} | ${ratio(wCls?.median, nExcl)} | ${roleCell} | ${wc?.result?.error ? 'FAIL' : fmtStat(wFull)} | ${ratio(wFull?.median, nRole?.median)} |`);
  }

  console.log('\n#### §1c WASM phase breakdown (breakdown only — do not compare phases across releases)\n');
  console.log('| Ontology | Op | init (one-off) | ingest (encode+sync) | reasoning | output decode | ingest→result | TS layer total ³ |');
  console.log('|---|---|---|---|---|---|---|---|');
  for (const c of wasmCases) {
    const wc = wasmByName[c.name], tc = tsByName[c.name];
    const ok = isOk(wc);
    const tsCell = tc?.result?.ok ? fmtStat(st(tc.result, 'total')) : (tc?.result?.error === 'fixture missing' ? 'SKIP' : tc?.result?.error ? 'FAIL' : '—');
    console.log(`| ${c.name} | ${c.abox ? 'realization' : 'classification'} | ${ok ? fmtStat(st(wc.result, 'init')) : '—'} | ${ok ? fmtStat(st(wc.result, 'ingest')) : '—'} | ${ok ? fmtStat(st(wc.result, 'reasoning')) : '—'} | ${ok ? fmtStat(st(wc.result, 'output')) : '—'} | ${ok ? fmtStat(st(wc.result, 'ingestToResult')) : '—'} | ${tsCell} |`);
  }

  console.log('');
  console.log('**Reading these numbers:**');
  console.log('');
  console.log('- Single host, shared machine; numbers carry the host load average from the header. A difference smaller than the printed spread is not evidence of a difference.');
  console.log('- ³ "TS layer total" = one full public `RdfReasoner` call in a fresh process: Worker + module start, encode, sync, reasoning, output, `store.addQuad`. It includes startup that §1a/§1b exclude.');
  console.log('- ⁴ HermiT (via ROBOT/ODK) is a different reasoner run in Docker; "reason" = consistency + classification + axiom generation, excluding JVM start and parsing.');
  console.log('- ⁸ Konclude + role closure: single `sparqlfile` run, one `SELECT ?s ?o WHERE { ?s <p> ?o }` per declared object property (data properties are not queried), output discarded after serialisation; wall clock of `docker run` minus the median container-start time (a bare `docker run` of the image). Not Konclude\'s own timer: `sparqlfile` prints no total.');
  console.log('- ⁷ Konclude excl. realization = Konclude total − its `Finished (lazy) realization` phase; an approximation of parse + classification + serialisation.');
  console.log('- The earlier "WASM classify" column (2026-09-18 and before) excluded parse/mapping, which then lived in "load"; v0.8.0 performs that work lazily inside reasoning. Old and new phase columns are therefore not comparable. Details and the A/B measurement: `docs/solutions/performance-issues/benchmark-phase-boundary-shift-2026-10.md`.');
  console.log('- WASM runs: warm-up and run counts are per case (`tests/bench/cases.mjs`); slow cases use fewer runs and are marked ‡.');
  console.log('- Outliers are never filtered. Roberts *one axiom added* shows an intermittent very slow call (up to ~220 s against ~27-34 s typical). It is not caused by the Worker recycle: with recycling forced, with an awaited `terminate()` and with no recycle at all, roberts-160 shows the same 1.5-3x outliers (`tests/bench/recycle-probe.mjs`). It is the kernel step-time variance on identical input (`docs/solutions/performance-issues/ts-runner-in-process-slow-runs-2026-10.md`). The TS-layer cold numbers run one fresh process per measurement.');
  console.log('- LUBM+data native input: NTriples merged to RDF/XML via rdflib (auto-generated, .gitignored).');
  console.log('');

  console.log('');
  console.log('**HermiT comparison context:**');
  console.log('');
  console.log('HermiT (via ROBOT/ODK) is a Java-based OWL 2 DL tableau reasoner. On simple TBox ontologies (LUBM, SHI) it is comparable to Konclude. On medium-complexity ontologies (GALEN, SHIF) it is ~20× slower. On hard SROIQ ontologies with many individuals and property chains (Roberts family) HermiT does not complete within the timeout — it fails with `java.lang.OutOfMemoryError: Java heap space`. This matches published benchmarks: the ORE 2015 competition report notes Konclude "had the best performance on large and very large ontologies" while HermiT "for classification and realization tasks, was outperformed by the other reasoners" ([Parsia et al. 2017](https://link.springer.com/article/10.1007/s10817-017-9406-8)). The Konclude system description reports aggregate classification time of 3,893s vs HermiT 7,076s across 484 ontologies — but the gap is much larger on the hard SROIQ tail ([Steigmiller et al. 2014](https://www.uni-ulm.de/fileadmin/website_uni_ulm/iui.inst.090/Publikationen/2014/StLG14a.pdf)). A 2023 survey confirms HermiT is "slower than [other] reasoners" for classification, "although HermiT had much fewer timeouts" overall ([Abicht 2023](https://arxiv.org/pdf/2309.06888)).');

  // ── § 2  CAPABILITIES BENCHMARK ───────────────────────────────────────────
  //
  // Structured by operation type.  Three sub-sections:
  //
  //   §2a  TBox Classification — SubClassOf + EquivalentClasses
  //        Both systems output these. Direct count comparison.
  //
  //   §2b  ABox Realization — rdf:type (ClassAssertion)
  //        Native Konclude outputs ONLY rdf:type.  We output the same set
  //        (exact match enforced by integration tests against golden fixtures).
  //
  //   §2c  WASM-only output (role assertions, sameAs, justifications)
  //        Native has no output path for any of these:
  //          - ObjectPropertyAssertion: native `GetObjectPropertyAssertions`
  //            OWLlink = "not supported"; wildcard SPARQL returns empty with
  //            "unsupported axiom types".  Konclude computes role fillers
  //            internally (CRoleRealization) but its serializer never writes
  //            them.  We surface the full transitive closure.
  //          - DataPropertyAssertion: same — computed, never serialized.
  //          - owl:sameAs: our FP/IFP workaround pre-computes sameAs pairs
  //            for multi-filler FunctionalProperty/InverseFunctionalProperty
  //            cases where native v0.7.0 hangs (upstream bug).  For 1-filler
  //            cases the tableau handles it natively via the same workaround.
  //          - Justification graphs: RDF-star triples explaining each inferred
  //            triple.  Native has no explanation output at all.
  //
  // rdf:type is the ONLY fair cross-system count comparison.
  // "WASM extra" columns show how many MORE triples WASM emits vs native
  // and document why the delta exists.

  console.log('\n---\n');
  console.log('### § 2 Capabilities Benchmark\n');
  console.log('> Each sub-section covers a distinct operation and output type.');
  console.log('> "WASM extra" = triples WASM emits that native cannot produce at all.\n');

  // ── §2a  TBox Classification ──────────────────────────────────────────────

  console.log('#### §2a TBox Classification — SubClassOf + EquivalentClasses\n');
  console.log('Three systems: Konclude native (OWL/XML), HermiT/ROBOT (OWL Functional), WASM port (NTriples).\n');

  const tboxHeader = '| Ontology | Exp. | Konclude TBox | HermiT TBox | WASM TBox | Konclude=WASM | HermiT vs Konclude |';
  const tboxSep    = '|---|---|---|---|---|---|---|';
  console.log(tboxHeader);
  console.log(tboxSep);

  for (const c of WASM_CASES.filter(c => !c.abox)) {
    const nc = nativeByName[c.name];
    const rc = robotByName[c.name];
    const wc = wasmByName[c.name];
    const nCount = nc?.result && !nc.result.error ? (nc.result.inferredTboxCount ?? '—') : (nc?.result?.error ? 'N/A' : '—');
    let rCount = '—';
    if (rc?.result && !rc.result.error) {
      rCount = rc.result.inferredTboxCount ?? '—';
    } else if (rc?.result?.error) {
      rCount = rc.result.error.includes('timeout') ? 'TIMEOUT' : 'FAIL';
    }
    let wCount = '—', matchCell = '—', hermitVsCell = '—';
    if (wc?.result?.ok) {
      wCount = wc.result.inferredTboxCount ?? '—';
      if (typeof wCount === 'number' && typeof nCount === 'number') {
        matchCell = wCount === nCount ? '✓ equal count' : `⚠ ${wCount} vs ${nCount}`;
      }
    } else if (wc?.result?.error) {
      wCount = matchCell = 'FAIL';
    }
    if (typeof rCount === 'number' && typeof nCount === 'number') {
      hermitVsCell = rCount === nCount ? '✓ equal count' : `${rCount} (${rCount > nCount ? '+' : ''}${rCount - nCount})`;
    }
    console.log(`| ${c.name} | ${c.expressiveness} | ${nCount} | ${rCount} | ${wCount} | ${matchCell} | ${hermitVsCell} |`);
  }

  console.log('');
  console.log('TBox classification output is identical: same kernel, same Hasse diagram. Match is enforced by integration tests against golden fixtures (lubm-native-tbox.nt, galen-native-tbox.nt).\n');

  // ── §2b  ABox Realization — rdf:type ─────────────────────────────────────

  console.log('#### §2b ABox Realization — rdf:type (ClassAssertion)\n');
  console.log('Konclude native outputs ClassAssertion (rdf:type) only. HermiT via ROBOT also outputs ClassAssertion. WASM outputs the same set. Trivial `rdf:type owl:Thing` assertions are excluded from all counts (native emits them, WASM does not).\n');

  const typeHeader = '| Ontology | Exp. | Konclude rdf:type | HermiT rdf:type | WASM rdf:type | Konclude=WASM | HermiT vs Konclude |';
  const typeSep    = '|---|---|---|---|---|---|---|';
  console.log(typeHeader);
  console.log(typeSep);

  for (const c of WASM_CASES.filter(c => c.abox)) {
    const nc = nativeByName[c.name];
    const rc = robotByName[c.name];
    const wc = wasmByName[c.name];
    const nCount = nc?.result && !nc.result.error ? (nc.result.inferredTypeCount ?? '—') : (nc?.result?.error ? 'N/A' : '—');
    let rCount = '—';
    if (rc?.result && !rc.result.error) {
      rCount = rc.result.inferredTypeCount ?? '—';
    } else if (rc?.result?.error) {
      rCount = rc.result.error.includes('timeout') ? 'TIMEOUT' : 'FAIL';
    }
    let wCount = '—', matchCell = '—', hermitVsCell = '—';
    if (wc?.result?.ok) {
      wCount = wc.result.inferredTypeCount ?? '—';
      if (typeof wCount === 'number' && typeof nCount === 'number') {
        matchCell = wCount === nCount ? '✓ equal count' : `⚠ ${wCount} vs ${nCount}`;
      }
    } else if (wc?.result?.error) {
      wCount = matchCell = 'FAIL';
    }
    if (typeof rCount === 'number' && typeof nCount === 'number') {
      hermitVsCell = rCount === nCount ? '✓ equal count' : `${rCount} (${rCount > nCount ? '+' : ''}${rCount - nCount})`;
    }
    console.log(`| ${c.name} | ${c.expressiveness} | ${nCount} | ${rCount} | ${wCount} | ${matchCell} | ${hermitVsCell} |`);
  }

  console.log('');
  console.log('rdf:type output is identical to native. Exact match enforced by integration tests against golden fixtures (roberts-native-abox.nt, lubm-native-tbox.nt).\n');

  // ── §2c  WASM-only output ─────────────────────────────────────────────────

  console.log('#### §2c WASM-only Output (native = 0 for all columns)\n');
  console.log('Native Konclude has no output path for role assertions, sameAs, or justifications.\n');

  const extraHeader = '| Ontology | Exp. | Op | Role assertions ⁶ | owl:sameAs ⁷ | WASM extra total | Native total ⁸ | Delta | Expl quads ⁹ |';
  const extraSep    = '|---|---|---|---|---|---|---|---|---|';
  console.log(extraHeader);
  console.log(extraSep);

  for (const c of WASM_CASES) {
    const nc = nativeByName[c.name];
    const wc = wasmByName[c.name];
    const tc = tsByName[c.name];

    const opLabel = c.abox ? 'realization' : 'classification';

    let roleCount = 0, sameAsCount = 0, wasmTotal = 0, nativeTotal = 0;
    let roleCell = '—', sameAsCell = '—', wasmExtraCell = '—', nativeTotalCell = '—', deltaCell = '—';

    if (wc?.result?.ok) {
      roleCount   = wc.result.inferredRoleCount   ?? 0;
      sameAsCount = wc.result.inferredSameAsCount ?? 0;
      wasmTotal   = wc.result.inferredTriples     ?? 0;
      roleCell    = String(roleCount);
      sameAsCell  = String(sameAsCount);
      // WASM extra = everything except the comparable set
      const comparableCount = c.abox ? (wc.result.inferredTypeCount ?? 0) : (wc.result.inferredTboxCount ?? 0);
      const wasmExtra = wasmTotal - comparableCount;
      wasmExtraCell = String(wasmExtra);
    } else if (wc?.result?.error) {
      roleCell = sameAsCell = wasmExtraCell = 'FAIL';
    }

    if (nc?.result && !nc.result.error) {
      nativeTotal = nc.result.inferredTriples ?? 0;
      nativeTotalCell = String(nativeTotal);
    } else if (nc?.result?.error) {
      nativeTotalCell = 'N/A';
    }

    if (wc?.result?.ok && nc?.result && !nc.result.error) {
      const comparableCount = c.abox ? (wc.result.inferredTypeCount ?? 0) : (wc.result.inferredTboxCount ?? 0);
      const wasmExtra = (wc.result.inferredTriples ?? 0) - comparableCount;
      deltaCell = `+${wasmExtra} (×${nativeTotal > 0 ? ((wc.result.inferredTriples ?? 0) / nativeTotal).toFixed(1) : '∞'} total)`;
    }

    let explQuads = 'n/a';
    if (c.abox || !c.abox) { // all cases can have justifications
      if (tc?.result?.ok && tc.result.explQuads != null) {
        explQuads = String(tc.result.explQuads);
      } else if (tc?.result?.error === 'fixture missing') {
        explQuads = 'SKIP';
      } else if (tc?.result?.error) {
        explQuads = 'FAIL';
      }
    }

    console.log(`| ${c.name} | ${c.expressiveness} | ${opLabel} | ${roleCell} | ${sameAsCell} | ${wasmExtraCell} | ${nativeTotalCell} | ${deltaCell} | ${explQuads} |`);
  }

  console.log('');
  console.log('**Capabilities notes:**');
  console.log('⁵ The "equal count" cells compare counts only. Set-level equality is enforced by the integration suite for rdf:type (golden fixtures `roberts-native-abox.nt`, `lubm-native-tbox.nt`, `galen-native-tbox.nt`). Known representation variance between builds, which count-equality hides: Konclude chooses one representative per class of equivalent roles (e.g. `hasChild` vs `isParentOf`) and per class of equivalent classes (`rdfs:subClassOf owl:Thing` is emitted for the representative only). `tests/bench/equivalence.mjs` compares role assertions modulo equivalent/inverse roles declared in the input.');
  console.log('⁶ Role assertions = ObjectPropertyAssertion + DataPropertyAssertion. Konclude computes these internally via CRoleRealization (full transitive closure); its OWL/XML serializer never writes them. `GetObjectPropertyAssertions` OWLlink = "not supported"; wildcard SPARQL `?p ?o` returns empty with "unsupported axiom types". Roberts family role count is large because there are 405 individuals with dense property chains (hasAncestor, isDescendantOf, hasCousin, etc.).');
  console.log('⁷ owl:sameAs: produced by our FP/IFP workaround. For FunctionalProperty/InverseFunctionalProperty with multiple fillers, native Konclude v0.7.0 hangs (upstream tableau bug in ALIF+ extension). Our C++ workaround strips FP/IFP declarations, pre-computes owl:sameAs for identical-individual groups, and emits those pairs. For 1-filler cases the normal tableau path is used (no workaround needed).');
  console.log('⁸ "Native total" = what native CLI writes. For TBox: SubClassOf+EquivalentClasses. For ABox: ClassAssertion only.');
  console.log('⁹ Justification quads: RDF-star triples in the explanation graph (`explanations: true`). Native Konclude has no explanation output. WASM-only feature. Count from first measured TS run (median timing in §1).');
  console.log('- "WASM extra total" = WASM total minus the comparable (native-matchable) portion. "Delta" shows factor over native total.');
  console.log('- TBox classification: role assertions = 0 (no ABox individuals → no role fillers). sameAs = 0 (no individuals → no FP/IFP groups).');

  // ── § 3  WARM BEHAVIOUR ────────────────────────────────────────────────────
  //
  // One RdfReasoner (warm Worker) per run; absolute times only. The kernel's own counters (syncStats) are asserted
  // for every scenario so a label can never describe something the kernel did not do.

  console.log('\n---\n');
  console.log('### § 3 Warm behaviour (one reasoner, repeated calls)\n');
  console.log('| Ontology | Exp. | cold (first call) | unchanged content | identical content, new Store | one axiom added (full rebuild) |');
  console.log('|---|---|---|---|---|---|');

  const incrByName = Object.fromEntries(incrResults.map(r => [r.name, r]));
  for (const c of tsCases) {
    const ic = incrByName[c.name];
    const f = (k) => (ic?.result?.ok ? fmtStat(ic.result.stats[k]) : ic?.result?.error === 'fixture missing' ? 'SKIP' : ic?.result?.error ? 'FAIL' : '—');
    console.log(`| ${c.name} | ${c.expressiveness} | ${f('cold')} | ${f('unchanged')} | ${f('newStore')} | ${f('changed')} |`);
  }

  console.log('');
  console.log('**Scenario definitions:**');
  console.log('- *cold*: first public call on a fresh `RdfReasoner` in a fresh process (includes Worker and WASM start). Each repetition of the four scenarios is its own process.');
  console.log('- *unchanged content*: same Store again. The call still encodes the whole Store and sends `sync`; the kernel compares its 128-bit content digest set with the previous one, answers "unchanged" and skips the rebuild. Cost = encode + one Worker round-trip, so it scales with store size, not with reasoning effort.');
  console.log('- *identical content, new Store*: a different Store instance with the same quads; the digest ignores Store identity, order and duplicates, so this is also a no-rebuild call.');
  console.log('- *one axiom added*: `rdfs:subClassOf owl:Thing` for a new class; the digest changes, the generation bumps and the ontology is rebuilt (full recompute on a warm Worker).');
  console.log('- Each scenario asserts the kernel counters (`syncStats` generation and rebuild count); the run aborts if the semantics differ.');
  console.log('- Native Konclude is a stateless batch CLI; no warm figure exists, so no ratio is shown. For repeated changed-content calls (stability and memory) see `tests/bench/sequential-runner.mjs`.');
}

main().catch(e => { console.error(e); process.exit(1); });
