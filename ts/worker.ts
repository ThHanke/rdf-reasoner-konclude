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
 *   loadNTriples → classify (→ getInferredNTriples)
 *
 * Call `.delete()` (via the `reset` method) when the caller is finished to
 * release Embind-managed C++ memory.
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

const initPromise: Promise<KoncludeModule> = createKoncludeModule()
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

function destroyReasoner(): void {
  if (_reasoner !== null) {
    _reasoner.delete();
    _reasoner = null;
  }
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
    const reasoner = getOrCreateReasoner(mod);

    switch (method) {
      case "loadNTriples": {
        const ntriples = args[0] as string;
        reasoner.loadNTriples(ntriples);
        result = true;
        break;
      }
      case "classify": {
        result = reasoner.classify();
        break;
      }
      case "isConsistent": {
        result = reasoner.isConsistent();
        break;
      }
      case "getInferredNTriples": {
        result = reasoner.getInferredNTriples();
        break;
      }
      case "reset": {
        destroyReasoner();
        result = true;
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
    self.postMessage(response);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const response: WorkerResponse = { id, error: message };
    self.postMessage(response);
  }
}

// Wire up the global onmessage handler.
self.onmessage = handleMessage;
