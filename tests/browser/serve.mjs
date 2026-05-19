#!/usr/bin/env node
// Minimal static HTTP server for browser integration tests.
// Serves the repo root with Cross-Origin-Opener-Policy and
// Cross-Origin-Embedder-Policy headers so that SharedArrayBuffer
// (required by WASM pthreads) is available in the page.
import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { join, extname, resolve } from "node:path";

const ROOT = resolve(process.cwd());
const PORT = parseInt(process.env.BROWSER_TEST_PORT ?? "4173", 10);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".wasm": "application/wasm",
  ".nt": "text/plain",
};

createServer((req, res) => {
  const urlPath = new URL(req.url ?? "/", `http://localhost:${PORT}`).pathname;
  const normalized = urlPath === "/" ? "/tests/browser/index.html" : urlPath;
  const filePath = join(ROOT, normalized);

  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end(`Not Found: ${normalized}`);
    return;
  }

  const headers = {
    "Content-Type": MIME[extname(filePath)] ?? "application/octet-stream",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cache-Control": "no-store",
  };

  res.writeHead(200, headers);
  createReadStream(filePath).pipe(res);
}).listen(PORT, () => {
  process.stdout.write(`Test server ready on http://localhost:${PORT}\n`);
});
