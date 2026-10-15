/**
 * Web Worker entry point for the Konclude OWL-DL reasoner.
 *
 * Lifecycle:
 *   1. On module load: eagerly calls `createKoncludeModule()` → `initPromise`
 *   2. After init: posts `{type:'ready'}` to the main thread
 *   3. On each incoming message: awaits initPromise, dispatches to the
 *      `KoncludeReasoner` instance, posts `{id, result}` or `{id, error}`
 *
 * The `KoncludeReasoner` instance is stateful within a single Worker lifetime:
 *   sync → classification | realization (→ getInferredTripleBuffer or consistency)
 *   C++ detects content changes itself; no reset between calls.
 */

// At runtime this file lives in `dist/` alongside `dist/konclude.mjs`.
// The module is mocked in unit tests (see tests/unit/worker.test.ts).
import createKoncludeModule, {
  type KoncludeModule,
  type KoncludeReasonerInstance,
} from "./konclude.mjs";

// ---------------------------------------------------------------------------
// Message shape types
// ---------------------------------------------------------------------------

/** A request sent from the main thread to this Worker. */
export interface WorkerRequest {
  id: number;
  method: string;
  args: unknown[];
}

/** A response posted back from this Worker to the main thread. */
export interface WorkerResponse {
  id: number;
  result?: unknown;
  error?: string;
  /** WASM linear memory size after a classification/realization call (never shrinks). */
  heapBytes?: number;
}

/** Posted once after the WASM module finishes loading. */
export interface WorkerReadyMessage {
  type: "ready";
}

/** Posted if the WASM module fails to load. */
export interface WorkerInitErrorMessage {
  type: "error";
  error: string;
}

// ---------------------------------------------------------------------------
// Eager initialisation
// ---------------------------------------------------------------------------

const initPromise: Promise<KoncludeModule> = createKoncludeModule({ print: (msg: string) => self.postMessage({ type: "log", msg }), printErr: (msg: string) => self.postMessage({ type: "log", msg }) })
  .then((mod) => {
    self.postMessage({ type: "ready" } as WorkerReadyMessage);
    return mod;
  })
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    self.postMessage({ type: "error", error: message } as WorkerInitErrorMessage);
    throw err;
  });

// ---------------------------------------------------------------------------
// Per-worker stateful reasoner instance
// ---------------------------------------------------------------------------

let _reasoner: KoncludeReasonerInstance | null = null;

function getOrCreateReasoner(mod: KoncludeModule): KoncludeReasonerInstance {
  if (_reasoner === null) {
    _reasoner = new mod.KoncludeReasoner();
  }
  return _reasoner;
}


/** Header sanity of a combined result buffer: [strTableLen:u32][termCount:u32 …]. */
function plausibleResult(buf: Uint8Array): boolean {
  if (buf.byteLength < 8) return false;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const strTableLen = dv.getUint32(0, true);
  if (strTableLen < 4 || 4 + strTableLen > buf.byteLength) return false;
  return 4 + 4 * dv.getUint32(4, true) <= strTableLen;
}

/**
 * Build a result buffer and copy it out of the WASM heap. Under memory pressure the copy has been
 * observed to read foreign heap data (implausible header) — rebuild and re-read in that case.
 */
function readResult(mod: KoncludeModule, reasoner: KoncludeReasonerInstance, build: () => number): Uint8Array | null {
  for (let attempt = 0; attempt < 4; attempt++) {
    const len = build();
    if (len <= 0) return null;
    const ptr = reasoner.getInferredTripleBufferPtr() >>> 0; // wasm32 pointers above 2 GiB come back negative from Embind int
    // HEAPU8.buffer may be a SharedArrayBuffer — slice() copies to a plain AB
    // so it can be transferred (postMessage transfer requires non-shared AB).
    const plain = mod.HEAPU8.slice(ptr, ptr + len);
    if (plausibleResult(plain)) return plain;
    self.postMessage({ type: "log", msg: `{warn} result buffer header implausible (attempt ${attempt + 1}, len=${len}, ptr=${ptr}); rebuilding` });
  }
  throw new Error("result buffer corrupt after retries");
}

// ---------------------------------------------------------------------------
// Message dispatch
// ---------------------------------------------------------------------------

/**
 * Handle a single `WorkerRequest`, dispatching to the appropriate
 * `KoncludeReasoner` method.
 *
 * Exported for unit-test access (tests import and call this directly instead
 * of spinning up a real Worker thread).
 */
export async function handleMessage(
  event: MessageEvent<WorkerRequest>,
): Promise<void> {
  const { id, method, args } = event.data;

  let result: unknown;
  try {
    const mod = await initPromise;
    if (method === "sync" || method === "loadTripleBuffer" || method === "classification" || method === "realization" || method === "consistency") {
      // Let the event loop deliver pending pthread cleanup messages of the previous call
      // before a blocking call starts; the main thread cannot process them while blocked.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    const reasoner = getOrCreateReasoner(mod);

    switch (method) {
      // "sync" (alias "loadTripleBuffer", legacy name): hand the store content to C++, which decides by itself
      // whether it changed (digest compare) and rebuilds lazily at the next classification/realization.
      case "sync":
      case "loadTripleBuffer": {
        const r = getOrCreateReasoner(mod);
        const tripleAB = args[0] as ArrayBuffer;
        const strTableAB = args[1] as ArrayBuffer;

        const tripleCount = tripleAB.byteLength / 12; // 3 × u32 per triple
        const tripleBytes = tripleAB.byteLength;
        const strBytes = strTableAB.byteLength;
        const triplePtr = mod._malloc(tripleBytes);
        const strTablePtr = mod._malloc(strBytes);
        let rc: number;
        try {
          mod.HEAPU8.set(new Uint8Array(tripleAB), triplePtr);
          mod.HEAPU8.set(new Uint8Array(strTableAB), strTablePtr);
          rc = r.syncTripleBuffer(triplePtr, tripleCount, strTablePtr, strBytes);
        } finally {
          mod._free(triplePtr);
          mod._free(strTablePtr);
        }
        if (rc < 0) throw new Error("sync: invalid triple/string-table buffers");
        result = {
          changed: rc === 1,
          added: rc === 1 ? r.lastSyncAdded() : 0,
          removed: rc === 1 ? r.lastSyncRemoved() : 0,
          generation: r.generation(),
        };
        break;
      }
      case "classification": {
        result = reasoner.classification();
        if (reasoner.stalled?.()) throw new Error("KONCLUDE_STALLED");
        break;
      }
      case "realization": {
        result = reasoner.realization();
        if (reasoner.stalled?.()) throw new Error("KONCLUDE_STALLED");
        break;
      }
      case "consistency": {
        result = reasoner.consistency();
        break;
      }
      case "getInferredTripleBuffer": {
        const withExplanations = (args[0] as boolean) ?? false;
        const plain = readResult(mod, reasoner, () => reasoner.buildInferredTripleBuffer(withExplanations));
        if (plain) {
          const response: WorkerResponse = { id, result: plain.buffer };
          self.postMessage(response, [plain.buffer]);
          return;
        }
        // Empty result — 8-byte combined buffer: [strTableLen=4][count=0]
        const empty = new ArrayBuffer(8);
        new DataView(empty).setUint32(0, 4, true);
        const emptyResponse: WorkerResponse = { id, result: empty };
        self.postMessage(emptyResponse, [empty]);
        return;
      }
      case "getPropertyTripleBuffer": {
        const withExplanations = (args[0] as boolean) ?? false;
        const plain = readResult(mod, reasoner, () => reasoner.buildPropertyTripleBuffer(withExplanations));
        if (plain) {
          const response: WorkerResponse = { id, result: plain.buffer };
          self.postMessage(response, [plain.buffer]);
          return;
        }
        // Empty result — 8-byte combined buffer: [strTableLen=4][count=0]
        const empty = new ArrayBuffer(8);
        new DataView(empty).setUint32(0, 4, true);
        const emptyResponse: WorkerResponse = { id, result: empty };
        self.postMessage(emptyResponse, [empty]);
        return;
      }
      case "syncStats": {
        result = { generation: reasoner.generation(), rebuilds: reasoner.rebuildCount(), triples: reasoner.tripleCount() };
        break;
      }
      case "getUnsatisfiableClassBuffer": {
        result = reasoner.buildUnsatisfiableClassBuffer();
        break;
      }
      case "isSubClassOf": {
        result = reasoner.isSubClassOf(args[0] as string, args[1] as string);
        break;
      }
      case "isInstanceOf": {
        result = reasoner.isInstanceOf(args[0] as string, args[1] as string);
        break;
      }
      case "isSatisfiableClass": {
        result = reasoner.isSatisfiableClass(args[0] as string);
        break;
      }
      case "getSubClassJustification": {
        result = reasoner.getSubClassJustification(args[0] as string, args[1] as string);
        break;
      }
      case "hasNativeJustification": {
        result = reasoner.hasNativeJustification(args[0] as string, args[1] as string);
        break;
      }
      case "getAxiomsForConceptTag": {
        result = reasoner.getAxiomsForConceptTag(args[0] as number);
        break;
      }
      case "getAxiomsForRoleTag": {
        result = reasoner.getAxiomsForRoleTag(args[0] as number);
        break;
      }
      case "getJustificationByType": {
        result = reasoner.getJustificationByType(args[0] as string, args[1] as string, args[2] as number);
        break;
      }
      case "hasJustificationByType": {
        result = reasoner.hasJustificationByType(args[0] as string, args[1] as string, args[2] as number);
        break;
      }
      default: {
        const response: WorkerResponse = {
          id,
          error: `Unknown method: ${method}`,
        };
        self.postMessage(response);
        return;
      }
    }

    const response: WorkerResponse = { id, result };
    if (method === "classification" || method === "realization") response.heapBytes = mod.HEAPU8.byteLength;
    self.postMessage(response);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const response: WorkerResponse = { id, error: message };
    self.postMessage(response);
  }
}

// Wire up the global onmessage handler.
self.onmessage = handleMessage;
