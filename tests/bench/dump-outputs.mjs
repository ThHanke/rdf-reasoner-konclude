import createKoncludeModule from '../../dist/konclude.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../fixtures');

const Module = await createKoncludeModule();

for (const [name, files, out] of [
  ['lubm',    ['lubm.nt'], 'lubm-wasm-out.nt'],
  ['roberts', ['roberts-family.nt'], 'roberts-wasm-out.nt'],
  ['galen',   ['galen.nt'], 'galen-wasm-out.nt'],
]) {
  const r = new Module.KoncludeReasoner();
  for (const f of files) r.loadNTriples(readFileSync(join(FIXTURES, f), 'utf8'));
  r.classify();
  const result = r.getInferredNTriples();
  r.delete();
  writeFileSync(join(FIXTURES, out), result);
  console.log(name, result.split('\n').filter(l=>l.trim()).length, 'triples');
}
