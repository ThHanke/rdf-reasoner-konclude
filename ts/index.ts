/**
 * Main thread TypeScript wrapper for the Konclude OWL-DL reasoner.
 *
 * `RdfReasoner` is the public API. It spawns a Web Worker running the WASM
 * reasoning kernel and exposes:
 *   - `ready` — resolves when the Worker has finished loading the WASM module
 *   - `reason(quads, opts?)` — runs OWL-DL inference over the input quads
 *   - `classify(quads)` — alias for reason(quads, {mode:'classify'})
 *   - `checkConsistency(quads)` — checks whether the ontology is consistent
 *   - `terminate()` — terminates the underlying Worker
 *
 * Named graphs in the input quads are silently dropped (NTriples is
 * triple-only). All returned quads are placed in the DefaultGraph.
 */

import type { Quad } from "@rdfjs/types";
import { Store, DataFactory } from "n3";
import { encodeToBuffers, decodeBuffers } from "./intern.js";

export type { ReasoningOptions, ReasoningResult, StoreReasoningOptions } from "./types.js";
export { INFERRED_GRAPH_IRI } from "./types.js";
import type { ReasoningOptions, StoreReasoningOptions } from "./types.js";
import { INFERRED_GRAPH_IRI } from "./types.js";

// ---------------------------------------------------------------------------
// Internal message types (mirroring ts/worker.ts)
// ---------------------------------------------------------------------------

interface WorkerRequest {
  id: number;
  method: string;
  args: unknown[];
}

interface WorkerResponse {
  id: number;
  result?: unknown;
  error?: string;
}

interface WorkerReadyMessage {
  type: "ready";
}

interface WorkerInitErrorMessage {
  type: "error";
  error: string;
}

type WorkerInboundMessage =
  | WorkerReadyMessage
  | WorkerInitErrorMessage
  | WorkerResponse;

// ---------------------------------------------------------------------------
// RdfReasoner
// ---------------------------------------------------------------------------

export class RdfReasoner {
  /** Resolves when the Worker WASM module is ready; rejects on init failure. */
  readonly ready: Promise<void>;

  private readonly worker: Worker;
  private nextId = 0;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (reason: unknown) => void }
  >();

  /**
   * Serialization queue: each reason() / checkConsistency() call chains onto
   * this promise so that concurrent calls never interleave their
   * loadTripleBuffer → classify → getInferredTripleBuffer sequences.
   */
  private _queue: Promise<void> = Promise.resolve();

  constructor() {
    this.worker = new Worker(new URL("./worker.js", import.meta.url), {
      type: "module",
    });

    // Store the readyReject handle so the onerror handler can use it if the
    // Worker crashes before posting {type:'ready'}.
    let readyReject!: (reason: Error) => void;
    let readySettled = false;

    this.ready = new Promise<void>((resolve, reject) => {
      readyReject = reject;
      const onInit = (event: MessageEvent<WorkerInboundMessage>) => {
        const msg = event.data;
        if ("type" in msg) {
          if (msg.type === "ready") {
            this.worker.removeEventListener("message", onInit);
            readySettled = true;
            resolve();
          } else if (msg.type === "error") {
            this.worker.removeEventListener("message", onInit);
            readySettled = true;
            reject(new Error(msg.error));
          }
        }
      };
      this.worker.addEventListener("message", onInit);
    });

    // Route all subsequent (non-init) messages to the pending-call map.
    this.worker.addEventListener(
      "message",
      (event: MessageEvent<WorkerInboundMessage>) => {
        const msg = event.data;
        // Skip init-lifecycle messages (handled by the one-shot listener above).
        if ("type" in msg) return;

        const response = msg as WorkerResponse;
        const entry = this.pending.get(response.id);
        if (!entry) return;
        this.pending.delete(response.id);

        if (response.error !== undefined) {
          entry.reject(new Error(response.error));
        } else {
          entry.resolve(response.result);
        }
      },
    );

    // Handle Worker crashes: reject ready (if still pending) and drain all
    // pending calls so their callers get a meaningful rejection instead of
    // hanging forever.
    this.worker.addEventListener("error", (event: ErrorEvent) => {
      const err = new Error(event.message ?? "Worker error");
      if (!readySettled) {
        readySettled = true;
        readyReject(err);
      }
      for (const entry of this.pending.values()) {
        entry.reject(err);
      }
      this.pending.clear();
    });
  }

  /**
   * Send a method call to the Worker and return a Promise for the result.
   * Pass `transfer` to transfer ownership of ArrayBuffers (zero-copy).
   */
  private _call(method: string, args: unknown[], transfer?: Transferable[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      const request: WorkerRequest = { id, method, args };
      if (transfer && transfer.length > 0) {
        this.worker.postMessage(request, transfer);
      } else {
        this.worker.postMessage(request);
      }
    });
  }

  // -------------------------------------------------------------------------
  // reason()
  // -------------------------------------------------------------------------

  /** Run OWL-DL reasoning over a Store. Inferred triples are written into
   *  `opts.inferredGraph` (default `INFERRED_GRAPH_IRI`). The graph is cleared
   *  before each call. Concurrent calls are serialized. */
  reason(store: Store, opts?: StoreReasoningOptions): Promise<void>;
  /**
   * @deprecated Use `reason(store)` instead.
   *
   * Run OWL-DL reasoning over the provided quads.
   *
   * Named graphs in the input are dropped (NTriples wire format is
   * triple-only). All returned quads are in the DefaultGraph.
   *
   * Concurrent calls are serialized: each call waits for the previous one to
   * complete before sending its first Worker message.
   */
  reason(quads: Iterable<Quad>, opts?: ReasoningOptions): Promise<Quad[]>;
  reason(
    input: Store | Iterable<Quad>,
    opts?: StoreReasoningOptions | ReasoningOptions,
  ): Promise<void> | Promise<Quad[]> {
    if (input instanceof Store) {
      return this._reasonOnStore(input, opts as StoreReasoningOptions | undefined);
    }
    return this._reasonOnQuads(input as Iterable<Quad>, opts as ReasoningOptions | undefined);
  }

  private _reasonOnStore(store: Store, opts?: StoreReasoningOptions): Promise<void> {
    const result = this._queue.then(async () => {
      const inferredGraphNode = DataFactory.namedNode(
        opts?.inferredGraph ?? INFERRED_GRAPH_IRI,
      );
      store.removeQuads(store.getQuads(null, null, null, inferredGraphNode));

      const { tripleBuffer, strTableBuffer } = encodeToBuffers(store.getQuads(null, null, null, null));

      await this._call("loadTripleBuffer", [tripleBuffer, strTableBuffer], [tripleBuffer, strTableBuffer]);
      await this._call("classify", []);

      const resultBuf = (await this._call("getInferredTripleBuffer", [])) as ArrayBuffer;
      const inferredQuads = decodeBuffers(resultBuf);

      for (const q of inferredQuads) {
        store.addQuad(
          DataFactory.quad(q.subject, q.predicate, q.object, inferredGraphNode),
        );
      }
    });
    this._queue = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  private _reasonOnQuads(quads: Iterable<Quad>, opts?: ReasoningOptions): Promise<Quad[]> {
    const result = this._queue.then(async () => {
      const mode = opts?.mode ?? "classify";

      const { tripleBuffer, strTableBuffer } = encodeToBuffers(quads);

      await this._call("loadTripleBuffer", [tripleBuffer, strTableBuffer], [tripleBuffer, strTableBuffer]);
      await this._call("classify", []);

      if (mode === "consistency") {
        // Consistency mode: no inferred quads are returned via reason().
        // Callers wanting a boolean should use checkConsistency().
        return [];
      }

      // "classify" and "full" both retrieve inferred triples.
      const resultBuf = (await this._call("getInferredTripleBuffer", [])) as ArrayBuffer;
      return decodeBuffers(resultBuf);
    });
    // Swallow errors so a failed call doesn't stall the queue for subsequent
    // callers; each caller still receives the rejection on their own promise.
    this._queue = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  // -------------------------------------------------------------------------
  // classify()
  // -------------------------------------------------------------------------

  /** Classify a Store (alias for `reason(store)`). */
  classify(store: Store, opts?: StoreReasoningOptions): Promise<void>;
  /**
   * @deprecated Use `classify(store)` instead.
   *
   * Classify the given quads (alias for `reason(quads, { mode: 'classify' })`).
   *
   * Returns the inferred rdfs:subClassOf quads in the default graph.
   */
  classify(quads: Iterable<Quad>): Promise<Quad[]>;
  classify(
    input: Store | Iterable<Quad>,
    opts?: StoreReasoningOptions,
  ): Promise<void> | Promise<Quad[]> {
    if (input instanceof Store) {
      return this.reason(input, opts);
    }
    return this.reason(input as Iterable<Quad>, { mode: "classify" });
  }

  // -------------------------------------------------------------------------
  // checkConsistency()
  // -------------------------------------------------------------------------

  /** Check consistency of a Store. Does not write inferred triples. */
  checkConsistency(store: Store): Promise<boolean>;
  /**
   * @deprecated Use `checkConsistency(store)` instead.
   *
   * Check whether the given quads form a consistent ontology.
   *
   * Internally: loadTripleBuffer → classify → isConsistent.
   *
   * Concurrent calls are serialized: each call waits for the previous one to
   * complete before sending its first Worker message.
   */
  checkConsistency(quads: Iterable<Quad>): Promise<boolean>;
  checkConsistency(input: Store | Iterable<Quad>): Promise<boolean> {
    const quads = input instanceof Store
      ? input.getQuads(null, null, null, null)
      : input;
    const result = this._queue.then(async () => {
      const { tripleBuffer, strTableBuffer } = encodeToBuffers(quads);
      await this._call("loadTripleBuffer", [tripleBuffer, strTableBuffer], [tripleBuffer, strTableBuffer]);
      await this._call("classify", []);
      return (await this._call("isConsistent", [])) as boolean;
    });
    this._queue = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  /** Terminate the underlying Worker and reject all pending calls. */
  terminate(): void {
    this.worker.terminate();
    const err = new Error("Worker terminated");
    for (const entry of this.pending.values()) {
      entry.reject(err);
    }
    this.pending.clear();
  }
}
