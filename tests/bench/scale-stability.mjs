// Scale-stability test: generate family ontologies at increasing sizes,
// run each 5x, and report whether role counts are deterministic.
// Usage: node scale-stability.mjs
import { execSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseNTriples, encodeQuadsForWasm, decodeWasmTripleBuffer, countByCategory } from './wasm-binary.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODULE_PATH = join(__dirname, '../../dist/konclude.mjs');
const GEN_SCRIPT = join(__dirname, 'gen-family.mjs');

const { default: createModule } = await import(MODULE_PATH);

const SCALES = [
  { gens: 3, kids: 3 },  // ~26 individuals
  { gens: 4, kids: 3 },  // ~80 individuals
  { gens: 4, kids: 4 },  // ~170 individuals
  { gens: 5, kids: 3 },  // ~242 individuals
];

const RUNS = 5;

for (const { gens, kids } of SCALES) {
  const nt = execSync(`node ${GEN_SCRIPT} ${gens} ${kids}`, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
  const quads = parseNTriples(nt);
  const indivCount = nt.split('\n').filter(l => l.includes('NamedIndividual')).length;

  const roleCounts = [];
  const totals = [];
  for (let i = 0; i < RUNS; i++) {
    const Module = await createModule({ print: () => {}, printErr: () => {} });
    const reasoner = new Module.KoncludeReasoner();
    const { triplePtr, tripleCount, strTablePtr, strBytes } = encodeQuadsForWasm(Module, quads);
    try {
      reasoner.loadTripleBuffer(triplePtr, tripleCount, strTablePtr, strBytes, true);
    } finally {
      Module._free(triplePtr);
      Module._free(strTablePtr);
    }
    const ok = reasoner.realization();
    if (!ok) throw new Error(`realization() failed at g${gens}k${kids} run${i+1}`);
    const inferred = decodeWasmTripleBuffer(Module, reasoner);
    const counts = countByCategory(inferred);
    roleCounts.push(counts.roleCount);
    totals.push(counts.total);
    reasoner.delete();
  }

  const uniqueRoles = [...new Set(roleCounts)];
  const status = uniqueRoles.length === 1 ? 'DETERMINISTIC' : 'NONDET';
  console.log(`g${gens}k${kids} (${indivCount} indiv): ${status} role=${uniqueRoles.join(',')} total=${[...new Set(totals)].join(',')}`);

  if (uniqueRoles.length > 1) {
    console.log(`  → min=${Math.min(...roleCounts)} max=${Math.max(...roleCounts)} spread=${Math.max(...roleCounts)-Math.min(...roleCounts)}`);
  }
}
