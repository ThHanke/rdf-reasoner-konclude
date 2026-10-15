import { defineConfig } from 'vitest/config';
import { BaseSequencer } from 'vitest/node';
import type { WorkspaceSpec } from 'vitest/node';

class HeavyLast extends BaseSequencer {
  override async sort(files: WorkspaceSpec[]): Promise<WorkspaceSpec[]> {
    const sorted = await super.sort(files);
    const isHeavy = (f: WorkspaceSpec) =>
      f.moduleId.includes('roberts-family') ||
      f.moduleId.includes('explanation-persistence') ||
      f.moduleId.includes('explanation-perf') ||
      f.moduleId.includes('hierarchy-determinism');
    const heavy = sorted.filter(isHeavy);
    const rest  = sorted.filter(f => !isHeavy(f));
    return [...rest, ...heavy];
  }
}

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/browser/**'],
    setupFiles: ['tests/setup.ts'],
    // Each test file creates a WASM Worker that spawns pthreads; running files
    // concurrently saturates the pthread pool (PTHREAD_POOL_SIZE=8) and causes
    // random deadlocks in heavy fixtures (roberts-family, GALEN).
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    reporters: ['verbose', 'json'],
    outputFile: '/tmp/vitest-last.json',
    sequence: {
      sequencer: HeavyLast,
    },
  },
});
