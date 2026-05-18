/**
 * Type declarations for the Emscripten-generated Konclude WASM module.
 *
 * The actual `konclude.mjs` + `konclude.wasm` files are built via Emscripten
 * and are not checked into the repository.  This stub lets TypeScript resolve
 * the import in `ts/worker.ts` without requiring the build artefact to be
 * present at type-check time.
 */

export interface KoncludeReasonerInstance {
  loadTripleBuffer(triplePtr: number, tripleCount: number, strTablePtr: number, strTableLen: number): void;
  classify(): boolean;
  isConsistent(): boolean;
  buildInferredTripleBuffer(): number;
  getInferredTripleBufferPtr(): number;
  reset(): void;
  /** Release Embind-managed C++ memory. Must be called when done. */
  delete(): void;
}

export interface KoncludeModule {
  KoncludeReasoner: new () => KoncludeReasonerInstance;
  HEAPU8: Uint8Array;
  _malloc(size: number): number;
  _free(ptr: number): void;
}

/** Factory function returned by the Emscripten-generated ES module. */
declare function createKoncludeModule(): Promise<KoncludeModule>;
export default createKoncludeModule;
