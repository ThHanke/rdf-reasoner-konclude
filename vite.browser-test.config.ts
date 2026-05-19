import { defineConfig } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const KONCLUDE_MJS = path.join(ROOT, "dist/konclude.mjs");

export default defineConfig({
  // Serve from project root so /dist/** and /ts/** are both accessible.
  root: ROOT,
  // Vite's entry for browser test navigation.
  appType: "mpa",

  plugins: [
    {
      name: "browser-test-setup",
      configureServer(server) {
        // ── COOP/COEP required for SharedArrayBuffer (WASM pthreads) ──
        server.middlewares.use((_req, res, next) => {
          res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
          res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
          next();
        });

        // ── Serve dist/konclude.mjs as raw JS ──────────────────────────
        // Vite's import-analysis plugin rewrites `import('module')` to a
        // browser-external stub.  In the browser, `typeof process` is
        // 'undefined' so the ternary short-circuits — BUT other Vite
        // transforms (HMR injection, process polyfill, etc.) alter the
        // Emscripten module in ways that can break pthreads communication.
        // Serving it raw (before Vite's transform pipeline) gives the
        // browser the exact file that was patched by npm run patch-wasm.
        // configureServer middleware runs BEFORE Vite's transformMiddleware.
        server.middlewares.use("/dist/konclude.mjs", (_req, res) => {
          res.setHeader("Content-Type", "application/javascript");
          res.setHeader("Cache-Control", "no-store");
          const stream = fs.createReadStream(KONCLUDE_MJS);
          stream.on('error', (e) => console.error('[konclude-err]', e.message));
          stream.pipe(res);
        });
      },
    },
  ],

  server: {
    port: 5173,
    strictPort: true,
    // Allow Vite to serve files from anywhere in the project tree.
    fs: { allow: [ROOT] },
  },

  optimizeDeps: {
    // Don't let Vite pre-bundle the large Emscripten WASM glue module.
    exclude: ["dist/konclude.mjs"],
    // Force Vite to pre-bundle buffer so n3's `import { Buffer } from 'buffer'`
    // gets a proper ESM module with named exports (not raw CJS).
    include: ["buffer"],
  },

  // Treat .wasm as a static asset served as-is.
  assetsInclude: ["**/*.wasm"],
});
