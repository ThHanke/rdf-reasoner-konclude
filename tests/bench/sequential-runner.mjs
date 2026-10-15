// Sequential-call stability benchmark (not part of bench.mjs; run by hand).
// usage: CHANGE=1 node tests/bench/sequential-runner.mjs <repoRoot> <fixture.nt> <N>
//   CHANGE=1  add one distinct axiom per call so every call recomputes (the self-invalidating
//             API skips unchanged content, so CHANGE=0 only measures the digest check).
// Reports per call: wall ms, result quad count (must stay constant), process RSS.
// Run against another checkout (e.g. a main worktree with dist/ built + dist/worker-node.mjs) for A/B.
import { Worker as NW } from "node:worker_threads";
const ROOT = process.argv[2];
class Shim { constructor(){ this._w=new NW(ROOT+"/dist/worker-node.mjs"); this._m=new Map(); }
 postMessage(m){this._w.postMessage(m)}
 addEventListener(t,fn){ const w = t==="message"?d=>fn({data:d}):t==="error"?e=>fn({message:e?.message??String(e)}):fn; this._m.set(fn,w); this._w.on(t,w);}
 removeEventListener(t,fn){const w=this._m.get(fn); if(w) this._w.off(t,w);}
 terminate(){this._w.terminate()} }
globalThis.Worker = Shim;
// usage: node seq.mjs <repoRoot> <fixture.nt> <N>
import { createRequire } from "node:module";
import fs from "node:fs";
const [root, fx, n] = process.argv.slice(2);
const { RdfReasoner } = await import(root + "/dist/index.js");
const N3 = (await import(root + "/node_modules/n3/lib/index.js")).default;
const store = new N3.Store(new N3.Parser({format:"N-Triples"}).parse(fs.readFileSync(fx,"utf8")));
const r = new RdfReasoner();
const out=[];
for (let i=1;i<=+n;i++){
  const s = new N3.Store(store.getQuads(null,null,null,null));
  if (process.env.CHANGE==="1") s.addQuad(N3.DataFactory.quad(N3.DataFactory.namedNode("http://bench.example/C"+i),N3.DataFactory.namedNode("http://www.w3.org/2000/01/rdf-schema#subClassOf"),N3.DataFactory.namedNode("http://www.w3.org/2002/07/owl#Thing")));
  const t=Date.now();
  let res;
  try { await Promise.race([r.materialize(s,{}), new Promise((_,j)=>setTimeout(()=>j(new Error("TIMEOUT 150s")),150000))]); res="ok"; }
  catch(e){ res="FAIL "+String(e.message).slice(0,80); }
  out.push({call:i,ms:Date.now()-t,quads:s.size,res,rssMB:Math.round(process.memoryUsage().rss/1e6)});
  console.log(JSON.stringify(out.at(-1)));
  if(res!=="ok") break;
}
r.terminate(); process.exit(0);
