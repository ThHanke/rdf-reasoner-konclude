// tests/smoke/smoke.mjs
import createKoncludeModule from '../../dist/konclude.mjs';

const NTriples_3class = `
<http://example.org/A> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#Class> .
<http://example.org/B> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#Class> .
<http://example.org/C> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#Class> .
<http://example.org/A> <http://www.w3.org/2000/01/rdf-schema#subClassOf> <http://example.org/B> .
<http://example.org/B> <http://www.w3.org/2000/01/rdf-schema#subClassOf> <http://example.org/C> .
`.trim();

async function main() {
  const Module = await createKoncludeModule();
  const reasoner = new Module.KoncludeReasoner();

  try {
    reasoner.loadNTriples(NTriples_3class);

    const ok = reasoner.classify();
    if (!ok) {
      console.error('classify() returned false');
      process.exit(1);
    }

    const inferred = reasoner.getInferredNTriples();
    console.log('Inferred NTriples:\n' + inferred);

    const hasASubC = inferred.includes('<http://example.org/A>') &&
                     inferred.includes('<http://example.org/C>') &&
                     inferred.includes('subClassOf');

    if (!hasASubC) {
      console.error('FAIL: A subClassOf C not found in inferred triples');
      console.error('Got:', inferred);
      process.exit(1);
    }

    console.log('PASS: A subClassOf C correctly inferred');
    reasoner.delete();
  } catch (e) {
    console.error('Error:', e);
    reasoner.delete();
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
