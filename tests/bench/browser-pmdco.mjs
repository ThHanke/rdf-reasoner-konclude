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
for (let i = 0; i < runs; i++) {
  const browser = await chromium.launch({ ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}), args: process.env.CHROME_ARGS ? process.env.CHROME_ARGS.split(' ') : [] });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('pageerror', e.message));
  await page.goto(`http://localhost:${port}/`);
  const cdp = await browser.newBrowserCDPSession();
  const procTimes = async () => { const { processInfo } = await cdp.send('SystemInfo.getProcessInfo'); let u = 0, k = 0; const fs = await import('node:fs'); for (const p of processInfo.filter((x) => x.type === 'renderer')) { try { const f = fs.readFileSync(`/proc/${p.id}/stat`, 'utf8'); const t = f.slice(f.lastIndexOf(')') + 2).split(' '); u += Number(t[11]) / 100; k += Number(t[12]) / 100; } catch {} } return { u, k }; };
  const cpuOf = async () => { const { processInfo } = await cdp.send('SystemInfo.getProcessInfo'); return processInfo.filter((p) => p.type === 'renderer').reduce((a, p) => a + p.cpuTime, 0); };
  const out = { hw: await page.evaluate(() => navigator.hardwareConcurrency) };
  const c0 = await cpuOf(); const pt0 = await procTimes();
  const res = await page.evaluate(async () => {
    const { RdfReasoner } = await import('/dist/index.js');
    const { DataFactory, Parser, Store } = await import('/n3-shim.js');
    const text = await (await fetch('/fixture.nt')).text();
    const store = new Store(new Parser({ format: 'N-Triples' }).parse(text));
    const reasoner = new RdfReasoner(); await reasoner.ready;
    const t0 = performance.now();
    const ok = await reasoner.checkConsistency(store);
    const t1 = performance.now();
    const inferredGraph = DataFactory.namedNode('urn:test:inferred');
    await reasoner.materialize(store, { includeClassHierarchy: true, inferredGraph, returnDelta: true });
    const t2 = performance.now();
    reasoner.terminate();
    return { ok, cons: Math.round(t1 - t0), mat: Math.round(t2 - t1), total: Math.round(t2 - t0) };
  });
  const c1 = await cpuOf(); const pt1 = await procTimes();
  console.log(JSON.stringify({ ...res, rendererCpuS: +(c1 - c0).toFixed(1), userS: +(pt1.u - pt0.u).toFixed(1), sysS: +(pt1.k - pt0.k).toFixed(1), hw: out.hw }));
  await browser.close();
}
srv.close(); process.exit(0);
