import { defineConfig } from "vite";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // Serve from project root so /dist/** and /ts/** are both accessible.
  root: ROOT,
  // Vite's entry for browser test navigation.
  appType: "mpa",

  resolve: {
    // ts/worker.ts imports "./konclude.mjs" — the WASM module lives in dist/.
    // Map the relative import to the absolute project path so Vite serves
    // dist/konclude.mjs instead of trying to find ts/konclude.mjs.
    alias: [
      {
        find: /^\.\/konclude\.mjs$/,
        replacement: path.join(ROOT, "dist/konclude.mjs"),
      },
    ],
    // Allow .ts/.js/.mjs imports without explicit extensions.
    extensions: [".ts", ".tsx", ".js", ".mjs"],
  },

  plugins: [
    {
      name: "coop-coep-headers",
      configureServer(server) {
        // SharedArrayBuffer (required by WASM pthreads) is gated on
        // cross-origin isolation — both headers must be present.
        server.middlewares.use((_, res, next) => {
          res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
          res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
          next();
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
  },

  // Treat .wasm as a static asset served as-is.
  assetsInclude: ["**/*.wasm"],
});
