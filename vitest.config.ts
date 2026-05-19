import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/browser/**'],
    setupFiles: ['tests/setup.ts'],
    // Each test file creates a WASM Worker that spawns pthreads; running files
    // concurrently saturates the pthread pool (PTHREAD_POOL_SIZE=8) and causes
    // random deadlocks in heavy fixtures (roberts-family, GALEN).
    fileParallelism: false,
  },
});
