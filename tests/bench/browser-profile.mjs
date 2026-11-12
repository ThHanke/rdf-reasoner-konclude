// tests/bench/browser-pmdco.mjs — Ontosphere sequence in Chromium, bare page, per package root.
// usage: node tests/bench/browser-pmdco.mjs <packageRoot> <fixture.nt> [runs]
// Serves <packageRoot>/dist at /dist/ (COOP/COEP set), n3 via UMD shim. Fresh browser per run. Prints one JSON line per run
// incl. renderer-process CPU seconds (all threads of the page's processes, from CDP SystemInfo.getProcessInfo).
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync, readFileSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { chromium } from 'playwright';
const [root, fixture, runsArg] = process.argv.slice(2);
const runs = Number(runsArg ?? 1);
const R = resolve(root);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm' };
const nt = readFileSync(fixture, 'utf8');
import { fileURLToPath } from 'node:url';
const n3umd = fileURLToPath(new URL('../../node_modules/n3/browser/n3.min.js', import.meta.url));
const html = `<!doctype html><script type="importmap">{"imports":{"n3":"/n3-shim.js"}}</script><script src="/n3.min.js"></script><body>`;
const shim = `const N=window.N3;export const DataFactory=N.DataFactory,Parser=N.Parser,Store=N.Store,Writer=N.Writer;`;
const srv = createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  const h = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': 'same-origin' };
  if (p === '/') { res.writeHead(200, { ...h, 'Content-Type': 'text/html' }); return res.end(html); }
  if (p === '/n3-shim.js') { res.writeHead(200, { ...h, 'Content-Type': 'text/javascript' }); return res.end(shim); }
  if (p === '/n3.min.js') { res.writeHead(200, { ...h, 'Content-Type': 'text/javascript' }); return createReadStream(n3umd).pipe(res); }
  if (p === '/fixture.nt') { res.writeHead(200, { ...h, 'Content-Type': 'text/plain' }); return res.end(nt); }
  const f = join(R, p);
  if (!f.startsWith(R) || !existsSync(f) || statSync(f).isDirectory()) { res.writeHead(404); return res.end('nf'); }
  res.writeHead(200, { ...h, 'Content-Type': MIME[extname(f)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
  createReadStream(f).pipe(res);
}).listen(0);
await new Promise((r) => srv.once('listening', r));
const port = srv.address().port;

const PORT = 9333;
const browser = await chromium.launch({ ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}), args: [`--remote-debugging-port=${PORT}`, ...(process.env.CHROME_ARGS ? process.env.CHROME_ARGS.split(' ') : [])] });
const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0; const pend = new Map(); const sessions = new Map(); // sessionId -> {type, url}
const send = (method, params = {}, sessionId) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })); });
ws.addEventListener('message', async (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result ?? m.error); pend.delete(m.id); return; }
  if (m.method === 'Runtime.consoleAPICalled') { globalThis.__cc = (globalThis.__cc ?? 0) + 1; if (!globalThis.__sample && (m.params.args?.[0]?.value ?? '').length) globalThis.__sample = String(m.params.args[0].value).slice(0, 100); const t = (m.params.args ?? []).map((a) => a.value ?? '').join(' '); if (t.includes('KONTHROWLAT')) { const mm = /n=(\d+)/.exec(t); const n = mm ? Number(mm[1]) : 0; if (n >= (globalThis.__lat?.n ?? 0)) globalThis.__lat = { n, t }; } }
  if (m.method === 'Target.attachedToTarget') {
    const sid = m.params.sessionId, t = m.params.targetInfo;
    sessions.set(sid, { type: t.type, url: t.url });
    await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sid);
    if (t.type === 'worker' || t.type === 'shared_worker') {
      await send('Profiler.enable', {}, sid); await send('Profiler.setSamplingInterval', { interval: 2000 }, sid); await send('Profiler.start', {}, sid);
    }
    await send('Runtime.enable', {}, sid);
    await send('Runtime.runIfWaitingForDebugger', {}, sid);
  }
});
await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
const page = await browser.newPage();
await page.goto(`http://localhost:${port}/`);
const res = await page.evaluate(async () => {
  const { RdfReasoner } = await import('/dist/index.js');
  const { DataFactory, Parser, Store } = await import('/n3-shim.js');
  const text = await (await fetch('/fixture.nt')).text();
  const store = new Store(new Parser({ format: 'N-Triples' }).parse(text));
  const reasoner = new RdfReasoner({ onTrace: (m) => { if (String(m).includes('KONTHROWLAT')) window.__lat = String(m); } }); await reasoner.ready;
  await new Promise((r) => setTimeout(r, 1500));
  const t0 = performance.now();
  const ok = await reasoner.checkConsistency(store);
  await reasoner.materialize(store, { includeClassHierarchy: true, inferredGraph: DataFactory.namedNode('urn:test:inferred'), returnDelta: true });
  return { ok, total: Math.round(performance.now() - t0), lat: window.__lat ?? null };
});
console.error('LATLOG', res.lat);
console.error('run', JSON.stringify(res), 'worker sessions', [...sessions.values()].filter((s) => s.type === 'worker').length);
const agg = new Map(); const parents = new Map(); let totalUs = 0; const perWorker = [];
for (const [sid, info] of sessions) {
  if (info.type !== 'worker') continue;
  const r = await send('Profiler.stop', {}, sid);
  const p = r?.profile; if (!p) continue;
  if (process.env.PROFDIR) { (await import('node:fs')).mkdirSync(process.env.PROFDIR, { recursive: true }); (await import('node:fs')).writeFileSync(`${process.env.PROFDIR}/w${perWorker.length}.json`, JSON.stringify(p)); }
  const nodes = new Map(p.nodes.map((n) => [n.id, n]));
  const parentOf = new Map(); for (const n of p.nodes) for (const c of n.children ?? []) parentOf.set(c, n.id);
  let wUs = 0;
  p.samples.forEach((nid, i) => { const d = p.timeDeltas[i] ?? 0; const n = nodes.get(nid); const name = (n.callFrame.functionName || '(anon)') + (n.callFrame.url && !n.callFrame.functionName ? ':' + n.callFrame.url.split('/').pop() : ''); agg.set(name, (agg.get(name) ?? 0) + d); wUs += d; if (name === '___cxa_throw' || name === '___resumeException' || name === '__cxa_throw' || name === '__cxa_rethrow') { let pid = parentOf.get(nid); let k = name + ' <- '; for (let h = 0; h < 4 && pid; h++) { const pn = nodes.get(pid); k += (pn.callFrame.functionName || '?').replace('Konclude::Reasoner::Kernel::Algorithm::CCalculationTableauCompletionTaskHandleAlgorithm::','TC::').slice(0, 150) + ' < '; pid = parentOf.get(pid); } parents.set(k, (parents.get(k) ?? 0) + d); } totalUs += d; });
  perWorker.push(wUs / 1e6);
}
const idle = ['(idle)', '(program)', '(garbage collector)'];
const rows = [...agg.entries()].sort((a, b) => b[1] - a[1]);
console.log('console events', globalThis.__cc ?? 0, 'sample:', globalThis.__sample ?? '-');
console.log('LAT', globalThis.__lat?.t ?? 'no KONTHROWLAT lines captured');
console.log('TOTAL sampled s (all workers, incl idle):', (totalUs / 1e6).toFixed(1), ' workers:', perWorker.length);
for (const [n, us] of rows.slice(0, Number(process.env.TOPN ?? 30))) console.log(((us / 1e6).toFixed(2) + 's').padStart(8), n);
console.log('--- throw/rethrow callers (self time of throw frames)'); for (const [k, us] of [...parents.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14)) console.log(((us / 1e6).toFixed(2) + 's').padStart(8), k);
await browser.close(); srv.close(); process.exit(0);
