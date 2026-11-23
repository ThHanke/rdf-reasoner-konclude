// tests/bench/swrl-bench.mjs — materialize() with and without DL-safe SWRL rules on a generated part-of tree.
// usage: node tests/bench/swrl-bench.mjs [--materials 300] [--runs 3] [--root <checkout>] [--nofire]
// --nofire: same rules, but their bodies never match (rules present, nothing derived): the cost of detection + one matching pass.
// Data: ternary part-of tree of materials with three qualities each; rules
//   R1 Quality(d) ^ hasCharacteristic(e,d) -> hasQuality(e,d)
//   R2 hasQuality(e,d) ^ partOf(e,m)       -> hasQuality(m,d)   (one tree level per productive round)
// Prints median ms per variant (fresh reasoner per run) and lastSwrl (rules, unsupported, rounds, derived).
// Baseline recorded 2026-11-23 on the adopt/pr18-folded-patches build: see docs/solutions/ SWRL entry once written.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Parser, Store } = require('n3');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i < 0 ? d : process.argv[i + 1]; };
const M = Number(arg('--materials', 300)), RUNS = Number(arg('--runs', 3));
const root = path.resolve(arg('--root', path.join(path.dirname(new URL(import.meta.url).pathname), '../..')));
const { RdfReasoner } = await import(pathToFileURL(path.join(root, 'dist/index.node.mjs')).href);

const PRE = `@prefix swrl: <http://www.w3.org/2003/11/swrl#> . @prefix ex: <http://ex.org/> . @prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .\n`;
let ttl = PRE + `ex:Quality a owl:Class . ex:Material a owl:Class . ex:Hard a owl:Class ; rdfs:subClassOf ex:Quality .
ex:hasCharacteristic a owl:ObjectProperty ; rdfs:domain ex:Material ; rdfs:range ex:Quality .
ex:hasQuality a owl:ObjectProperty ; rdfs:domain ex:Material ; rdfs:range ex:Quality .
ex:partOf a owl:ObjectProperty ; rdfs:domain ex:Material ; rdfs:range ex:Material .
ex:HardMaterial a owl:Class ; owl:equivalentClass [ a owl:Restriction ; owl:onProperty ex:hasQuality ; owl:someValuesFrom ex:Hard ] .\n`;
let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
for (let i = 0; i < M; i++) {
  ttl += `ex:m${i} a ex:Material .\n`;
  if (i > 0) ttl += `ex:m${i} ex:partOf ex:m${Math.floor((i - 1) / 3)} .\n`;
  for (let k = 0; k < 3; k++) { const q = `ex:q${i}_${k}`; ttl += `${q} a ${rnd() < 0.3 ? 'ex:Hard' : 'ex:Quality'} . ex:m${i} ex:hasCharacteristic ${q} .\n`; }
}
const rules = `ex:e a swrl:Variable . ex:d a swrl:Variable . ex:m a swrl:Variable .
[ a swrl:Imp ; swrl:body ( [ a swrl:ClassAtom ; swrl:classPredicate ex:Quality ; swrl:argument1 ex:d ]
    [ a swrl:IndividualPropertyAtom ; swrl:propertyPredicate ex:hasCharacteristic ; swrl:argument1 ex:e ; swrl:argument2 ex:d ] ) ;
  swrl:head ( [ a swrl:IndividualPropertyAtom ; swrl:propertyPredicate ex:hasQuality ; swrl:argument1 ex:e ; swrl:argument2 ex:d ] ) ] .
[ a swrl:Imp ; swrl:body ( [ a swrl:IndividualPropertyAtom ; swrl:propertyPredicate ex:hasQuality ; swrl:argument1 ex:e ; swrl:argument2 ex:d ]
    [ a swrl:IndividualPropertyAtom ; swrl:propertyPredicate ex:partOf ; swrl:argument1 ex:e ; swrl:argument2 ex:m ] ) ;
  swrl:head ( [ a swrl:IndividualPropertyAtom ; swrl:propertyPredicate ex:hasQuality ; swrl:argument1 ex:m ; swrl:argument2 ex:d ] ) ] .\n`;
const NOFIRE = process.argv.includes('--nofire');
const rulesUsed = NOFIRE ? rules.replace(/ex:hasCharacteristic/g,'ex:neverAsserted').replace(/ex:partOf ; swrl:argument1 ex:e/g,'ex:neverAsserted2 ; swrl:argument1 ex:e') : rules;
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
async function run(withRules) {
  const ms = []; let last;
  for (let i = 0; i < RUNS; i++) {
    const r = new RdfReasoner(); await r.ready;
    const store = new Store(new Parser().parse(withRules ? ttl + rulesUsed : ttl));
    const t0 = performance.now(); await r.materialize(store); ms.push(Math.round(performance.now() - t0));
    last = r.lastSwrl; r.terminate();
  }
  return { median: median(ms), all: ms, swrl: last };
}
console.log(`${M} materials, ${M * 3} qualities, ${RUNS} runs each, root ${root}`);
const a = await run(false), b = await run(true);
console.log(`without rules: median ${a.median} ms  runs ${a.all.join(' ')}`);
console.log(`with 2 rules : median ${b.median} ms  runs ${b.all.join(' ')}`);
console.log(`lastSwrl: ${JSON.stringify(b.swrl)}   ratio ${(b.median / a.median).toFixed(1)}x`);
process.exit(0);
