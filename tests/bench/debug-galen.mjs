import { readFileSync } from 'fs';

async function run() {
  const { default: createModule } = await import('../../dist/konclude.mjs');
  const mod = await createModule();
  const r = new mod.KoncludeReasoner();

  const galen = readFileSync(new URL('../fixtures/galen.nt', import.meta.url), 'utf8');
  console.log('Loading GALEN...');
  r.loadNTriples(galen);
  console.log('Classifying GALEN...');
  try {
    const ok = r.classify();
    console.log('classify ok:', ok);
    const out = r.getInferredNTriples();
    console.log('triples:', out.split('\n').filter(Boolean).length);
  } catch (e) {
    console.error('CAUGHT:', String(e));
    console.error('STACK:', e.stack);
  }
}
run().catch(e => { console.error('TOP:', String(e)); console.error(e.stack); });
