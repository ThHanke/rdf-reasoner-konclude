import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/browser",
  timeout: 120_000,
  use: {
    headless: true,
    baseURL: "http://localhost:5173",
  },
  webServer: {
    // Vite dev server: resolves n3 from node_modules, handles COOP/COEP,
    // and aliases ./konclude.mjs → dist/konclude.mjs inside the worker bundle.
    command:
      "npx vite --config vite.browser-test.config.ts",
    url: "http://localhost:5173/tests/browser/index.html",
    reuseExistingServer: !process.env.CI,
    stdout: "pipe",
    timeout: 30_000,
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
