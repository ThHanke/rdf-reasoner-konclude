/**
 * Main thread TypeScript wrapper for the Konclude OWL-DL reasoner.
 *
 * `RdfReasoner` is the public API. It spawns a Web Worker running the WASM
 * reasoning kernel and exposes:
 *   - `ready` — resolves when the Worker has finished loading the WASM module
 *   - `reason(quads, opts?)` — runs OWL-DL inference over the input quads
 *   - `classify(quads)` — alias for reason(quads, {mode:'classify'})
 *   - `checkConsistency(quads)` — checks whether the ontology is consistent
 *   - `terminate()` / `[Symbol.dispose]()` — terminates the underlying Worker
 *
 * **Lifecycle**: always call `terminate()` (or use `using` with TS 5.2+
 * Explicit Resource Management) when done. The Worker thread will not be
 * collected automatically by the JS garbage collector. A `FinalizationRegistry`
 * safety net terminates the Worker on GC if `terminate()` was not called, but
 * GC timing is non-deterministic — do not rely on it.
 *
 * Named graphs in the input quads are silently dropped (NTriples is
 * triple-only). All returned quads are placed in the DefaultGraph.
 */

import type { Quad } from "@rdfjs/types";
import { Store, DataFactory } from "n3";
import { encodeToBuffers, decodeBuffers } from "./intern.js";


export type { ReasoningOptions, ReasoningResult, StoreReasoningOptions, MaterializeOptions, MaterializeStoreOptions, ClassifyPropertiesStoreOptions, InferenceDelta, WhatIfOptions, ExplainOptions, ClassWarning, ValidationResult, ValidateOptions, RdfReasonerOptions, EntailmentResult, ExplainEntailmentOptions, LaconicPart, LaconicJustification, LaconicExplainOptions, Axiom, AxiomJustification, RepairOptions, Repair, RepairResult, Edit, DisjointPair, AssessEditOptions, EditAssessment, WeakenOptions, Weakening, WeakenResult, InconsistencyGuardOptions } from "./types.js";
export { INFERRED_GRAPH_IRI, HYPOTHETICAL_IRI, EXPLANATION_GRAPH_IRI, KJ_NS, KJ_JUSTIFICATION, KJ_JUSTIFIES, KJ_AXIOM } from "./types.js";
export { createInlineWorker } from "./inlineWorker.js";
export { createManagedStore } from "./n3Inject.js";
import type { ReasoningOptions, ReasoningResult, StoreReasoningOptions, MaterializeOptions, MaterializeStoreOptions, ClassifyPropertiesStoreOptions, InferenceDelta, WhatIfOptions, ExplainOptions, ClassWarning, ValidationResult, ValidateOptions, RdfReasonerOptions, EntailmentResult, ExplainEntailmentOptions, LaconicPart, LaconicJustification, LaconicExplainOptions, Axiom, AxiomJustification, RepairOptions, Repair, RepairResult, Edit, DisjointPair, AssessEditOptions, EditAssessment, WeakenOptions, Weakening, WeakenResult, InconsistencyGuardOptions } from "./types.js";
import { INFERRED_GRAPH_IRI, HYPOTHETICAL_IRI, EXPLANATION_GRAPH_IRI, KJ_JUSTIFIES, KJ_AXIOM, ReasonerStalledError, InconsistentOntologyError } from "./types.js";
export { ReasonerStalledError, InconsistentOntologyError } from "./types.js";
import { injectExplanationsFromBuffer, encodeStoreToBuffers, existsInSourceGraphs, clearGraph, createManagedStore, getRawStore, graphSignature } from "./n3Inject.js";
import { groupJustification, isDeclaration, partitionIntoUnits } from "./axiomGrouping.js";
import { dropAnnotationTriples } from "./annotations.js";
import { computeRepairs, REPAIR_DEFAULT_TIMEOUT_MS, type RepairOracle } from "./repair.js";
import { computeAssessment, probeQuads, PROBE_NS, type AssessOracle } from "./assessEdit.js";
import { computeWeakenings } from "./weaken.js";
import { buildEntailmentProbe, classifyAxiom, tripleKey as probeTripleKey } from "./entailmentProbe.js";
import { computeLaconicAsync, groupQuadsIntoAxioms, splitAxiom, axiomKey } from "./laconicJustification.js";

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
  heapBytes?: number;
}

interface WorkerReadyMessage {
  type: "ready";
}

interface WorkerInitErrorMessage {
  type: "error";
  error: string;
}

interface WorkerLogMessage {
  type: "log";
  msg: string;
}

type WorkerInboundMessage =
  | WorkerReadyMessage
  | WorkerInitErrorMessage
  | WorkerLogMessage
  | WorkerResponse;

// ---------------------------------------------------------------------------
// OWL/RDF predicate IRIs used by explain
// ---------------------------------------------------------------------------

const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const RDFS_SUB_CLASS_OF = "http://www.w3.org/2000/01/rdf-schema#subClassOf";
const RDFS_SUB_PROPERTY_OF = "http://www.w3.org/2000/01/rdf-schema#subPropertyOf";
const OWL_EQUIVALENT_CLASS = "http://www.w3.org/2002/07/owl#equivalentClass";
const OWL_CLASS = "http://www.w3.org/2002/07/owl#Class";
const OWL_OBJECT_PROPERTY = "http://www.w3.org/2002/07/owl#ObjectProperty";
const OWL_DATATYPE_PROPERTY = "http://www.w3.org/2002/07/owl#DatatypeProperty";
const OWL_ANNOTATION_PROPERTY = "http://www.w3.org/2002/07/owl#AnnotationProperty";
const OWL_ONTOLOGY = "http://www.w3.org/2002/07/owl#Ontology";
const RDFS_CLASS = "http://www.w3.org/2000/01/rdf-schema#Class";
const OWL_THING = "http://www.w3.org/2002/07/owl#Thing";
const OWL_NOTHING = "http://www.w3.org/2002/07/owl#Nothing";
const OWL_SAME_AS = "http://www.w3.org/2002/07/owl#sameAs";
const OWL_FUNCTIONAL_PROPERTY = "http://www.w3.org/2002/07/owl#FunctionalProperty";
const OWL_INVERSE_FUNCTIONAL_PROPERTY = "http://www.w3.org/2002/07/owl#InverseFunctionalProperty";
const RDFS_DOMAIN = "http://www.w3.org/2000/01/rdf-schema#domain";
const RDFS_RANGE = "http://www.w3.org/2000/01/rdf-schema#range";
const OWL_ON_PROPERTY = "http://www.w3.org/2002/07/owl#onProperty";
const OWL_SOME_VALUES_FROM = "http://www.w3.org/2002/07/owl#someValuesFrom";
const OWL_HAS_VALUE = "http://www.w3.org/2002/07/owl#hasValue";
const OWL_INVERSE_OF = "http://www.w3.org/2002/07/owl#inverseOf";
// ---------------------------------------------------------------------------
// RdfReasoner
// ---------------------------------------------------------------------------

// Module-level registry: terminates the Worker when an RdfReasoner is GC'd
// without an explicit terminate() call.  The held value is the Worker itself
// (a plain object ref — not the RdfReasoner) to avoid extending its lifetime.
const workerRegistry = new FinalizationRegistry<Worker>((worker) => {
  try {
    worker.terminate();
  } catch {
    // Worker may already be terminated; ignore.
  }
});

type ResultCache = { gen: number; store: Store; graph: string; sig: string };

export class RdfReasoner {
  /** Resolves when the Worker WASM module is ready; rejects on init failure. */
  readonly ready: Promise<void>;

  private worker: Worker;
  private _workerUrl: URL | null = null;
  private nextId = 0;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (reason: unknown) => void }
  >();

  /**
   * Serialization queue: each reason() / checkConsistency() call chains onto
   * this promise so that concurrent calls never interleave their
   * loadTripleBuffer → realization → getInferredTripleBuffer sequences.
   */
  private _queue: Promise<void> = Promise.resolve();

  // Per-operation result caches. Each slot stores the C++ content generation (from `sync`) AND the
  // exact store instance so that a cache hit only fires for the same Store object with unchanged
  // content. Two different Store objects with identical quads do NOT share a hit — the inferred graph
  // lives inside the Store, so a fresh Store is populated from the reasoner's (cached) result.
  // A result cache says "the inferred graph of `store` was written for generation `gen`". It is only a hit while
  // the graph still holds exactly what was written (`sig`): an edit to the inferred graph, or a call that targets
  // another inferred graph, rewrites it instead of trusting the cache.
  private _classifyCache: ResultCache | null = null;
  private _materializeCache: ResultCache | null = null;
  private _classifyPropertiesCache: ResultCache | null = null;
  private _consistencyCache: { gen: number; result: boolean } | null = null;
  /** Result of the last explainInconsistency() for the store content of generation `key` (the kernel's content generation, so
   *  an unchanged store gets the same answer without a search). Dropped when the Worker is recreated: generations restart. */
  private _inconsistencyExplainCache: { key: string; result: Quad[][] } | null = null;

  // Cached explanation buffers — avoids WASM round-trip on cache-hit explanation requests.
  private _lastExplBuffer: { gen: number; store: Store; buf: ArrayBuffer } | null = null;
  private _lastPropertyExplBuffer: { gen: number; store: Store; buf: ArrayBuffer } | null = null;
  private _entailmentProbeCounter = 0;
  private readonly _onTrace: ((msg: string) => void) | undefined;

  // Stall recovery: the Worker is restarted and the current store's WASM state is replayed
  // when a blocking call shows no sign of life (see RdfReasonerOptions.stallTimeoutMs).
  private readonly _stallTimeoutMs: number;
  private readonly _recycleHeapBytes: number;
  // Caller graphs that are not ontology content (shapes, provenance, ...): never encoded, never count as a source of an inferred triple.
  private readonly _excludeGraphs: ReadonlySet<string>;
  private _lastHeapBytes = 0;
  private readonly _workerFactory: (() => Worker) | undefined;
  private _lastActivity = Date.now();
  private _lastLoad: unknown[] | null = null;          // copies of the last loadTripleBuffer args
  private _stateCalls: string[] = [];                  // idempotent state calls since that load

  constructor(opts?: RdfReasonerOptions) {
    this._onTrace = opts?.onTrace;
    this._stallTimeoutMs = opts?.stallTimeoutMs ?? 600_000;
    this._recycleHeapBytes = opts?.recycleHeapBytes ?? 2 * 1024 ** 3;
    this._excludeGraphs = new Set(opts?.excludeGraphs ?? []);
    this._workerFactory = opts?.workerFactory;
    if (opts?.workerFactory) {
      this.worker = opts.workerFactory();
    } else if (opts?.worker) {
      this.worker = opts.worker;
    } else {
      const url = opts?.workerUrl
        ? (typeof opts.workerUrl === "string" ? new URL(opts.workerUrl) : opts.workerUrl)
        : new URL("./worker.js", import.meta.url);
      this._workerUrl = url;

      // Indirect constructor reference so bundlers (Vite) that statically
      // analyze `new Worker(...)` calls skip this dynamic instantiation.
      const W = globalThis.Worker;
      this.worker = new W(url, { type: "module" });
    }

    // Safety net: terminate the Worker if this instance is GC'd without an
    // explicit terminate() call.  GC timing is non-deterministic — callers
    // should always call terminate() or use the `using` keyword.
    // The unregister token (this) lets terminate() cancel the callback.
    workerRegistry.register(this, this.worker, this);

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
        this._lastActivity = Date.now();
        const msg = event.data;
        // Skip init-lifecycle messages (handled by the one-shot listener above).
        if ("type" in msg) {
          if (msg.type === "log" && this._onTrace) {
            this._onTrace((msg as WorkerLogMessage).msg);
          }
          return;
        }

        const response = msg as WorkerResponse;
        if (typeof response.heapBytes === "number") this._lastHeapBytes = response.heapBytes;
        const entry = this.pending.get(response.id);
        if (!entry) return;
        this.pending.delete(response.id);

        if (response.error !== undefined) {
          entry.reject(response.error === "KONCLUDE_STALLED" ? new ReasonerStalledError("kernel", 0) : new Error(response.error));
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
   * Terminate the hung Worker and spin up a fresh one.
   * Called from inside a bisection loop when a single WASM call exceeds its
   * per-call deadline.  Rejects all pending _callDirect promises so no orphaned
   * async chains continue sending messages to the dead Worker, then waits for
   * the new Worker's WASM module to finish initialising before returning.
   */
  private async _reinitForBisection(opts?: { keepState?: boolean }): Promise<void> {
    // Reject all in-flight _callDirect promises — their callers handle the error.
    const err = new Error("bisection-timeout-worker-reinit");
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();

    this.worker.terminate();

    if (this._workerFactory) {
      this.worker = this._workerFactory();
    } else {
      const url = this._workerUrl ?? new URL("./worker.js", import.meta.url);
      const W = globalThis.Worker;
      this.worker = new W(url, { type: "module" });
    }
    workerRegistry.register(this, this.worker, this);

    // Wire the response-dispatch handler on the new worker.
    this.worker.addEventListener("message", (event: MessageEvent<WorkerInboundMessage>) => {
      this._lastActivity = Date.now();
      const msg = event.data;
      if ("type" in msg) {
        if (msg.type === "log" && this._onTrace) this._onTrace((msg as WorkerLogMessage).msg);
        return;
      }
      const response = msg as WorkerResponse;
      if (typeof response.heapBytes === "number") this._lastHeapBytes = response.heapBytes;
      const entry = this.pending.get(response.id);
      if (!entry) return;
      this.pending.delete(response.id);
      if (response.error !== undefined) entry.reject(response.error === "KONCLUDE_STALLED" ? new ReasonerStalledError("kernel", 0) : new Error(response.error));
      else entry.resolve(response.result);
    });

    // Wait for WASM ready.
    await new Promise<void>((resolve, reject) => {
      const onInit = (ev: MessageEvent<WorkerInboundMessage>) => {
        const msg = ev.data;
        if (!("type" in msg)) return;
        if (msg.type === "ready") {
          this.worker.removeEventListener("message", onInit);
          resolve();
        } else if (msg.type === "error") {
          this.worker.removeEventListener("message", onInit);
          reject(new Error((msg as { error: string }).error));
        }
      };
      this.worker.addEventListener("message", onInit);
    });

    this._lastActivity = Date.now();
    if (opts?.keepState) {
      // Stall recovery: the caller replays the WASM state. Content generations restart in the new
      // Worker, so every generation-keyed result cache is dropped (the replayed state is re-synced).
      this._classifyCache = null;
      this._materializeCache = null;
      this._classifyPropertiesCache = null;
      this._consistencyCache = null;
      this._inconsistencyExplainCache = null;
      this._lastExplBuffer = null;
      this._lastPropertyExplBuffer = null;
      return;
    }
    // Clear all caches — WASM state is blank.
    this._lastLoad = null;
    this._stateCalls = [];
    this._classifyCache = null;
    this._materializeCache = null;
    this._classifyPropertiesCache = null;
    this._consistencyCache = null;
    this._inconsistencyExplainCache = null;
    this._lastExplBuffer = null;
    this._lastPropertyExplBuffer = null;
    this._queue = Promise.resolve();
  }

  /**
   * Send a method call to the Worker and return a Promise for the result.
   * Pass `transfer` to transfer ownership of ArrayBuffers (zero-copy).
   */
  private async _call(method: string, args: unknown[], transfer?: Transferable[]): Promise<unknown> {
    const blocking = RdfReasoner._BLOCKING.has(method);
    const isLoad = RdfReasoner._isLoad(method);
    if (isLoad) {
      // Keep copies: the originals are transferred, and a stall replays this load.
      this._lastLoad = [(args[0] as ArrayBuffer).slice(0), (args[1] as ArrayBuffer).slice(0), ...args.slice(2)];
      this._stateCalls = [];
    }
    try {
      let result = await this._callOnce(method, args, transfer, blocking);
      if (isLoad && this._lastLoad && (result as { changed?: boolean } | undefined)?.changed === true) {
        // The previous content's ontology stays alive in the WASM heap until the lazy rebuild; with a
        // large previous call the 4 GiB limit would be hit. A fresh Worker starts with an empty heap.
        // Only changed content needs this (unchanged content triggers no rebuild).
        if (this._recycleHeapBytes > 0 && this._lastHeapBytes > this._recycleHeapBytes && (this._workerFactory ?? this._workerUrl)) {
          const load = this._lastLoad.map((a) => (a instanceof ArrayBuffer ? a.slice(0) : a));
          await this._reinitForBisection();
          this._lastHeapBytes = 0;
          this._lastLoad = load.map((a) => (a instanceof ArrayBuffer ? a.slice(0) : a));
          this._stateCalls = [];
          result = await this._callOnce("sync", load, [load[0] as ArrayBuffer, load[1] as ArrayBuffer], true);
        }
      }
      if (blocking && !isLoad && !this._stateCalls.includes(method)) this._stateCalls.push(method);
      return result;
    } catch (e) {
      const canRestart = !!(this._workerFactory ?? this._workerUrl);
      if (!(e instanceof ReasonerStalledError) || !canRestart) throw e;
      // One recovery attempt: fresh Worker, replay the current store's state, retry the call.
      await this._reinitForBisection({ keepState: true });
      if (!isLoad && this._lastLoad) {
        const load = this._lastLoad.map((a) => (a instanceof ArrayBuffer ? a.slice(0) : a));
        await this._callOnce("sync", load, [load[0] as ArrayBuffer, load[1] as ArrayBuffer], true);
        for (const m of this._stateCalls) await this._callOnce(m, [], undefined, true);
      }
      const retryArgs = isLoad && this._lastLoad ? this._lastLoad.map((a) => (a instanceof ArrayBuffer ? a.slice(0) : a)) : args;
      const retryTransfer = isLoad ? [retryArgs[0] as ArrayBuffer, retryArgs[1] as ArrayBuffer] : transfer;
      const result = await this._callOnce(method, retryArgs, retryTransfer, blocking);
      if (blocking && !isLoad && !this._stateCalls.includes(method)) this._stateCalls.push(method);
      return result;
    }
  }

  private static readonly _BLOCKING = new Set(["sync", "classification", "realization", "consistency"]);
  private static _isLoad(method: string): boolean { return method === "sync"; }

  private _callOnce(method: string, args: unknown[], transfer: Transferable[] | undefined, watch: boolean): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      let timer: ReturnType<typeof setInterval> | undefined;
      const done = () => { if (timer !== undefined) clearInterval(timer); };
      this.pending.set(id, {
        resolve: (v) => { done(); resolve(v); },
        reject: (r) => { done(); reject(r); },
      });
      if (watch && this._stallTimeoutMs > 0) {
        this._lastActivity = Date.now();
        const tick = Math.max(10, Math.min(5000, Math.floor(this._stallTimeoutMs / 4)));
        timer = setInterval(() => {
          const idle = Date.now() - this._lastActivity;
          if (idle > this._stallTimeoutMs) {
            this.pending.delete(id);
            done();
            reject(new ReasonerStalledError(method, idle));
          }
        }, tick);
      }
      const request: WorkerRequest = { id, method, args };
      if (transfer && transfer.length > 0) {
        this.worker.postMessage(request, transfer);
      } else {
        this.worker.postMessage(request);
      }
    });
  }

  private _stamp(gen: number, store: Store, inferredGraph?: string): ResultCache {
    const graph = inferredGraph ?? INFERRED_GRAPH_IRI;
    return { gen, store, graph, sig: graphSignature(getRawStore(store), graph) };
  }

  private _hit(cache: ResultCache | null, gen: number, store: Store, inferredGraph?: string): boolean {
    if (cache === null || cache.gen !== gen || cache.store !== store) return false;
    const graph = inferredGraph ?? INFERRED_GRAPH_IRI;
    return cache.graph === graph && cache.sig === graphSignature(getRawStore(store), graph);
  }

  /** Content generation of the last `sync` (C++ owns validity; see KoncludeReasoner::syncTripleBuffer). */
  private _lastGen = -1;
  private _noGen = 0;

  /**
   * Hand the store's current quads to the reasoner. C++ compares the content with what it holds and
   * invalidates its cached results when it changed; the returned generation keys the per-store
   * result caches. `ignoreGraph` (a custom inferredGraph) never counts as content.
   */
  private async _sync(store: Store, ignoreGraph?: string, direct = false): Promise<number> {
    const { tripleBuffer, strTableBuffer } = encodeStoreToBuffers(store, ignoreGraph ? [ignoreGraph, ...this._excludeGraphs] : [...this._excludeGraphs]);
    const call = direct ? this._callDirect.bind(this) : this._call.bind(this);
    const info = (await call("sync", [tripleBuffer, strTableBuffer], [tripleBuffer, strTableBuffer])) as { generation?: number } | undefined;
    // A worker that does not report generations (e.g. test doubles) never yields a cache hit.
    this._lastGen = typeof info === "object" && info !== null && typeof info.generation === "number" ? info.generation : --this._noGen;
    return this._lastGen;
  }

  /** `_sync` for ops that overwrite an inferred graph: if the sync fails the graph is left cleared, never stale. */
  private async _syncForOp(store: Store, inferredGraph: string | undefined): Promise<number> {
    try {
      return await this._sync(store, inferredGraph);
    } catch (e) {
      clearGraph(getRawStore(store), inferredGraph ?? INFERRED_GRAPH_IRI);
      throw e;
    }
  }

  private async _ensureExplanationGraphFromBuffer(store: Store, bufferMethod: string): Promise<void> {
    const rawStore = getRawStore(store);
    const explGraphNode = DataFactory.namedNode(EXPLANATION_GRAPH_IRI);
    if (store.getQuads(null, null, null, explGraphNode).length > 0) return;
    const isProperty = bufferMethod === "getPropertyTripleBuffer";
    const cached = isProperty ? this._lastPropertyExplBuffer : this._lastExplBuffer;
    const gen = this._lastGen;
    let resultBuf: ArrayBuffer;
    if (cached && cached.store === store && cached.gen === gen) {
      resultBuf = cached.buf;
    } else {
      resultBuf = (await this._call(bufferMethod, [true])) as ArrayBuffer;
      const entry = { gen, store, buf: resultBuf };
      if (isProperty) this._lastPropertyExplBuffer = entry;
      else this._lastExplBuffer = entry;
    }
    injectExplanationsFromBuffer(rawStore, resultBuf, EXPLANATION_GRAPH_IRI);
  }

  // -------------------------------------------------------------------------
  // reason()
  // -------------------------------------------------------------------------

  /** Run OWL-DL reasoning over a Store. Inferred triples are written into
   *  `opts.inferredGraph` (default `INFERRED_GRAPH_IRI`). The graph is cleared
   *  before each call. Concurrent calls are serialized. */
  reason(store: Store, opts?: StoreReasoningOptions): Promise<void> {
    return this._reasonOnStore(store, opts);
  }

  private _reasonOnStore(store: Store, opts?: StoreReasoningOptions): Promise<void> {
    // Cache contract: C++ owns content validity (digest compare in `sync`); the returned generation
    // keys a per-Store fast path. A hit requires the same Store INSTANCE and the same generation, because
    // inferred quads live inside the Store object itself. A fresh Store with identical content misses
    // here but costs no Konclude work when C++ still holds the result (see KoncludeReasoner::classification).
    const wantExplanations = opts?.explanations === true;
    const result = this._queue.then(async () => {
      const gen = await this._syncForOp(store, opts?.inferredGraph);
      await this._guardConsistent(gen, opts);
      // Cache hit: same store instance with same content as last classify call
      if (this._hit(this._classifyCache, gen, store, opts?.inferredGraph)) {
        if (wantExplanations) {
          await this._ensureExplanationGraphFromBuffer(store, "getInferredTripleBuffer");
        }
        return;
      }

      const rawStore = getRawStore(store);
      const inferredGraphNode = DataFactory.namedNode(
        opts?.inferredGraph ?? INFERRED_GRAPH_IRI,
      );
      clearGraph(rawStore, inferredGraphNode.value);

      await this._call("classification", []);

      const resultBuf = (await this._call("getInferredTripleBuffer", [wantExplanations])) as ArrayBuffer;

      if (wantExplanations) {
        const decoded = decodeBuffers(resultBuf, { withJustifications: true });
        for (const q of decoded.quads) {
          if (existsInSourceGraphs(store, q.subject, q.predicate, q.object, this._excludeGraphs)) continue;
          rawStore.addQuad(DataFactory.quad(q.subject, q.predicate, q.object, inferredGraphNode));
        }
        injectExplanationsFromBuffer(rawStore, resultBuf, EXPLANATION_GRAPH_IRI);
        this._lastExplBuffer = { gen, store, buf: resultBuf };
      } else {
        const inferredQuads = decodeBuffers(resultBuf);
        for (const q of inferredQuads) {
          if (existsInSourceGraphs(store, q.subject, q.predicate, q.object, this._excludeGraphs)) continue;
          rawStore.addQuad(DataFactory.quad(q.subject, q.predicate, q.object, inferredGraphNode));
        }
        this._lastExplBuffer = null;
      }

      this._classifyCache = this._stamp(gen, store, opts?.inferredGraph);
      this._materializeCache = null;
      this._classifyPropertiesCache = null;
      this._lastPropertyExplBuffer = null;
    });
    this._queue = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  // -------------------------------------------------------------------------
  // classify()
  // -------------------------------------------------------------------------

  /** Classify a Store. Inferred rdfs:subClassOf and owl:equivalentClass triples
   *  are written into `opts.inferredGraph` (default `INFERRED_GRAPH_IRI`). The
   *  graph is cleared before each call. Concurrent calls are serialized.
   *
   *  Internally sends a single `classification` command to the WASM worker, which
   *  runs TBox-only reasoning (class hierarchy + property hierarchy). No ABox
   *  realization is performed. For individual rdf:type entailments use
   *  `materialize(store)` instead. */
  classify(store: Store, opts?: StoreReasoningOptions): Promise<void> {
    return this.reason(store, opts);
  }

  // -------------------------------------------------------------------------
  // checkConsistency()
  // -------------------------------------------------------------------------

  /** Check consistency of a Store. Does not write inferred triples. */
  // The WASM side runs only up to Konclude's consistency step (the native `consistency` command stops there as
  // well); classification is not a prerequisite of consistency, it is the other way round. Since 0.9.0 a full
  // classification costs thousands of tableau tests on some ontologies (PMDco: ~4 760), so it must not run here.
  checkConsistency(store: Store): Promise<boolean> {
    const result = this._queue.then(async () => {
      const gen = await this._sync(store);
      if (this._consistencyCache !== null && this._consistencyCache.gen === gen) {
        return this._consistencyCache.result;
      }

      // consistency() runs only the consistency step (see _checkInconsistencyDirect).
      const consistent = (await this._call("consistency", [])) as boolean;

      // Caches of other content generations are stale; caches of THIS generation stay valid.
      if (this._classifyCache?.gen !== gen) this._classifyCache = null;
      if (this._materializeCache?.gen !== gen) this._materializeCache = null;
      if (this._classifyPropertiesCache?.gen !== gen) this._classifyPropertiesCache = null;
      if (this._lastExplBuffer?.gen !== gen) this._lastExplBuffer = null;
      if (this._lastPropertyExplBuffer?.gen !== gen) this._lastPropertyExplBuffer = null;

      this._consistencyCache = { gen, result: consistent };

      return consistent;
    });
    this._queue = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  // -------------------------------------------------------------------------
  // materialize()
  // -------------------------------------------------------------------------

  /** Materialize ABox entailments (rdf:type, owl:sameAs, role assertions) into
   *  a Store. Inferred triples are written into `opts.inferredGraph` (default
   *  `INFERRED_GRAPH_IRI`). The graph is cleared before each call. When
   *  `opts.includeClassHierarchy` is `true`, rdfs:subClassOf and
   *  owl:equivalentClass triples are also included. Concurrent calls are
   *  serialized.
   *
   *  Individuals are recognized from any `rdf:type <domain-class>` assertion —
   *  explicit `rdf:type owl:NamedIndividual` declarations are not required.
   *  If the ontology contains no individuals, only TBox inferences are produced
   *  (same result as `classify(store)` with `includeClassHierarchy: true`).
   *
   *  Internally sends a single `realization` command to the WASM worker.
   *  Classification (TBox: class hierarchy + property hierarchy) is always a
   *  prerequisite inside the realization pipeline — it is NOT a separate call.
   *  Both TBox and ABox steps are submitted together in one `prepareOntology()`
   *  invocation at the C++ level.
   *
   *  Pass `{ returnDelta: true }` to receive `{ delta: InferenceDelta }` with the
   *  quads added and removed compared to the previous inferred state. */
  materialize(store: Store, opts: MaterializeStoreOptions & { returnDelta: true }): Promise<{ delta: InferenceDelta }>;
  materialize(store: Store, opts?: MaterializeStoreOptions): Promise<void>;
  materialize(
    store: Store,
    opts?: MaterializeStoreOptions,
  ): Promise<void> | Promise<{ delta: InferenceDelta }> {
    return this._materializeOnStore(store, opts);
  }

  private _materializeOnStore(store: Store, opts?: MaterializeStoreOptions): Promise<void> | Promise<{ delta: InferenceDelta }> {
    const returnDelta = opts?.returnDelta === true;
    const wantExplanations = opts?.explanations === true;
    const result = this._queue.then(async () => {
      const inferredGraphNode = DataFactory.namedNode(
        opts?.inferredGraph ?? INFERRED_GRAPH_IRI,
      );
      const gen = await this._syncForOp(store, opts?.inferredGraph);
      await this._guardConsistent(gen, opts);

      // Cache hit: same store instance with same content as last materialize call
      if (this._hit(this._materializeCache, gen, store, opts?.inferredGraph)) {
        if (wantExplanations) {
          await this._ensureExplanationGraphFromBuffer(store, "getInferredTripleBuffer");
        }
        if (returnDelta) {
          return { delta: { added: [], removed: [] } as InferenceDelta };
        }
        return;
      }

      // Capture "before" snapshot of current inferred quads for delta computation.
      // Must happen BEFORE removeQuads.
      const beforeSet = new Map<string, Quad>();
      if (returnDelta) {
        for (const q of store.getQuads(null, null, null, inferredGraphNode)) {
          const key = `${q.subject.value}\0${q.predicate.value}\0${q.object.value}`;
          beforeSet.set(key, q);
        }
      }

      const rawStore = getRawStore(store);
      clearGraph(rawStore, inferredGraphNode.value);

      await this._call("realization", []);

      const resultBuf = (await this._call("getInferredTripleBuffer", [wantExplanations])) as ArrayBuffer;

      let allQuads: Quad[];
      if (wantExplanations) {
        const decoded = decodeBuffers(resultBuf, { withJustifications: true });
        allQuads = decoded.quads;
        injectExplanationsFromBuffer(rawStore, resultBuf, EXPLANATION_GRAPH_IRI);
        this._lastExplBuffer = { gen, store, buf: resultBuf };
      } else {
        allQuads = decodeBuffers(resultBuf);
        this._lastExplBuffer = null;
      }

      if (typeof process !== "undefined" && process.env?.["DEBUG_MATERIALIZE"]) {
        console.error("[DEBUG materialize] allQuads:", allQuads.length, allQuads.slice(0,5).map(q => `${q.subject.value} ${q.predicate.value} ${q.object.value}`));
      }


      let inferredQuads = opts?.includeClassHierarchy === true
        ? allQuads
        : allQuads.filter(
            (q) =>
              q.predicate.value !== "http://www.w3.org/2000/01/rdf-schema#subClassOf" &&
              q.predicate.value !== "http://www.w3.org/2002/07/owl#equivalentClass",
          );

      for (const q of inferredQuads) {
        if (existsInSourceGraphs(store, q.subject, q.predicate, q.object, this._excludeGraphs)) continue;
        rawStore.addQuad(
          DataFactory.quad(q.subject, q.predicate, q.object, inferredGraphNode),
        );
      }

      this._materializeCache = this._stamp(gen, store, opts?.inferredGraph);
      this._classifyCache = null;
      this._classifyPropertiesCache = null;
      this._lastPropertyExplBuffer = null;

      if (returnDelta) {
        // Build after set from what actually landed in the inferred graph
        // (post-dedup), not the raw WASM output.
        const afterSet = new Map<string, Quad>();
        for (const q of store.getQuads(null, null, null, inferredGraphNode)) {
          const key = `${q.subject.value}\0${q.predicate.value}\0${q.object.value}`;
          afterSet.set(key, q);
        }
        const added: Quad[] = [];
        const removed: Quad[] = [];
        for (const [key, q] of afterSet) {
          if (!beforeSet.has(key)) added.push(q);
        }
        for (const [key, q] of beforeSet) {
          if (!afterSet.has(key)) removed.push(q);
        }
        return { delta: { added, removed } };
      }
    });
    this._queue = result.then(
      () => {},
      () => {},
    );
    return result as Promise<void> | Promise<{ delta: InferenceDelta }>;
  }

  // -------------------------------------------------------------------------
  // classifyProperties()
  // -------------------------------------------------------------------------

  /** Classify property hierarchy of a Store. Inferred rdfs:subPropertyOf triples
   *  are written into `opts.inferredGraph` (default `INFERRED_GRAPH_IRI`). The
   *  graph is cleared before each call. Concurrent calls are serialized. */
  classifyProperties(store: Store, opts?: ClassifyPropertiesStoreOptions): Promise<void> {
    return this._classifyPropertiesOnStore(store, opts);
  }

  private _classifyPropertiesOnStore(store: Store, opts?: ClassifyPropertiesStoreOptions): Promise<void> {
    const wantExplanations = opts?.explanations === true;
    const result = this._queue.then(async () => {
      const gen = await this._syncForOp(store, opts?.inferredGraph);
      await this._guardConsistent(gen, opts);
      // Cache hit: same store instance with same content as last classifyProperties call
      if (this._hit(this._classifyPropertiesCache, gen, store, opts?.inferredGraph)) {
        if (wantExplanations) {
          await this._ensureExplanationGraphFromBuffer(store, "getPropertyTripleBuffer");
        }
        return;
      }

      const rawStore = getRawStore(store);
      const inferredGraphNode = DataFactory.namedNode(
        opts?.inferredGraph ?? INFERRED_GRAPH_IRI,
      );
      clearGraph(rawStore, inferredGraphNode.value);

      await this._call("classification", []);

      const resultBuf = (await this._call("getPropertyTripleBuffer", [wantExplanations])) as ArrayBuffer;

      if (wantExplanations) {
        const decoded = decodeBuffers(resultBuf, { withJustifications: true });
        for (const q of decoded.quads) {
          if (existsInSourceGraphs(store, q.subject, q.predicate, q.object, this._excludeGraphs)) continue;
          rawStore.addQuad(DataFactory.quad(q.subject, q.predicate, q.object, inferredGraphNode));
        }
        injectExplanationsFromBuffer(rawStore, resultBuf, EXPLANATION_GRAPH_IRI);
        this._lastPropertyExplBuffer = { gen, store, buf: resultBuf };
      } else {
        const inferredQuads = decodeBuffers(resultBuf);
        for (const q of inferredQuads) {
          if (existsInSourceGraphs(store, q.subject, q.predicate, q.object, this._excludeGraphs)) continue;
          rawStore.addQuad(DataFactory.quad(q.subject, q.predicate, q.object, inferredGraphNode));
        }
        this._lastPropertyExplBuffer = null;
      }

      this._classifyPropertiesCache = this._stamp(gen, store, opts?.inferredGraph);
      this._classifyCache = null;
      this._materializeCache = null;
      this._lastExplBuffer = null;
    });
    this._queue = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  // -------------------------------------------------------------------------
  // isEntailed()
  // -------------------------------------------------------------------------

  private _opForPredicate(iri: string): "classify" | "materialize" | "classifyProperties" | null {
    switch (iri) {
      case "http://www.w3.org/2000/01/rdf-schema#subClassOf":
      case "http://www.w3.org/2002/07/owl#equivalentClass":
        return "classify";
      case "http://www.w3.org/1999/02/22-rdf-syntax-ns#type":
        return "materialize";
      case "http://www.w3.org/2000/01/rdf-schema#subPropertyOf":
        return "classifyProperties";
      default:
        return null;
    }
  }

  private async _classifyInline(store: Store, gen: number, inferredGraph?: string): Promise<void> {
    if (this._hit(this._classifyCache, gen, store, inferredGraph)) return;
    const rawStore = getRawStore(store);
    const ig = DataFactory.namedNode(inferredGraph ?? INFERRED_GRAPH_IRI);
    clearGraph(rawStore, ig.value);
    await this._call("classification", []);
    const buf = (await this._call("getInferredTripleBuffer", [])) as ArrayBuffer;
    for (const q of decodeBuffers(buf)) {
      rawStore.addQuad(DataFactory.quad(q.subject, q.predicate, q.object, ig));
    }
    this._classifyCache = this._stamp(gen, store, inferredGraph);
    this._materializeCache = null;           // cross-invalidate
    this._classifyPropertiesCache = null;    // cross-invalidate
    this._lastExplBuffer = null;
    this._lastPropertyExplBuffer = null;
  }

  private async _materializeInline(store: Store, gen: number, inferredGraph?: string): Promise<void> {
    if (this._hit(this._materializeCache, gen, store, inferredGraph)) return;
    const rawStore = getRawStore(store);
    const ig = DataFactory.namedNode(inferredGraph ?? INFERRED_GRAPH_IRI);
    clearGraph(rawStore, ig.value);
    await this._call("realization", []);
    const buf = (await this._call("getInferredTripleBuffer", [])) as ArrayBuffer;
    const allQuads = decodeBuffers(buf);
    // Write ALL results (including subClassOf) so rdf:type AND subClassOf checks work
    for (const q of allQuads) {
      rawStore.addQuad(DataFactory.quad(q.subject, q.predicate, q.object, ig));
    }
    this._materializeCache = this._stamp(gen, store, inferredGraph);
    this._classifyCache = null;              // cross-invalidate
    this._classifyPropertiesCache = null;    // cross-invalidate
    this._lastExplBuffer = null;
    this._lastPropertyExplBuffer = null;
  }

  private async _classifyPropertiesInline(store: Store, gen: number, inferredGraph?: string): Promise<void> {
    if (this._hit(this._classifyPropertiesCache, gen, store, inferredGraph)) return;
    const rawStore = getRawStore(store);
    const ig = DataFactory.namedNode(inferredGraph ?? INFERRED_GRAPH_IRI);
    clearGraph(rawStore, ig.value);
    await this._call("classification", []);
    const buf = (await this._call("getPropertyTripleBuffer", [])) as ArrayBuffer;
    for (const q of decodeBuffers(buf)) {
      rawStore.addQuad(DataFactory.quad(q.subject, q.predicate, q.object, ig));
    }
    this._classifyPropertiesCache = this._stamp(gen, store, inferredGraph);
    this._classifyCache = null;              // cross-invalidate
    this._materializeCache = null;           // cross-invalidate
    this._lastExplBuffer = null;
    this._lastPropertyExplBuffer = null;
  }

  // -------------------------------------------------------------------------
  // _getUnsatisfiableClassesInternal (safe for use inside _queue body)
  // -------------------------------------------------------------------------

  /**
   * Private helper — like _classifyInline but also calls getUnsatisfiableClassBuffer
   * and returns the list of unsatisfiable class IRIs.  Updates _classifyCache and
   * writes inferred triples into the store on cache miss (same invariant as
   * _classifyInline).  Must be called from inside a _queue slot only.
   */
  private async _getUnsatisfiableClassesInternal(store: Store, inferredGraph?: string, guard?: { failOnInconsistent?: boolean }): Promise<string[]> {
    const gen = await this._sync(store, inferredGraph, true);
    await this._guardConsistent(gen, guard, true);
    if (!this._hit(this._classifyCache, gen, store, inferredGraph)) {
      const rawStore = getRawStore(store);
      const ig = DataFactory.namedNode(inferredGraph ?? INFERRED_GRAPH_IRI);
      clearGraph(rawStore, ig.value);
      await this._callDirect("classification", []);
      const buf = (await this._callDirect("getInferredTripleBuffer", [])) as ArrayBuffer;
      for (const q of decodeBuffers(buf))
        rawStore.addQuad(DataFactory.quad(q.subject, q.predicate, q.object, ig));
      this._classifyCache = this._stamp(gen, store, inferredGraph);
      this._materializeCache = null;
      this._classifyPropertiesCache = null;
    }
    const raw = (await this._callDirect("getUnsatisfiableClassBuffer", [])) as string;
    return raw.split('\n').filter(Boolean);
  }

  // -------------------------------------------------------------------------
  // getUnsatisfiableClasses() / isSatisfiable()
  // -------------------------------------------------------------------------

  /** Return the IRIs of all classes that are unsatisfiable (equivalent to
   *  owl:Nothing) in the ontology.  owl:Nothing itself is excluded.
   *  Classes absent from the taxonomy are NOT included (open-world). */
  getUnsatisfiableClasses(store: Store, opts?: InconsistencyGuardOptions): Promise<string[]> {
    const result = this._queue.then(async () =>
      this._getUnsatisfiableClassesInternal(store, opts?.inferredGraph, opts),
    );
    this._queue = result.then(() => {}, () => {});
    return result;
  }

  /** Return `false` if `classIRI` is equivalent to owl:Nothing in the ontology.
   *  Returns `true` for any class absent from the taxonomy (open-world assumption).
   *  owl:Nothing is always unsatisfiable; returns `false` without a Worker call. */
  isSatisfiable(store: Store, classIRI: string, opts?: InconsistencyGuardOptions): Promise<boolean> {
    if (classIRI === OWL_NOTHING) return Promise.resolve(false);
    const result = this._queue.then(async () => {
      const unsatSet = await this._getUnsatisfiableClassesInternal(store, opts?.inferredGraph, opts);
      return !unsatSet.includes(classIRI);
    });
    this._queue = result.then(() => {}, () => {});
    return result;
  }

  // REVIEW: isEntailed re-runs classify/materialize internally — callers like
  // ontosphere already materialize through DlReasoner. Consider removing the
  // internal reasoning and relying on the caller's prior materialize() call.
  /** Check whether a single axiom is entailed by the store's ontology. Returns
   *  null for unsupported predicates (a warning is logged). Triggers reasoning
   *  internally if the store has changed since the last call. */
  isEntailed(store: Store, axiom: Quad, opts?: InconsistencyGuardOptions): Promise<boolean | null>;
  /** Check whether each axiom in a batch is entailed. Returns null for
   *  individual unsupported predicates. Reasoning is triggered at most once
   *  per required operation type. */
  isEntailed(store: Store, axioms: Quad[], opts?: InconsistencyGuardOptions): Promise<(boolean | null)[]>;
  isEntailed(
    store: Store,
    axiomOrAxioms: Quad | Quad[],
    opts?: InconsistencyGuardOptions,
  ): Promise<boolean | null> | Promise<(boolean | null)[]> {
    const isBatch = Array.isArray(axiomOrAxioms);
    const axioms: Quad[] = isBatch ? (axiomOrAxioms as Quad[]) : [axiomOrAxioms as Quad];
    const igIri = opts?.inferredGraph ?? INFERRED_GRAPH_IRI;

    // Fast-path unsupported check for single axiom (no queue entry needed)
    if (!isBatch) {
      const op = this._opForPredicate((axiomOrAxioms as Quad).predicate.value);
      if (op === null && !this._isDisjointAxiom(axiomOrAxioms as Quad)) {
        console.warn(`isEntailed: unsupported predicate <${(axiomOrAxioms as Quad).predicate.value}>`);
        return Promise.resolve(null);
      }
    }

    const result = this._queue.then(async () => {
      const ig = DataFactory.namedNode(igIri);
      const gen = await this._sync(store, igIri);
      await this._guardConsistent(gen, opts);

      // Determine which operations are needed
      const needsClassify = axioms.some(a => this._opForPredicate(a.predicate.value) === "classify");
      const needsMaterialize = axioms.some(a => this._opForPredicate(a.predicate.value) === "materialize");
      const needsClassifyProps = axioms.some(a => this._opForPredicate(a.predicate.value) === "classifyProperties");

      // Run needed operations in order; each cross-invalidates others
      const dg = DataFactory.defaultGraph();
      const inferred = (a: Quad) =>
        store.has(DataFactory.quad(a.subject, a.predicate, a.object, ig)) ||
        store.has(DataFactory.quad(a.subject, a.predicate, a.object, dg));

      const classifyResults = new Map<Quad, boolean>();
      if (needsClassify) {
        await this._classifyInline(store, gen, igIri);
        for (const a of axioms) {
          if (this._opForPredicate(a.predicate.value) === "classify") {
            classifyResults.set(a, inferred(a));
          }
        }
      }

      const materializeResults = new Map<Quad, boolean>();
      if (needsMaterialize) {
        await this._materializeInline(store, gen, igIri);
        for (const a of axioms) {
          if (this._opForPredicate(a.predicate.value) === "materialize") {
            materializeResults.set(a, inferred(a));
          }
        }
      }

      const classifyPropsResults = new Map<Quad, boolean>();
      if (needsClassifyProps) {
        await this._classifyPropertiesInline(store, gen, igIri);
        for (const a of axioms) {
          if (this._opForPredicate(a.predicate.value) === "classifyProperties") {
            classifyPropsResults.set(a, inferred(a));
          }
        }
      }

      // owl:disjointWith between named classes: decided in one probe batch (after the other operations; it replaces the WASM state)
      const disjointAxioms = axioms.filter(a => this._isDisjointAxiom(a));
      const disjointResults = new Map<Quad, boolean | null>();
      if (disjointAxioms.length > 0) {
        const res = await this._disjointEntailmentsDirect(store, igIri, disjointAxioms);
        disjointAxioms.forEach((a, i) => disjointResults.set(a, res[i].entailed));
        this._invalidateResultCaches();
      }

      // Assemble results
      if (!isBatch) {
        const axiom = axioms[0];
        if (this._isDisjointAxiom(axiom)) return disjointResults.get(axiom) ?? null;
        const op = this._opForPredicate(axiom.predicate.value);
        if (op === "classify") return classifyResults.get(axiom) ?? false;
        if (op === "materialize") return materializeResults.get(axiom) ?? false;
        if (op === "classifyProperties") return classifyPropsResults.get(axiom) ?? false;
        return null;
      }

      return axioms.map(a => {
        if (this._isDisjointAxiom(a)) return disjointResults.get(a) ?? null;
        const op = this._opForPredicate(a.predicate.value);
        if (op === null) {
          console.warn(`isEntailed: unsupported predicate <${a.predicate.value}>`);
          return null;
        }
        if (op === "classify") return classifyResults.get(a) ?? false;
        if (op === "materialize") return materializeResults.get(a) ?? false;
        return classifyPropsResults.get(a) ?? false;
      });
    });
    this._queue = result.then(() => {}, () => {});
    return result as Promise<boolean | null> | Promise<(boolean | null)[]>;
  }

  // -------------------------------------------------------------------------
  // whatIf()
  // -------------------------------------------------------------------------

  /** Reason over a hypothetical extension of the store without mutating it.
   *
   * Computes full-materialize inferences over `store ∪ additions \ removals`
   * without changing the store's base triples or INFERRED_GRAPH_IRI.
   *
   * Returns `{ added, removed }` relative to the current INFERRED_GRAPH_IRI
   * content (both quads carry `graph = INFERRED_GRAPH_IRI` named node).
   *
   * If `opts.outputGraph` is provided the hypothetical inferences are also
   * written to that named graph in the store (must not equal INFERRED_GRAPH_IRI).
   */
  // REVIEW: whatIf re-runs materialize internally — consider whether callers
  // should handle this through DlReasoner instead.
  whatIf(store: Store, additions: Quad[], opts?: WhatIfOptions & { inferredGraph?: string }): Promise<{ added: Quad[]; removed: Quad[] }> {
    const igIri = opts?.inferredGraph ?? INFERRED_GRAPH_IRI;
    if (opts?.outputGraph === igIri) {
      return Promise.reject(new Error(`whatIf: outputGraph must not equal the inferred graph IRI`));
    }
    if (opts?.outputGraph === HYPOTHETICAL_IRI) {
      return Promise.reject(new Error(`whatIf: outputGraph must not equal HYPOTHETICAL_IRI`));
    }

    const result = this._queue.then(async () => {
      const ig = DataFactory.namedNode(igIri);

      // Snapshot before: current inferred quads
      const before: Quad[] = store.getQuads(null, null, null, ig);

      // Build hypothetical quad set: base quads excluding inferred/hypothetical graphs
      const removalKeys = new Set(
        (opts?.removals ?? []).map(q => `${q.subject.value}\0${q.predicate.value}\0${q.object.value}`)
      );
      const baseQuads = store.getQuads(null, null, null, null).filter(q => {
        const g = q.graph.value;
        if (g === igIri || g === HYPOTHETICAL_IRI || this._excludeGraphs.has(g)) return false;
        const key = `${q.subject.value}\0${q.predicate.value}\0${q.object.value}`;
        return !removalKeys.has(key);
      });

      // Merge additions (deduplicate by SPO key)
      const seen = new Set(baseQuads.map(q => `${q.subject.value}\0${q.predicate.value}\0${q.object.value}`));
      const hypothetical: Quad[] = [...baseQuads];
      for (const a of additions) {
        const key = `${a.subject.value}\0${a.predicate.value}\0${a.object.value}`;
        if (!seen.has(key)) {
          seen.add(key);
          hypothetical.push(a);
        }
      }

      // Encode and run the full materialize pipeline
      const { tripleBuffer, strTableBuffer } = encodeToBuffers(hypothetical);
      await this._call("sync", [tripleBuffer, strTableBuffer], [tripleBuffer, strTableBuffer]);
      if (opts?.failOnInconsistent && !((await this._call("consistency", [])) as boolean)) {
        this._invalidateResultCaches(); // the WASM state holds the hypothetical content
        throw new InconsistentOntologyError("The hypothetical ontology (the store plus the additions, minus the removals) is inconsistent.");
      }
      await this._call("realization", []);
      const buf = (await this._call("getInferredTripleBuffer", [])) as ArrayBuffer;
      const afterQuads = decodeBuffers(buf);

      // Wrap after quads with ig so both sides have consistent graph
      const after: Quad[] = afterQuads.map(q =>
        DataFactory.quad(q.subject, q.predicate, q.object, ig)
      );

      // Compute delta relative to before (keyed by SPO)
      const beforeKeys = new Set(before.map(q => `${q.subject.value}\0${q.predicate.value}\0${q.object.value}`));
      const afterKeys = new Set(after.map(q => `${q.subject.value}\0${q.predicate.value}\0${q.object.value}`));
      const added = after.filter(q => !beforeKeys.has(`${q.subject.value}\0${q.predicate.value}\0${q.object.value}`));
      const removed = before.filter(q => !afterKeys.has(`${q.subject.value}\0${q.predicate.value}\0${q.object.value}`));

      // Write to outputGraph if provided (never touch INFERRED_GRAPH_IRI)
      if (opts?.outputGraph) {
        const outNode = DataFactory.namedNode(opts.outputGraph);
        for (const q of after) {
          store.addQuad(DataFactory.quad(q.subject, q.predicate, q.object, outNode));
        }
      }

      // Invalidate all operation caches: WASM state now reflects hypothetical input,
      // not the real store. Next real call must re-load.
      this._classifyCache = null;
      this._materializeCache = null;
      this._classifyPropertiesCache = null;
      this._lastExplBuffer = null;
      this._lastPropertyExplBuffer = null;
      this._consistencyCache = null;

      return { added, removed };
    });
    this._queue = result.then(() => {}, () => {});
    return result;
  }

  // -------------------------------------------------------------------------
  // _callDirect (safe for use inside _queue body)
  // -------------------------------------------------------------------------

  /**
   * Identical to _call. Named separately to mark it safe for use inside a
   * _queue.then() body (no queue gating — callers must already hold the slot).
   * Calling the public methods (classify, materialize, etc.) from inside a
   * _queue body would deadlock.
   */
  private _callDirect(method: string, args: unknown[], transfer?: Transferable[]): Promise<unknown> {
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
  // explain helpers
  // -------------------------------------------------------------------------

  private _isBuiltInDeclaration(q: Quad): boolean {
    if (q.predicate.value !== RDF_TYPE) return false;
    const obj = q.object.value;
    return (
      obj === OWL_CLASS ||
      obj === OWL_OBJECT_PROPERTY ||
      obj === OWL_DATATYPE_PROPERTY ||
      obj === OWL_ANNOTATION_PROPERTY ||
      obj === OWL_ONTOLOGY ||
      obj === RDFS_CLASS
    );
  }

  private _opForAxiom(predicateIri: string): {
    op: "classification" | "realization";
    bufferMethod: "getInferredTripleBuffer" | "getPropertyTripleBuffer";
  } | null {
    switch (predicateIri) {
      case RDFS_SUB_CLASS_OF:
      case OWL_EQUIVALENT_CLASS:
        return { op: "classification", bufferMethod: "getInferredTripleBuffer" };
      case RDF_TYPE:
        return { op: "realization", bufferMethod: "getInferredTripleBuffer" };
      case RDFS_SUB_PROPERTY_OF:
        return { op: "classification", bufferMethod: "getPropertyTripleBuffer" };
      default:
        return null;
    }
  }

  private async _checkEntailmentDirect(
    candidates: Quad[],
    axiom: Quad,
    opInfo: { op: "classification" | "realization"; bufferMethod: "getInferredTripleBuffer" | "getPropertyTripleBuffer" },
    background: Quad[] = [],
  ): Promise<boolean> {
    // Always include background triples (e.g. rdf:type owl:Class declarations) so
    // Konclude can recognise classes/properties even when they are excluded from the
    // justification candidate set. background triples do not appear in justifications.
    const tripleSet = background.length > 0 ? [...candidates, ...background] : candidates;
    const { tripleBuffer, strTableBuffer } = encodeToBuffers(tripleSet);
    await this._callDirect("sync", [tripleBuffer, strTableBuffer], [tripleBuffer, strTableBuffer]);
    await this._callDirect(opInfo.op, []);
    const buf = (await this._callDirect(opInfo.bufferMethod, [])) as ArrayBuffer;
    const quads = decodeBuffers(buf);
    return quads.some(
      q => q.subject.value === axiom.subject.value &&
           q.predicate.value === axiom.predicate.value &&
           q.object.value === axiom.object.value,
    );
  }

  /**
   * Returns true if the candidate subset is inconsistent.
   * Uses the consistency Worker pipeline (not triple lookup).
   * Safe to call from inside a _queue body.
   */
  private async _checkInconsistencyDirect(candidates: Quad[]): Promise<boolean> {
    const { tripleBuffer, strTableBuffer } = encodeToBuffers(candidates);
    await this._callDirect("sync", [tripleBuffer, strTableBuffer], [tripleBuffer, strTableBuffer]);
    // consistency() runs only the consistency step; a separate classification call first would make an inconsistent
    // set (failed pipeline, marked for retry) pay for a second full rebuild (measured: 480 -> 265 ms on PMDco).
    const consistent = (await this._callDirect("consistency", [])) as boolean;
    return !consistent;
  }

  /**
   * Returns true if `classIRI` is unsatisfiable in the candidate set.
   * Uses buildUnsatisfiableClassBuffer as the oracle (not _checkEntailmentDirect,
   * because buildInferredTripleBuffer suppresses `X rdfs:subClassOf owl:Nothing`).
   * Safe to call from inside a _queue body.
   */
  private async _checkUnsatisfiabilityDirect(candidates: Quad[], classIRI: string): Promise<boolean> {
    const { tripleBuffer, strTableBuffer } = encodeToBuffers(candidates);
    await this._callDirect("sync", [tripleBuffer, strTableBuffer], [tripleBuffer, strTableBuffer]);
    await this._callDirect("classification", []);
    const raw = (await this._callDirect("getUnsatisfiableClassBuffer", [])) as string;
    return raw.split('\n').filter(Boolean).includes(classIRI);
  }

  private async _isSubClassOfDirect(sub: string, sup: string): Promise<boolean> {
    return (await this._callDirect("isSubClassOf", [sub, sup])) as boolean;
  }

  private async _isSatisfiableClassDirect(cls: string): Promise<boolean> {
    return (await this._callDirect("isSatisfiableClass", [cls])) as boolean;
  }

  private async _getSubClassJustificationDirect(sub: string, sup: string): Promise<string> {
    return (await this._callDirect("getSubClassJustification", [sub, sup])) as string;
  }

  private async _hasNativeJustificationDirect(sub: string, sup: string): Promise<boolean> {
    return (await this._callDirect("hasNativeJustification", [sub, sup])) as boolean;
  }

  // EntailmentType enum values matching JustificationCache.h
  private static readonly _ET_CLASSIFICATION = 0;
  private static readonly _ET_REALIZATION = 1;
  private static readonly _ET_PROPERTY_SUBSUMPTION = 2;

  private async _getJustificationByTypeDirect(subIri: string, superIri: string, type: number): Promise<string> {
    return (await this._callDirect("getJustificationByType", [subIri, superIri, type])) as string;
  }

  private async _hasJustificationByTypeDirect(subIri: string, superIri: string, type: number): Promise<boolean> {
    return (await this._callDirect("hasJustificationByType", [subIri, superIri, type])) as boolean;
  }

  private _lookupJustificationFromStore(store: Store, sub: string, pred: string, obj: string): Quad[] | null {
    const explGraphNode = DataFactory.namedNode(EXPLANATION_GRAPH_IRI);
    const quotedTriple = DataFactory.quad(
      DataFactory.namedNode(sub),
      DataFactory.namedNode(pred),
      DataFactory.namedNode(obj),
    );
    const justifiesMatches = store.getQuads(null, DataFactory.namedNode(KJ_JUSTIFIES), quotedTriple as any, explGraphNode);
    if (justifiesMatches.length === 0) return null;

    const axiomQuads: Quad[] = [];
    for (const jMatch of justifiesMatches) {
      const axioms = store.getQuads(jMatch.subject, DataFactory.namedNode(KJ_AXIOM), null, explGraphNode);
      for (const a of axioms) {
        if ((a.object as any).termType === "Quad") {
          axiomQuads.push(a.object as unknown as Quad);
        }
      }
    }
    return axiomQuads;
  }

  private _parseNTriplesJustification(ntriples: string): Quad[] {
    const quads: Quad[] = [];
    for (const line of ntriples.split('\n')) {
      const m = line.match(/^<([^>]+)>\s+<([^>]+)>\s+<([^>]+)>\s*\.$/);
      if (m) {
        quads.push(DataFactory.quad(
          DataFactory.namedNode(m[1]),
          DataFactory.namedNode(m[2]),
          DataFactory.namedNode(m[3]),
        ));
      }
    }
    return quads;
  }

  // Reconstruct FP/IFP justification from base quads: declaration + 2 role assertions
  private static _buildFpIfpJustification(allBase: Quad[], aIri: string, bIri: string): Quad[] {
    const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
    // Collect FP properties
    const fpDecls = allBase.filter(q =>
      q.predicate.value === RDF_TYPE && q.object.value === OWL_FUNCTIONAL_PROPERTY,
    );
    // FP: X prop aIri AND X prop bIri → aIri sameAs bIri (aIri/bIri are the objects)
    for (const decl of fpDecls) {
      const prop = decl.subject.value;
      const aAssertion = allBase.find(q => q.object.value === aIri && q.predicate.value === prop);
      const bAssertion = allBase.find(q => q.object.value === bIri && q.predicate.value === prop);
      if (aAssertion && bAssertion && aAssertion.subject.value === bAssertion.subject.value) {
        return [decl as Quad, aAssertion as Quad, bAssertion as Quad];
      }
    }
    // IFP: aIri prop X AND bIri prop X → aIri sameAs bIri (aIri/bIri are the subjects)
    const ifpDecls = allBase.filter(q =>
      q.predicate.value === RDF_TYPE && q.object.value === OWL_INVERSE_FUNCTIONAL_PROPERTY,
    );
    for (const decl of ifpDecls) {
      const prop = decl.subject.value;
      const aAssertion = allBase.find(q => q.subject.value === aIri && q.predicate.value === prop);
      const bAssertion = allBase.find(q => q.subject.value === bIri && q.predicate.value === prop);
      if (aAssertion && bAssertion && aAssertion.object.value === bAssertion.object.value) {
        return [decl as Quad, aAssertion as Quad, bAssertion as Quad];
      }
    }
    return [];
  }

  // ── TS synthesis helpers ──────────────────────────────────────────
  // For workaround-computed types: justification = relevant input axioms.

  private _synthesizeDomainRangeJustification(
    allBase: Quad[], subjectIri: string, classIri: string,
  ): Quad[] | null {
    const RDFS_DOMAIN = "http://www.w3.org/2000/01/rdf-schema#domain";
    const RDFS_RANGE = "http://www.w3.org/2000/01/rdf-schema#range";

    for (const q of allBase) {
      if (q.predicate.value === RDFS_DOMAIN && q.object.value === classIri) {
        const propIri = q.subject.value;
        const usage = allBase.find(
          u => u.predicate.value === propIri && u.subject.value === subjectIri,
        );
        if (usage) return [usage, q];
      }
      if (q.predicate.value === RDFS_RANGE && q.object.value === classIri) {
        const propIri = q.subject.value;
        const usage = allBase.find(
          u => u.predicate.value === propIri && u.object.value === subjectIri,
        );
        if (usage) return [usage, q];
      }
    }
    return null;
  }

  private _synthesizeDisjointWithJustification(
    allBase: Quad[], subjectIri: string, objectIri: string,
  ): Quad[] | null {
    const OWL_DISJOINT_WITH = "http://www.w3.org/2002/07/owl#disjointWith";
    const direct = allBase.find(
      q => q.subject.value === subjectIri &&
           q.predicate.value === OWL_DISJOINT_WITH &&
           q.object.value === objectIri,
    );
    if (direct) return [direct];

    const reverse = allBase.find(
      q => q.subject.value === objectIri &&
           q.predicate.value === OWL_DISJOINT_WITH &&
           q.object.value === subjectIri,
    );
    if (reverse) return [reverse];

    return null;
  }

  private _synthesizeRestrictionJustification(
    allBase: Quad[], store: Store, subjectIri: string, classIri: string,
  ): Quad[] | null {
    const OWL_EQUIV = "http://www.w3.org/2002/07/owl#equivalentClass";
    const OWL_ON_PROP = "http://www.w3.org/2002/07/owl#onProperty";
    const OWL_SOME = "http://www.w3.org/2002/07/owl#someValuesFrom";
    const OWL_ALL = "http://www.w3.org/2002/07/owl#allValuesFrom";
    const OWL_HAS_VALUE = "http://www.w3.org/2002/07/owl#hasValue";
    const OWL_COMPLEMENT = "http://www.w3.org/2002/07/owl#complementOf";
    const RDFS_SUBCLASS = "http://www.w3.org/2000/01/rdf-schema#subClassOf";
    const ig = INFERRED_GRAPH_IRI;

    const restrictionNodes = allBase
      .filter(q =>
        (q.predicate.value === OWL_EQUIV || q.predicate.value === RDFS_SUBCLASS) &&
        q.subject.value === classIri)
      .map(q => ({ link: q, bnode: q.object.value }));

    for (const { link, bnode } of restrictionNodes) {
      const propQuad = allBase.find(q => q.subject.value === bnode && q.predicate.value === OWL_ON_PROP);
      if (!propQuad) {
        const complementQuad = allBase.find(q => q.subject.value === bnode && q.predicate.value === OWL_COMPLEMENT);
        if (complementQuad) {
          const complementClass = complementQuad.object.value;
          const notMember = !allBase.some(
            q => q.subject.value === subjectIri && q.predicate.value === RDF_TYPE && q.object.value === complementClass,
          ) && !store.getQuads(
            DataFactory.namedNode(subjectIri), DataFactory.namedNode(RDF_TYPE),
            DataFactory.namedNode(complementClass), DataFactory.namedNode(ig),
          ).length;
          if (notMember) {
            const memberType = allBase.find(
              q => q.subject.value === subjectIri && q.predicate.value === RDF_TYPE &&
                   q.object.value !== OWL_THING && q.object.value !== classIri,
            );
            if (memberType) return [memberType, link, complementQuad];
            return [link, complementQuad];
          }
        }
        continue;
      }

      const propIri = propQuad.object.value;

      const someQuad = allBase.find(q => q.subject.value === bnode && q.predicate.value === OWL_SOME);
      if (someQuad) {
        const usage = allBase.find(
          q => q.subject.value === subjectIri && q.predicate.value === propIri,
        );
        if (usage) return [usage, link, propQuad, someQuad];
        const usageInferred = store.getQuads(
          DataFactory.namedNode(subjectIri), DataFactory.namedNode(propIri), null, DataFactory.namedNode(ig),
        );
        if (usageInferred.length > 0) return [usageInferred[0], link, propQuad, someQuad];
        const inverseUsage = allBase.find(
          q => q.object.value === subjectIri && q.predicate.value === propIri,
        );
        if (inverseUsage) return [inverseUsage, link, propQuad, someQuad];
        continue;
      }

      const allQuad = allBase.find(q => q.subject.value === bnode && q.predicate.value === OWL_ALL);
      if (allQuad) {
        const usage = allBase.find(
          q => q.subject.value === subjectIri && q.predicate.value === propIri,
        );
        if (usage) return [usage, link, propQuad, allQuad];
        return [link, propQuad, allQuad];
      }

      const hasValQuad = allBase.find(q => q.subject.value === bnode && q.predicate.value === OWL_HAS_VALUE);
      if (hasValQuad) {
        const usage = allBase.find(
          q => q.subject.value === subjectIri && q.predicate.value === propIri &&
               q.object.value === hasValQuad.object.value,
        );
        if (usage) return [usage, link, propQuad, hasValQuad];
        continue;
      }
    }

    // No reverse-someValuesFrom synthesis: [p(x,y), x:C, C ≡/⊑ ∃p.F] does not entail y:F (the witness may be another
    // individual), so it is never a justification for y:F.

    return null;
  }

  // -------------------------------------------------------------------------
  // explain()
  // -------------------------------------------------------------------------

  /** Compute minimal justifications for an axiom (QuickXplain over axiom units, see _minimalUnitSets).
   *
   * Returns a list of minimal subsets of the store's base quads, each of which
   * alone entails the axiom. Returns [] if the axiom is not entailed.
   * Each inner Quad[] is a minimal justification.
   *
   * Throws for unsupported predicates (unlike isEntailed which returns null).
   *
   * All reasoner sub-calls run inside this method's single _queue slot using
   * _callDirect. Do NOT call the public methods classify/materialize from inside.
   */
  explain(store: Store, axiom: Quad, opts?: ExplainOptions): Promise<Quad[][]> {
    const maxJustifications = opts?.maxJustifications ?? 1;

    // Fast-path: maxJustifications === 0
    if (maxJustifications === 0) {
      return Promise.resolve([]);
    }

    const opInfo = this._opForAxiom(axiom.predicate.value);
    if (opInfo === null) {
      return Promise.reject(
        new Error(`explain: unsupported predicate <${axiom.predicate.value}>`)
      );
    }

    const result = this._queue.then(async () => {
      // Partition base quads into:
      //   allCandidates — justification candidates (built-in declarations excluded)
      //   background    — built-in declarations always passed to WASM so Konclude
      //                   can recognise classes/properties, but never returned as
      //                   part of a justification
      const igIri = opts?.inferredGraph ?? INFERRED_GRAPH_IRI;
      const allCandidates: Quad[] = [];
      const background: Quad[] = [];
      for (const q of store.getQuads(null, null, null, null)) {
        const g = q.graph.value;
        if (g === igIri || g === HYPOTHETICAL_IRI || this._excludeGraphs.has(g)) continue;
        if (this._isBuiltInDeclaration(q)) {
          background.push(q);
          continue;
        }
        if (opts?.axiomFilter && !opts.axiomFilter(q)) continue;
        allCandidates.push(q);
      }

      // Invalidate all caches (sub-calls use WASM directly)
      this._classifyCache = null;
      this._materializeCache = null;
      this._classifyPropertiesCache = null;
      this._lastExplBuffer = null;
      this._lastPropertyExplBuffer = null;
      this._consistencyCache = null;

      // Fast-path: axiom not entailed at all
      const entailedByAll = await this._checkEntailmentDirect(allCandidates, axiom, opInfo, background);
      if (!entailedByAll) return [];

      // Minimal justifications over axiom units (QuickXplain + hitting-set tree). The oracle is the reasoner's own
      // entailment test of this axiom; declarations stay background of every check and are not part of the result.
      const timeoutMs = opts?.timeout ?? 180_000;
      const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Infinity;
      return this._minimalUnitSets(
        [...allCandidates, ...background],
        (quads, d) => this._boundedCheck(q => this._checkEntailmentDirect(q, axiom, opInfo), quads, d),
        maxJustifications,
        deadline,
        false,
      );
    });
    this._queue = result.then(() => {}, () => {});
    return result;
  }

  // -------------------------------------------------------------------------
  // explainInconsistency()
  // -------------------------------------------------------------------------

  /** Compute minimal inconsistent sub-ontologies (MIPS) for an inconsistent
   *  ontology. Returns [] if the ontology is consistent.
   *
   * Uses the consistency oracle directly (loadTripleBuffer → classification →
   * consistency) for all justification-search iterations. Does not depend on
   * owl:Thing rdfs:subClassOf owl:Nothing being emitted as an inferred triple.
   */
  explainInconsistency(store: Store, opts?: ExplainOptions): Promise<Quad[][]> {
    const result = this._queue.then(async () => {
      const ig = opts?.inferredGraph ?? INFERRED_GRAPH_IRI;
      // Build base quads (exclude inferred/hypothetical graphs)
      // Annotation assertions never affect consistency (OWL 2 DL): leave them out of every check.
      const allBase = dropAnnotationTriples(store.getQuads(null, null, null, null).filter(q => {
        const g = q.graph.value;
        return g !== ig && g !== HYPOTHETICAL_IRI && !this._excludeGraphs.has(g);
      }));

      // The worker state tells what must be repeated: _sync() answers with the content generation. The same generation
      // and options have the same explanation (cached below), and the consistency verdict of the synced content is
      // memoised per generation in the kernel, so it is asked there instead of re-syncing a filtered copy of the store.
      const gen = await this._sync(store, ig);
      const cacheKey = opts?.axiomFilter ? null : `${gen}|${ig}|${opts?.maxJustifications ?? 1}`;
      if (cacheKey !== null && this._inconsistencyExplainCache?.key === cacheKey) return this._inconsistencyExplainCache.result;
      let consistent: boolean;
      if (this._consistencyCache?.gen === gen) {
        consistent = this._consistencyCache.result;
      } else if (store.getQuads(null, null, null, DataFactory.namedNode(HYPOTHETICAL_IRI)).length === 0) {
        // synced content == the store minus the excluded graphs (annotation assertions never affect consistency)
        consistent = (await this._callDirect("consistency", [])) as boolean;
        this._consistencyCache = { gen, result: consistent };
      } else {
        consistent = !(await this._checkInconsistencyDirect(allBase));
        this._consistencyCache = { gen, result: consistent };
      }

      // Invalidate other caches (sub-calls modify WASM state)
      this._classifyCache = null;
      this._materializeCache = null;
      this._classifyPropertiesCache = null;
      this._lastExplBuffer = null;
      this._lastPropertyExplBuffer = null;

      if (consistent) return [];

      const maxJustifications = opts?.maxJustifications ?? 1;
      if (maxJustifications === 0) return [];

      // Build candidates: exclude only inferred/hypothetical graphs and user filter.
      // Unlike explain(), we do NOT apply _isBuiltInDeclaration here because
      // rdf:type owl:Class declarations are semantically meaningful for
      // ABox inconsistency (Konclude requires them to recognize disjoint classes).
      const allCandidates = dropAnnotationTriples(store.getQuads(null, null, null, null).filter(q => {
        const g = q.graph.value;
        if (g === ig || g === HYPOTHETICAL_IRI || this._excludeGraphs.has(g)) return false;
        if (opts?.axiomFilter && !opts.axiomFilter(q)) return false;
        return true;
      }));

      const timeoutMs = opts?.timeout ?? 180_000;
      const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Infinity;
      const isExpired = () => Date.now() >= deadline;

      // Invalidate caches before the justification-search sub-calls (we already ran one consistency check)
      this._classifyCache = null;
      this._materializeCache = null;
      this._classifyPropertiesCache = null;
      this._lastExplBuffer = null;
      this._lastPropertyExplBuffer = null;
      this._consistencyCache = null;

      // Verify full candidate set is inconsistent after axiomFilter — skip when no filter
      // (we already confirmed inconsistency above) to avoid a costly redundant WASM reload.
      if (opts?.axiomFilter) {
        if (isExpired()) return [];
        if (!(await this._checkInconsistencyDirect(allCandidates))) return [];
      }

      const found = await this._explainInconsistencyQuadsDirect(allCandidates, maxJustifications, deadline);
      if (cacheKey !== null && Date.now() < deadline) {
        // The search loaded sub-ontologies; load the store's content again (cheap: the rebuild is lazy) so the worker state,
        // its generation and the cached answer describe the same content. A search cut short by the deadline is not cached.
        const genAfter = await this._sync(store, ig);
        this._inconsistencyExplainCache = { key: `${genAfter}|${ig}|${maxJustifications}`, result: found };
        this._consistencyCache = { gen: genAfter, result: false };
      }
      return found;
    });
    this._queue = result.then(() => {}, () => {});
    return result;
  }

  /**
   * Weaken a culprit `rdfs:subClassOf` axiom instead of deleting it. `culprit` is an `Axiom` from `repair()` or
   * `explainInconsistencyAxioms()`. Supported (v1): `X subClassOf Y` and `X subClassOf (B1 and ... and Bn)` with named
   * classes; anything else returns `reason: 'unsupported-axiom'`.
   *
   * Offers, most specific first: a conjunct generalized to a named superclass (only the most specific working ones; the
   * superclasses form a DAG and everything above a working one is pruned), a conjunct dropped, and finally the deletion.
   * Every weakening is verified on a copy: the edited ontology is consistent and the target class stays satisfiable.
   * Candidates already entailed without the culprit are skipped. Never mutates the store and never throws for a deadline
   * (`incomplete: true`). The reasoner's own state is left on the last edited copy, so the next normal call reloads once.
   */
  weaken(store: Store, culprit: Axiom, opts?: WeakenOptions): Promise<WeakenResult> {
    if (typeof (store as { getQuads?: unknown } | null)?.getQuads !== "function") {
      return Promise.reject(new TypeError("weaken: store must be an N3 Store"));
    }
    if (!culprit || typeof culprit !== "object" || !culprit.principal || !Array.isArray(culprit.quads)) {
      return Promise.reject(new TypeError("weaken: culprit must be an Axiom ({ principal, quads })"));
    }
    const result = this._queue.then(async () => {
      const ig = opts?.inferredGraph ?? INFERRED_GRAPH_IRI;
      const graphsToIgnore = new Set<string>([ig, HYPOTHETICAL_IRI, EXPLANATION_GRAPH_IRI, ...this._excludeGraphs]);
      const base = store.getQuads(null, null, null, null).filter(q => !graphsToIgnore.has(q.graph.value));
      const timeoutMs = opts?.timeout ?? 180_000;
      const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Infinity;
      const oracle: AssessOracle = {
        inconsistent: quads => this._boundedInconsistencyCheck(quads, deadline),
        unsatisfiable: quads => this._unsatisfiableClassesDirect(quads, deadline),
        subClassPairs: quads => this._subClassPairsDirect(quads, deadline),
      };
      try {
        return await computeWeakenings({ base, culprit, oracle, deadline });
      } finally {
        // sub-calls replaced the WASM state: every generation-keyed cache is stale
        this._classifyCache = null;
        this._materializeCache = null;
        this._classifyPropertiesCache = null;
        this._consistencyCache = null;
        this._lastExplBuffer = null;
        this._lastPropertyExplBuffer = null;
      }
    });
    this._queue = result.then(() => {}, () => {});
    return result;
  }

  /**
   * What does a proposed edit cost? Applies `edit` (removals by exact quad identity, then additions) to a copy and
   * reports whether the result is consistent and which asserted class-disjointness pairs are no longer entailed.
   *
   * The pairs to protect are the asserted disjointness pairs of the unedited store (`owl:disjointWith`,
   * `owl:AllDisjointClasses`, `owl:disjointUnionOf`, named classes), read syntactically, so this works on an inconsistent
   * store (the typical input: the edit is a repair). They are tested after the edit in one batch with probe classes.
   * `lostDisjointPairs` is `null` when the edited ontology is itself inconsistent. Never mutates the caller's store and
   * never throws for a deadline (`incomplete: true`, `reason: 'deadline'`). The reasoner's own state is left on the edited
   * copy, so the caller's next normal call reloads once.
   */
  assessEdit(store: Store, edit: Edit, opts?: AssessEditOptions): Promise<EditAssessment> {
    if (typeof (store as { getQuads?: unknown } | null)?.getQuads !== "function") {
      return Promise.reject(new TypeError("assessEdit: store must be an N3 Store"));
    }
    if (edit === null || typeof edit !== "object") return Promise.reject(new TypeError("assessEdit: edit must be an object"));
    const result = this._queue.then(async () => {
      const ig = opts?.inferredGraph ?? INFERRED_GRAPH_IRI;
      const graphsToIgnore = new Set<string>([ig, HYPOTHETICAL_IRI, EXPLANATION_GRAPH_IRI, ...this._excludeGraphs]);
      const base = store.getQuads(null, null, null, null).filter(q => !graphsToIgnore.has(q.graph.value));
      const timeoutMs = opts?.timeout ?? 180_000;
      const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Infinity;
      const oracle: AssessOracle = {
        inconsistent: quads => this._boundedInconsistencyCheck(quads, deadline),
        unsatisfiable: quads => this._unsatisfiableClassesDirect(quads, deadline),
        subClassPairs: quads => this._subClassPairsDirect(quads, deadline),
      };
      try {
        return await computeAssessment({ base, edit, opts, oracle });
      } finally {
        // sub-calls replaced the WASM state: every generation-keyed cache is stale
        this._classifyCache = null;
        this._materializeCache = null;
        this._classifyPropertiesCache = null;
        this._consistencyCache = null;
        this._lastExplBuffer = null;
        this._lastPropertyExplBuffer = null;
      }
    });
    this._queue = result.then(() => {}, () => {});
    return result;
  }

  /**
   * Compute repairs for an inconsistent store: complete sets of axioms whose removal restores consistency.
   *
   * Lazy candidate / verify / refine loop (see ts/repair.ts): explain the inconsistency, take the minimal hitting
   * sets of the justifications as candidates, verify each on an edited copy, and when a candidate still fails
   * explain the edited copy to discover more justifications. Every verified set is inclusion-minimal.
   * Never mutates the caller's store and never throws for a deadline (`incomplete: true` with a `reason`).
   * A kernel trap during explanation recycles the Worker and returns `reason: 'explain-failed'`.
   *
   * The reasoner's own state is left on the last edited copy, so the caller's next normal call reloads once
   * (about 0.6 s on PMDco). Result order of `repairs` is by cost then size (size only without `cost`), ties unspecified.
   * Quads inside axioms are equal by value to those in the store (N3 creates quad objects on demand).
   */
  repair(store: Store, opts?: RepairOptions): Promise<RepairResult> {
    if (typeof (store as { getQuads?: unknown } | null)?.getQuads !== "function") {
      return Promise.reject(new TypeError("repair: store must be an N3 Store"));
    }
    const result = this._queue.then(async () => {
      const ig = opts?.inferredGraph ?? INFERRED_GRAPH_IRI;
      const graphsToIgnore = new Set<string>([ig, HYPOTHETICAL_IRI, EXPLANATION_GRAPH_IRI, ...this._excludeGraphs]);
      // Annotation assertions never affect consistency (OWL 2 DL): leave them out of every check.
      const base = dropAnnotationTriples(store.getQuads(null, null, null, null).filter(q => !graphsToIgnore.has(q.graph.value)));
      const timeoutMs = opts?.timeout ?? REPAIR_DEFAULT_TIMEOUT_MS;
      const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Infinity;
      const oracle: RepairOracle = {
        inconsistent: quads => this._boundedInconsistencyCheck(quads, deadline),
        explain: (quads, max) => this._explainInconsistencyQuadsDirect(quads, max, deadline),
      };
      let out: RepairResult;
      try {
        out = await computeRepairs({ store, base, graphsToIgnore, oracle, opts, deadline });
      } finally {
        // sub-calls replaced the WASM state: every generation-keyed cache is stale
        this._classifyCache = null;
        this._materializeCache = null;
        this._classifyPropertiesCache = null;
        this._consistencyCache = null;
        this._lastExplBuffer = null;
        this._lastPropertyExplBuffer = null;
      }
      if (out.incomplete && out.reason === "explain-failed") {
        // A trap leaves the Worker unusable (the next call would hang): replace it now.
        await this._recycleWorkerInSlot().catch(() => {});
      }
      return out;
    });
    this._queue = result.then(() => {}, () => {});
    return result;
  }

  /**
   * Like `explainInconsistency`, but each justification is grouped into OWL axioms (a restriction axiom is
   * one unit of several triples) and declarations (`C a owl:Class`, ...) are returned separately in `context`
   * instead of as removable members. Every returned quad is an exact instance from the store; `Axiom.quads`
   * includes every graph copy of each triple. Same options as `explainInconsistency`. Result order is unspecified.
   */
  async explainInconsistencyAxioms(store: Store, opts?: ExplainOptions): Promise<AxiomJustification[]> {
    const justifications = await this.explainInconsistency(store, opts);
    const ignore = new Set<string>([opts?.inferredGraph ?? INFERRED_GRAPH_IRI, HYPOTHETICAL_IRI, EXPLANATION_GRAPH_IRI, ...this._excludeGraphs]);
    return justifications.map(j => groupJustification(j, store, ignore));
  }

  /**
   * Slot-held consistency check of an explicit quad set, bounded by an absolute deadline.
   * Races the WASM call against a per-call timer so a hung tableau (infinite expansion for certain partial TBox
   * subsets) can be interrupted: on timeout the Worker is terminated and recreated and "aborted" is returned.
   * Also recycles the Worker first when the WASM heap passed the recycle threshold (every reload retains ~20 MB;
   * a long search would otherwise hit the 4 GiB wasm32 ceiling and trap). Returns true when INCONSISTENT.
   */
  private _boundedInconsistencyCheck(quads: Quad[], deadline: number): Promise<boolean | "aborted"> {
    return this._boundedCheck(q => this._checkInconsistencyDirect(q), quads, deadline);
  }

  /**
   * Runs one reasoner oracle (inconsistency, entailment, unsatisfiability, ...) on a quad set with the remaining deadline:
   * a probe that exceeds it is abandoned, the Worker is recreated and "aborted" is returned.
   */
  private async _boundedCheck(
    check: (quads: Quad[]) => Promise<boolean>,
    quads: Quad[],
    deadline: number,
  ): Promise<boolean | "aborted"> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return "aborted";
    if (this._recycleHeapBytes > 0 && this._lastHeapBytes > this._recycleHeapBytes) await this._recycleWorkerInSlot();
    const perCallMs = Math.min(remaining + 1_000, 30_000);
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timerPromise = new Promise<"aborted">(resolve => {
      timeoutHandle = setTimeout(() => resolve("aborted"), perCallMs);
    });
    try {
      const result = await Promise.race([
        check(quads).then(r => r as boolean | "aborted"),
        timerPromise,
      ]);
      if (result === "aborted") await this._reinitForBisection();
      return result;
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  /**
   * Slot-held opt-in guard (`failOnInconsistent`): throws InconsistentOntologyError when the content synced last (generation
   * `gen`) is inconsistent. The consistency result is memoised per generation; `direct` selects the slot-held call path.
   */
  private async _guardConsistent(gen: number, opts?: { failOnInconsistent?: boolean }, direct = false): Promise<void> {
    if (!opts?.failOnInconsistent) return;
    let consistent: boolean;
    if (this._consistencyCache !== null && this._consistencyCache.gen === gen) consistent = this._consistencyCache.result;
    else {
      consistent = (await (direct ? this._callDirect("consistency", []) : this._call("consistency", []))) as boolean;
      this._consistencyCache = { gen, result: consistent };
    }
    if (!consistent) throw new InconsistentOntologyError();
  }

  /** `X owl:disjointWith Y` between two named classes. */
  private _isDisjointAxiom(q: Quad): boolean {
    return q.predicate.value === "http://www.w3.org/2002/07/owl#disjointWith" && q.subject.termType === "NamedNode" && q.object.termType === "NamedNode";
  }

  /**
   * Slot-held: are the class pairs of these `owl:disjointWith` axioms entailed disjoint by the store's ontology? Decided in one
   * batch with probe classes (`P rdfs:subClassOf A, B` is unsatisfiable exactly when A and B are disjoint, or an endpoint is
   * unsatisfiable, in which case the disjointness holds vacuously and `vacuous` is set). `entailed: null` for every axiom when the ontology is inconsistent
   * (every pair is then vacuously entailed, which says nothing). The probe load replaces the WASM state: the caller invalidates caches.
   */
  private async _disjointEntailmentsDirect(store: Store, inferredGraph: string, axioms: Quad[]): Promise<Array<{ entailed: boolean | null; vacuous: boolean }>> {
    const ignore = new Set<string>([inferredGraph, HYPOTHETICAL_IRI, EXPLANATION_GRAPH_IRI, ...this._excludeGraphs]);
    const base = dropAnnotationTriples(store.getQuads(null, null, null, null).filter(q => !ignore.has(q.graph.value)));
    const inconsistent = await this._boundedInconsistencyCheck(base, Infinity);
    if (inconsistent !== false) return axioms.map(() => ({ entailed: null, vacuous: false }));
    const pairOf = (a: Quad): string => (a.subject.value < a.object.value ? `${a.subject.value}\0${a.object.value}` : `${a.object.value}\0${a.subject.value}`);
    const index = new Map<string, number>();
    const pairs: DisjointPair[] = [];
    for (const a of axioms) {
      const k = pairOf(a);
      if (index.has(k)) continue;
      index.set(k, pairs.length);
      pairs.push(a.subject.value < a.object.value ? { a: a.subject.value, b: a.object.value } : { a: a.object.value, b: a.subject.value });
    }
    const unsat = await this._unsatisfiableClassesDirect([...base, ...probeQuads(pairs)], Infinity);
    if (unsat === "aborted") return axioms.map(() => ({ entailed: null, vacuous: false }));
    return axioms.map(a => {
      const entailed = unsat.has(`${PROBE_NS}${index.get(pairOf(a))}`);
      return { entailed, vacuous: entailed && (unsat.has(a.subject.value) || unsat.has(a.object.value)) };
    });
  }

  /** Every generation-keyed result cache is stale (sub-calls replaced the WASM state). */
  private _invalidateResultCaches(): void {
    this._classifyCache = null;
    this._materializeCache = null;
    this._classifyPropertiesCache = null;
    this._consistencyCache = null;
    this._lastExplBuffer = null;
    this._lastPropertyExplBuffer = null;
  }

  /**
   * Run slot-held reasoner work bounded by an absolute deadline: "aborted" when the deadline is (about to be) reached.
   * On a timeout the hung Worker is replaced (as in _boundedInconsistencyCheck). Heap-recycles the Worker first.
   */
  private async _withDeadline<T>(work: () => Promise<T>, deadline: number): Promise<T | "aborted"> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return "aborted";
    if (this._recycleHeapBytes > 0 && this._lastHeapBytes > this._recycleHeapBytes) await this._recycleWorkerInSlot();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timer = new Promise<"aborted">(resolve => {
      timeoutHandle = setTimeout(() => resolve("aborted"), Math.min(remaining + 1_000, 120_000));
    });
    try {
      const result = await Promise.race([work(), timer]);
      if (result === "aborted") await this._reinitForBisection();
      return result;
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  /** Slot-held: IRIs of the unsatisfiable classes of an explicit (consistent) quad set. */
  private _unsatisfiableClassesDirect(quads: Quad[], deadline: number): Promise<Set<string> | "aborted"> {
    return this._withDeadline(async () => {
      const { tripleBuffer, strTableBuffer } = encodeToBuffers(quads);
      await this._callDirect("sync", [tripleBuffer, strTableBuffer], [tripleBuffer, strTableBuffer]);
      await this._callDirect("classification", []);
      const raw = (await this._callDirect("getUnsatisfiableClassBuffer", [])) as string;
      return new Set(raw.split("\n").filter(Boolean));
    }, deadline);
  }

  /** Slot-held: entailed named rdfs:subClassOf pairs [sub, super] of an explicit (consistent) quad set. */
  private _subClassPairsDirect(quads: Quad[], deadline: number): Promise<Array<[string, string]> | "aborted"> {
    return this._withDeadline(async () => {
      const { tripleBuffer, strTableBuffer } = encodeToBuffers(quads);
      await this._callDirect("sync", [tripleBuffer, strTableBuffer], [tripleBuffer, strTableBuffer]);
      await this._callDirect("classification", []);
      const buf = (await this._callDirect("getInferredTripleBuffer", [])) as ArrayBuffer;
      return decodeBuffers(buf)
        .filter(q => q.predicate.value === RDFS_SUB_CLASS_OF && q.subject.termType === "NamedNode" && q.object.termType === "NamedNode")
        .map(q => [q.subject.value, q.object.value] as [string, string]);
    }, deadline);
  }

  /**
   * Replace the Worker from inside a _queue slot (heap recycle). Each check re-syncs the full quad set, so no WASM
   * state needs replaying; the slot's queue position is preserved.
   */
  private async _recycleWorkerInSlot(): Promise<void> {
    const queue = this._queue;
    await this._reinitForBisection();
    this._queue = queue;
    this._lastHeapBytes = 0;
  }

  /**
   * Slot-held MIPS search over an explicit quad set that is already known to be inconsistent.
   * Must be called from inside a _queue slot (uses _callDirect only; never the public methods).
   * `deadline` is an absolute Date.now() value (Infinity = none). Returns [] when no justification is found.
   *
   * The search runs over AXIOM UNITS, not triples (see ts/axiomGrouping.ts): a triple-level subset can contain part
   * of an RDF list or a restriction, which is a different, stronger axiom for the reasoner and yields false
   * justifications. Declaration triples are fixed background of every check. A justification whose search was cut
   * short by the deadline is dropped (it would not be minimal). Each returned justification carries the declarations
   * of the entities it mentions.
   */
  private _explainInconsistencyQuadsDirect(
    allCandidates: Quad[],
    maxJustifications: number,
    deadline: number,
  ): Promise<Quad[][]> {
    return this._minimalUnitSets(allCandidates, (quads, d) => this._boundedInconsistencyCheck(quads, d), maxJustifications, deadline);
  }

  /**
   * The one engine behind every explanation: minimal sets of axiom units for which `holds` is true (the set is
   * inconsistent / entails the axiom / makes a class unsatisfiable), by QuickXplain plus a hitting-set tree.
   * `holds` receives a quad set (units plus the declaration background) and the deadline. With `withDeclarations` false
   * the declarations of the mentioned entities are left out of each result.
   */
  private async _minimalUnitSets(
    allCandidates: Quad[],
    holds: (quads: Quad[], deadline: number) => Promise<boolean | "aborted">,
    maxJustifications: number,
    deadline: number,
    withDeclarations = true,
  ): Promise<Quad[][]> {
    const isExpired = () => Date.now() >= deadline;
    const { units, background } = partitionIntoUnits(allCandidates);
    const checkOrAbort = (idx: readonly number[]): Promise<boolean | "aborted"> =>
      holds([...idx.flatMap(i => units[i]), ...background], deadline);
    const idKey = (idx: Iterable<number>): string => [...idx].sort((x, y) => x - y).join(",");

    // QuickXplain (Junker 2004): a minimal inconsistent set of units in about 2*k*log2(n/k) consistency checks for a
    // justification of k units.
    const ABORT = Symbol("explain-abort");
    const findOneJustification = async (candidates: number[]): Promise<number[] | null> => {
      if (candidates.length === 0) return [];
      const inconsistent = async (set: number[]): Promise<boolean> => {
        const r = await checkOrAbort(set);
        if (r === "aborted") throw ABORT;
        return r;
      };
      const qx = async (bg: number[], hasDelta: boolean, c: number[]): Promise<number[]> => {
        if (hasDelta && (await inconsistent(bg))) return [];
        if (c.length === 1) return c;
        const k = c.length >> 1;
        const c1 = c.slice(0, k);
        const c2 = c.slice(k);
        const d2 = await qx([...bg, ...c1], c1.length > 0, c2);
        const d1 = await qx([...bg, ...d2], d2.length > 0, c1);
        return [...d1, ...d2];
      };
      try {
        return await qx([], false, candidates);
      } catch (e) {
        if (e === ABORT) return null;
        throw e;
      }
    };

    const all = units.map((_, i) => i);
    const found: number[][] = [];
    const foundKeys = new Set<string>();
    const j1 = await findOneJustification(all);
    if (!j1 || j1.length === 0) return [];
    found.push(j1);
    foundKeys.add(idKey(j1));

    if (!isExpired() && maxJustifications > 1) {
      // HSDAG queue: pairs of (excluded units, justification to expand from)
      const hsQueue: Array<{ excluded: Set<number>; justification: number[] }> = [{ excluded: new Set(), justification: j1 }];
      const explored = new Set<string>();
      while (!isExpired() && hsQueue.length > 0 && found.length < maxJustifications) {
        const { excluded, justification: currentJ } = hsQueue.shift()!;
        const excludedKey = idKey(excluded);
        if (explored.has(excludedKey)) continue;
        explored.add(excludedKey);
        for (const u of currentJ) {
          if (isExpired()) break;
          const newExcluded = new Set(excluded).add(u);
          if (explored.has(idKey(newExcluded))) continue;
          const reduced = all.filter(i => !newExcluded.has(i));
          const rCheck = await checkOrAbort(reduced);
          if (rCheck === "aborted" || !rCheck) continue;
          const jNew = await findOneJustification(reduced);
          if (!jNew || jNew.length === 0) continue;
          const k = idKey(jNew);
          if (foundKeys.has(k)) continue;
          foundKeys.add(k);
          found.push(jNew);
          if (found.length >= maxJustifications) break;
          hsQueue.push({ excluded: newExcluded, justification: jNew });
        }
      }
    }

    return found.map(idx => {
      const quads = idx.flatMap(i => units[i]);
      if (!withDeclarations) return quads;
      const iris = new Set<string>();
      for (const q of quads) for (const t of [q.subject, q.predicate, q.object]) if (t.termType === "NamedNode") iris.add(t.value);
      return [...quads, ...background.filter(d => iris.has(d.subject.value))];
    });
  }

  // -------------------------------------------------------------------------
  // explainInconsistencyLaconic()
  // -------------------------------------------------------------------------

  /** Compute MIPS justifications for an inconsistent ontology and post-process
   *  each via the Horridge laconic algorithm to identify exactly which part of
   *  each axiom drives the clash.
   *
   *  Returns [] if the ontology is consistent.
   *  Returns [] if `opts.maxJustifications === 0`.
   *  When the cost cap (`laconicMaxAxioms` / `laconicMaxParts`) is exceeded for
   *  a justification, that entry has `laconic.skipped === true`.
   */
  explainInconsistencyLaconic(
    store: Store,
    opts?: LaconicExplainOptions,
  ): Promise<Array<{ justification: Quad[]; laconic: LaconicJustification }>> {
    const maxAxioms = opts?.laconicMaxAxioms ?? 20;
    const maxParts = opts?.laconicMaxParts ?? 40;

    const result = this._queue.then(async () => {
      const ig = opts?.inferredGraph ?? INFERRED_GRAPH_IRI;
      // Get MIPS justifications (reuse explainInconsistency logic inline)
      const allBase = store.getQuads(null, null, null, null).filter(q => {
        const g = q.graph.value;
        return g !== ig && g !== HYPOTHETICAL_IRI && !this._excludeGraphs.has(g);
      });

      const gen = await this._sync(store, ig);
      let consistent: boolean;
      if (this._consistencyCache?.gen === gen) {
        consistent = this._consistencyCache.result;
      } else {
        consistent = !(await this._checkInconsistencyDirect(allBase));
        this._consistencyCache = { gen, result: consistent };
      }

      this._classifyCache = null;
      this._materializeCache = null;
      this._classifyPropertiesCache = null;
      this._lastExplBuffer = null;
      this._lastPropertyExplBuffer = null;

      if (consistent) return [];

      const maxJustifications = opts?.maxJustifications ?? 1;
      if (maxJustifications === 0) return [];

      const allCandidates = store.getQuads(null, null, null, null).filter(q => {
        const g = q.graph.value;
        if (g === ig || g === HYPOTHETICAL_IRI || this._excludeGraphs.has(g)) return false;
        if (opts?.axiomFilter && !opts.axiomFilter(q)) return false;
        return true;
      });

      const timeoutMs = opts?.timeout ?? 180_000;
      const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Infinity;
      const isExpired = () => Date.now() >= deadline;

      this._classifyCache = null;
      this._materializeCache = null;
      this._classifyPropertiesCache = null;
      this._lastExplBuffer = null;
      this._lastPropertyExplBuffer = null;
      this._consistencyCache = null;

      if (opts?.axiomFilter) {
        if (isExpired()) return [];
        if (!(await this._checkInconsistencyDirect(allCandidates))) return [];
      }

      // Minimal inconsistent unit sets (the shared engine: QuickXplain + hitting-set tree)
      const justifications: Quad[][] = await this._minimalUnitSets(
        allCandidates,
        (quads, d) => this._boundedInconsistencyCheck(quads, d),
        maxJustifications,
        deadline,
        false,
      );
      if (justifications.length === 0) return [];

      // Post-process each justification with laconic
      const out: Array<{ justification: Quad[]; laconic: LaconicJustification }> = [];

      for (const j of justifications) {
        const { axioms, sourceQuads } = groupQuadsIntoAxioms(j, allBase);

        const totalParts = axioms.reduce((n, ax) => n + splitAxiom(ax).length, 0);
        if (axioms.length > maxAxioms || totalParts > maxParts) {
          out.push({
            justification: j,
            laconic: {
              parts: axioms.map(ax => ({
                quad: ax[0],
                sourceQuad: ax[0],
                isPartOf: false,
              })),
              sharpened: false,
              skipped: true,
            },
          });
          continue;
        }

        // Map split-part keys → original source quads so the oracle can
        // resolve any sub-part back to its parent axiom's full RDF encoding.
        const partKeyToSource = new Map<string, Quad[]>();
        for (const ax of axioms) {
          const src = sourceQuads.get(axiomKey(ax)) ?? ax;
          for (const part of splitAxiom(ax)) {
            partKeyToSource.set(axiomKey(part), src);
          }
          // Also map the original axiom key itself
          partKeyToSource.set(axiomKey(ax), src);
        }

        const entails = async (parts: Quad[][]): Promise<boolean> => {
          const quads: Quad[] = [];
          for (const p of parts) {
            const k = axiomKey(p);
            const src = partKeyToSource.get(k);
            quads.push(...(src ?? p));
          }
          return this._checkInconsistencyDirect(quads);
        };

        const { laconic, sources } = await computeLaconicAsync(axioms, entails);
        const sharpened = laconic.length !== axioms.length
          || laconic.some(p => !sourceQuads.has(axiomKey(p)));

        out.push({
          justification: j,
          laconic: {
            parts: laconic.map(part => {
              const source = sources.get(part) ?? part;
              return {
                quad: part[0],
                sourceQuad: source[0],
                isPartOf: axiomKey(part) !== axiomKey(source),
              };
            }),
            sharpened,
            skipped: false,
          },
        });
      }

      return out;
    });
    this._queue = result.then(() => {}, () => {});
    return result;
  }

  // -------------------------------------------------------------------------
  // explainEntailment()
  // -------------------------------------------------------------------------

  /** Explain why a triple (subjectIri, predicateIri, objectIri) is entailed
   *  by the ontology, using entailment-as-unsatisfiability reduction.
   *
   *  Returns an `EntailmentResult` containing:
   *  - `isEntailed` — `true/false/null` (null when ontology is inconsistent)
   *  - `justifications` — minimal justifications (each is a Quad[] subset)
   *  - `ontologyInconsistent` / `vacuous` — special-case flags
   *
   *  Supports rdfs:subClassOf and rdf:type shapes. Returns unsupported for
   *  other predicates (isEntailed reflects only asserted facts).
   */
  explainEntailment(
    store: Store,
    subjectIri: string,
    predicateIri: string,
    objectIri: string,
    opts?: ExplainEntailmentOptions,
  ): Promise<EntailmentResult> {
    const maxJustifications = opts?.maxJustifications ?? 1;
    const objectIsClassLike = opts?.objectIsClassLike ?? true;
    const mode = opts?.justificationMode ?? (opts?.nativeOnly ? "causal" : "causal");

    const result = this._queue.then(async () => {
      const ig = opts?.inferredGraph ?? INFERRED_GRAPH_IRI;
      const allBase = store.getQuads(null, null, null, null).filter(q => {
        const g = q.graph.value;
        return g !== ig && g !== HYPOTHETICAL_IRI && !this._excludeGraphs.has(g);
      });

      const probeKind = classifyAxiom(predicateIri, objectIsClassLike);

      if (probeKind === "unsupported") {
        const triple = allBase.find(
          q => q.subject.value === subjectIri &&
               q.predicate.value === predicateIri &&
               q.object.value === objectIri,
        );
        if (triple) {
          return { isEntailed: true, justifications: [[triple]] };
        }
        return { isEntailed: false, justifications: [] as Quad[][] };
      }

      // ── Dep-chain fallback (when no Store justification found) ──
      // Uses the dep-chain cache from a prior classify()/reason() call.
      // Zero WASM reloads — just O(1) lookups on the existing state.

      if (probeKind === "subClassOf") {
        const hasNative = await this._hasNativeJustificationDirect(subjectIri, objectIri);
        if (hasNative) {
          const ntriples = await this._getSubClassJustificationDirect(subjectIri, objectIri);
          const justQuads = this._parseNTriplesJustification(ntriples);
          if (justQuads.length > 0) {
            return { isEntailed: true, justifications: [justQuads] };
          }
        }
      }

      if (probeKind === "type") {
        if (mode === "causal") {
          await this._ensureExplanationGraphFromBuffer(store, "getInferredTripleBuffer");
          const justQuads = this._lookupJustificationFromStore(store, subjectIri, predicateIri, objectIri);
          if (justQuads !== null && justQuads.length > 0) {
            return { isEntailed: true, justifications: [justQuads] };
          }
        }

        const assertedTypes = allBase
          .filter(q => q.subject.value === subjectIri && q.predicate.value === RDF_TYPE)
          .map(q => q.object.value);

        if (assertedTypes.includes(objectIri)) {
          const typeQuad = DataFactory.quad(
            DataFactory.namedNode(subjectIri),
            DataFactory.namedNode(RDF_TYPE),
            DataFactory.namedNode(objectIri),
          );
          return { isEntailed: true, justifications: [[typeQuad as Quad]] };
        }

        // Classification-based: asserted rdf:type A, A ⊑ B → inferred rdf:type B
        for (const assertedType of assertedTypes) {
          const ntriples = await this._getSubClassJustificationDirect(assertedType, objectIri);
          if (ntriples.length === 0) continue;
          const subClassQuads = this._parseNTriplesJustification(ntriples);
          if (subClassQuads.length === 0) continue;
          const typeQuad = DataFactory.quad(
            DataFactory.namedNode(subjectIri),
            DataFactory.namedNode(RDF_TYPE),
            DataFactory.namedNode(assertedType),
          );
          return { isEntailed: true, justifications: [[typeQuad as Quad, ...subClassQuads]] };
        }

        // Domain-chain: inferred rdf:type A (with triple justification), A ⊑ B → rdf:type B
        const inferredTypes = store.getQuads(
          DataFactory.namedNode(subjectIri), DataFactory.namedNode(RDF_TYPE), null,
          DataFactory.namedNode(ig),
        ).map(q => q.object.value).filter(t => t !== objectIri);
        for (const inferredType of inferredTypes) {
          const scNtriples = await this._getSubClassJustificationDirect(inferredType, objectIri);
          if (scNtriples.length === 0) continue;
          let tjQuads = this._lookupJustificationFromStore(store, subjectIri, RDF_TYPE, inferredType);
          if (!tjQuads || tjQuads.length === 0) {
            tjQuads = this._synthesizeDomainRangeJustification(allBase, subjectIri, inferredType);
          }
          if (!tjQuads || tjQuads.length === 0) {
            tjQuads = this._synthesizeRestrictionJustification(allBase, store, subjectIri, inferredType);
          }
          if (!tjQuads || tjQuads.length === 0) continue;
          const scQuads = this._parseNTriplesJustification(scNtriples);
          if (scQuads.length === 0) continue;
          return { isEntailed: true, justifications: [[...tjQuads, ...scQuads]] };
        }

        // Realization-based: clash-path hook captured dep chain during tableau
        const hasRealization = await this._hasJustificationByTypeDirect(
          subjectIri, objectIri, RdfReasoner._ET_REALIZATION);
        if (hasRealization) {
          const ntriples = await this._getJustificationByTypeDirect(
            subjectIri, objectIri, RdfReasoner._ET_REALIZATION);
          const justQuads = this._parseNTriplesJustification(ntriples);
          if (justQuads.length > 0) {
            return { isEntailed: true, justifications: [justQuads] };
          }
        }

        // Domain/range synthesis: subject uses property P, P has domain/range C
        const domainSynthesis = this._synthesizeDomainRangeJustification(allBase, subjectIri, objectIri);
        if (domainSynthesis && domainSynthesis.length > 0) {
          return { isEntailed: true, justifications: [domainSynthesis] };
        }

        // OWL restriction synthesis: equivalentClass/subClassOf restriction patterns
        const restrictionSynthesis = this._synthesizeRestrictionJustification(allBase, store, subjectIri, objectIri);
        if (restrictionSynthesis && restrictionSynthesis.length > 0) {
          return { isEntailed: true, justifications: [restrictionSynthesis] };
        }

        // sameAs type propagation: subject sameAs partner, partner rdf:type object
        // Check full store (including inferred graph) for partner types
        const sameAsPartners = [
          ...store.getQuads(subjectIri, OWL_SAME_AS, null, null).map(q => q.object.value),
          ...store.getQuads(null, OWL_SAME_AS, subjectIri, null).map(q => q.subject.value),
        ];
        for (const partner of sameAsPartners) {
          const typeQuads = store.getQuads(partner, RDF_TYPE, objectIri, null);
          if (typeQuads.length > 0) {
            const sameAsQuad = store.getQuads(subjectIri, OWL_SAME_AS, partner, null)[0]
              ?? store.getQuads(partner, OWL_SAME_AS, subjectIri, null)[0];
            if (sameAsQuad) {
              return { isEntailed: true, justifications: [[sameAsQuad as Quad, typeQuads[0] as Quad]] };
            }
          }
        }

        // N3 Store-based fallbacks: derive justification from input ontology structure

        // Domain: indi <prop> obj, prop rdfs:domain targetClass
        const propAssertions = allBase.filter(
          q => q.subject.value === subjectIri && q.predicate.value !== RDF_TYPE,
        );
        for (const pa of propAssertions) {
          const domainQuads = store.getQuads(pa.predicate.value, RDFS_DOMAIN, objectIri, null);
          if (domainQuads.length > 0) {
            return { isEntailed: true, justifications: [[pa as Quad, domainQuads[0] as Quad]] };
          }
        }

        // Range: obj <prop> indi, prop rdfs:range targetClass
        const asObject = allBase.filter(
          q => q.object.value === subjectIri && q.predicate.value !== RDF_TYPE,
        );
        for (const pa of asObject) {
          const rangeQuads = store.getQuads(pa.predicate.value, RDFS_RANGE, objectIri, null);
          if (rangeQuads.length > 0) {
            return { isEntailed: true, justifications: [[pa as Quad, rangeQuads[0] as Quad]] };
          }
        }

        // Restriction-based: find equivalentClass restrictions in input ontology
        const equivRestrictions = store.getQuads(objectIri, OWL_EQUIVALENT_CLASS, null, null)
          .filter(q => q.object.termType === "BlankNode");
        for (const eqQuad of equivRestrictions) {
          const bnode = eqQuad.object;
          const onPropQuads = store.getQuads(bnode, OWL_ON_PROPERTY, null, null);
          if (onPropQuads.length === 0) continue;
          const propTerm = onPropQuads[0].object;
          const propIri = propTerm.value;

          // someValuesFrom: indi <prop> filler, filler rdf:type fillerClass
          const svfQuads = store.getQuads(bnode, OWL_SOME_VALUES_FROM, null, null);
          if (svfQuads.length > 0) {
            const fillerClass = svfQuads[0].object.value;
            for (const pa2 of store.getQuads(subjectIri, propIri, null, null)) {
              const fillerTypes = store.getQuads(pa2.object, RDF_TYPE, fillerClass, null);
              if (fillerTypes.length > 0) {
                return { isEntailed: true, justifications: [[pa2 as Quad, fillerTypes[0] as Quad]] };
              }
            }
            // Check inverse property: filler <invProp> indi
            const invQuads = store.getQuads(propTerm, OWL_INVERSE_OF, null, null);
            const invRevQuads = store.getQuads(null, OWL_INVERSE_OF, propTerm, null);
            const invProps = [
              ...invQuads.map(q => q.object),
              ...invRevQuads.map(q => q.subject),
            ];
            for (const invPropTerm of invProps) {
              for (const pa2 of store.getQuads(null, invPropTerm, subjectIri, null)) {
                const fillerTypes = store.getQuads(pa2.subject, RDF_TYPE, fillerClass, null);
                if (fillerTypes.length > 0) {
                  return { isEntailed: true, justifications: [[pa2 as Quad, fillerTypes[0] as Quad]] };
                }
              }
            }
          }

          // hasValue: indi <prop> value (or value <invProp> indi)
          const hvQuads = store.getQuads(bnode, OWL_HAS_VALUE, null, null);
          if (hvQuads.length > 0) {
            const valTerm = hvQuads[0].object;
            const directMatch = store.getQuads(subjectIri, propIri, valTerm, null);
            if (directMatch.length > 0) {
              return { isEntailed: true, justifications: [[directMatch[0] as Quad]] };
            }
            // Inverse: val <invProp> indi
            const invQuads2 = store.getQuads(propTerm, OWL_INVERSE_OF, null, null);
            const invRevQuads2 = store.getQuads(null, OWL_INVERSE_OF, propTerm, null);
            const invProps2 = [
              ...invQuads2.map(q => q.object),
              ...invRevQuads2.map(q => q.subject),
            ];
            for (const invPropTerm of invProps2) {
              const invMatch = store.getQuads(valTerm, invPropTerm, subjectIri, null);
              if (invMatch.length > 0) {
                const invOfQuad = store.getQuads(propTerm, OWL_INVERSE_OF, invPropTerm, null)[0]
                  ?? store.getQuads(invPropTerm, OWL_INVERSE_OF, propTerm, null)[0];
                return { isEntailed: true, justifications: [[invOfQuad as Quad, invMatch[0] as Quad]] };
              }
            }
          }
        }

        // Subclass chain from inferred type: indi rdf:type A (inferred), A ⊑ target
        // Derive A's justification from domain/range in input
        for (const inferredType of inferredTypes) {
          const scNtriples2 = await this._getSubClassJustificationDirect(inferredType, objectIri);
          if (scNtriples2.length === 0) continue;
          const scQuads2 = this._parseNTriplesJustification(scNtriples2);
          if (scQuads2.length === 0) continue;
          // Try to derive justification for the intermediate inferred type
          for (const pa3 of propAssertions) {
            const domQ = store.getQuads(pa3.predicate.value, RDFS_DOMAIN, inferredType, null);
            if (domQ.length > 0) {
              return { isEntailed: true, justifications: [[pa3 as Quad, domQ[0] as Quad, ...scQuads2]] };
            }
          }
          for (const pa3 of asObject) {
            const rngQ = store.getQuads(pa3.predicate.value, RDFS_RANGE, inferredType, null);
            if (rngQ.length > 0) {
              return { isEntailed: true, justifications: [[pa3 as Quad, rngQ[0] as Quad, ...scQuads2]] };
            }
          }
        }

      }

      // ── TS synthesis path ────────────────────────────────────────────
      // Workaround-computed types: justification = input axiom data.

      if (probeKind === "sameAs") {
        const asserted = allBase.some(
          q => q.subject.value === subjectIri && q.predicate.value === OWL_SAME_AS && q.object.value === objectIri,
        );
        if (asserted) {
          return { isEntailed: true, justifications: [[allBase.find(
            q => q.subject.value === subjectIri && q.predicate.value === OWL_SAME_AS && q.object.value === objectIri,
          )!]] };
        }

        // Native Realization cache: sameAs captured by clash-path hook
        const hasNative = await this._hasJustificationByTypeDirect(
          subjectIri, objectIri, RdfReasoner._ET_REALIZATION);
        if (hasNative) {
          const ntriples = await this._getJustificationByTypeDirect(
            subjectIri, objectIri, RdfReasoner._ET_REALIZATION);
          const justQuads = this._parseNTriplesJustification(ntriples);
          if (justQuads.length > 0) {
            return { isEntailed: true, justifications: [justQuads] };
          }
        }

        // FP/IFP workaround: check inferred graph (populated by materialize)
        const igIri2 = (opts as { inferredGraph?: string } | undefined)?.inferredGraph ?? INFERRED_GRAPH_IRI;
        const inferredSameAs = store.getQuads(
          DataFactory.namedNode(subjectIri),
          DataFactory.namedNode(OWL_SAME_AS),
          DataFactory.namedNode(objectIri),
          DataFactory.namedNode(igIri2),
        );
        if (inferredSameAs.length > 0) {
          // Reconstruct justification from base graph: FP property + both role assertions
          const fpJust = RdfReasoner._buildFpIfpJustification(allBase, subjectIri, objectIri);
          return { isEntailed: true, justifications: fpJust.length > 0 ? [fpJust] : [[inferredSameAs[0] as Quad]] };
        }

        return { isEntailed: false, justifications: [] as Quad[][] };
      }

      if (probeKind === "equivalentProperty") {
        const OWL_EQUIV_PROP = "http://www.w3.org/2002/07/owl#equivalentProperty";
        // Asserted equivalentProperty in base graph
        const asserted = allBase.find(
          q => q.subject.value === subjectIri &&
               q.predicate.value === OWL_EQUIV_PROP &&
               q.object.value === objectIri,
        );
        if (asserted) {
          return { isEntailed: true, justifications: [[asserted]] };
        }
        // Symmetric: check reverse direction in base
        const assertedRev = allBase.find(
          q => q.subject.value === objectIri &&
               q.predicate.value === OWL_EQUIV_PROP &&
               q.object.value === subjectIri,
        );
        if (assertedRev) {
          return { isEntailed: true, justifications: [[assertedRev]] };
        }
        // Check bidirectional subPropertyOf via dep chain cache
        const hasFwd = await this._hasJustificationByTypeDirect(
          subjectIri, objectIri, RdfReasoner._ET_PROPERTY_SUBSUMPTION);
        const hasRev = await this._hasJustificationByTypeDirect(
          objectIri, subjectIri, RdfReasoner._ET_PROPERTY_SUBSUMPTION);
        if (hasFwd && hasRev) {
          const fwd = this._parseNTriplesJustification(
            await this._getJustificationByTypeDirect(
              subjectIri, objectIri, RdfReasoner._ET_PROPERTY_SUBSUMPTION));
          const rev = this._parseNTriplesJustification(
            await this._getJustificationByTypeDirect(
              objectIri, subjectIri, RdfReasoner._ET_PROPERTY_SUBSUMPTION));
          if (fwd.length > 0 && rev.length > 0) {
            const seen = new Set<string>();
            const combined: Quad[] = [];
            for (const q of [...fwd, ...rev]) {
              const k = `${q.subject.value}\0${q.predicate.value}\0${q.object.value}`;
              if (!seen.has(k)) { seen.add(k); combined.push(q); }
            }
            return { isEntailed: true, justifications: [combined] };
          }
        }
        // Causal fallback: check inferred graph for subPropertyOf in both directions
        if (mode === "causal") {
          const fwdInferred = store.getQuads(
            subjectIri, RDFS_SUB_PROPERTY_OF, objectIri,
            DataFactory.namedNode(ig));
          const revInferred = store.getQuads(
            objectIri, RDFS_SUB_PROPERTY_OF, subjectIri,
            DataFactory.namedNode(ig));
          if (fwdInferred.length > 0 && revInferred.length > 0) {
            return { isEntailed: true, justifications: [] as Quad[][] };
          }
        }
        return { isEntailed: false, justifications: [] as Quad[][] };
      }

      if (probeKind === "equivalentClass") {
        // Native bidirectional subClassOf cache: A ≡ B iff A ⊑ B and B ⊑ A
        const hasForward = await this._hasNativeJustificationDirect(subjectIri, objectIri);
        const hasReverse = await this._hasNativeJustificationDirect(objectIri, subjectIri);
        if (hasForward && hasReverse) {
          const fwd = this._parseNTriplesJustification(
            await this._getSubClassJustificationDirect(subjectIri, objectIri));
          const rev = this._parseNTriplesJustification(
            await this._getSubClassJustificationDirect(objectIri, subjectIri));
          if (fwd.length > 0 && rev.length > 0) {
            const seen = new Set<string>();
            const combined: Quad[] = [];
            for (const q of [...fwd, ...rev]) {
              const k = `${q.subject.value}\0${q.predicate.value}\0${q.object.value}`;
              if (!seen.has(k)) { seen.add(k); combined.push(q); }
            }
            return { isEntailed: true, justifications: [combined] };
          }
        }
        return { isEntailed: false, justifications: [] as Quad[][] };
      }

      if (probeKind === "subPropertyOf") {
        // Asserted subPropertyOf
        const asserted = allBase.find(
          q => q.subject.value === subjectIri &&
               q.predicate.value === RDFS_SUB_PROPERTY_OF &&
               q.object.value === objectIri,
        );
        if (asserted) {
          return { isEntailed: true, justifications: [[asserted]] };
        }
        // Native property subsumption cache
        const hasNative = await this._hasJustificationByTypeDirect(
          subjectIri, objectIri, RdfReasoner._ET_PROPERTY_SUBSUMPTION);
        if (hasNative) {
          const ntriples = await this._getJustificationByTypeDirect(
            subjectIri, objectIri, RdfReasoner._ET_PROPERTY_SUBSUMPTION);
          const justQuads = this._parseNTriplesJustification(ntriples);
          if (justQuads.length > 0) {
            return { isEntailed: true, justifications: [justQuads] };
          }
        }
        // Causal fallback: check inferred graph
        if (mode === "causal") {
          const inferredGraph = store.getQuads(
            subjectIri, RDFS_SUB_PROPERTY_OF, objectIri,
            DataFactory.namedNode(ig),
          );
          if (inferredGraph.length > 0) {
            return { isEntailed: true, justifications: [] as Quad[][] };
          }
        }
        return { isEntailed: false, justifications: [] as Quad[][] };
      }

      if (probeKind === "disjointWith") {
        // An asserted axiom is trivially entailed (also in an inconsistent ontology) and is its own justification.
        const just = this._synthesizeDisjointWithJustification(allBase, subjectIri, objectIri);
        if (just) return { isEntailed: true, justifications: [just] };

        // Derived disjointness: the entailment is decided by the same probe batch as isEntailed (the kernel does not emit
        // disjointness, it only uses the axioms inside reasoning); explaining only adds the flags. No axiom-level justification
        // is computed for a derived pair. (The "native classification cache" is not consulted: its justifications are
        // subsumptions, not disjointness, and made `C disjointWith A` look entailed for any `C subClassOf A`.)
        const [res] = await this._disjointEntailmentsDirect(store, ig, [DataFactory.quad(DataFactory.namedNode(subjectIri), DataFactory.namedNode(predicateIri), DataFactory.namedNode(objectIri))]);
        this._invalidateResultCaches();
        if (res.entailed === null) {
          return {
            isEntailed: null as boolean | null,
            justifications: [] as Quad[][],
            ontologyInconsistent: true,
            reason: "Ontology is already inconsistent; entailment is vacuous.",
          };
        }
        if (!res.entailed) return { isEntailed: false, justifications: [] as Quad[][] };
        if (res.vacuous) {
          return {
            isEntailed: true as boolean | null,
            justifications: [] as Quad[][],
            vacuous: true,
            reason: "A class of the pair is unsatisfiable; the disjointness holds vacuously.",
          };
        }
        return { isEntailed: true, justifications: [] as Quad[][] };
      }

      if (probeKind === "dataProperty") {
        const asserted = allBase.some(
          q => q.subject.value === subjectIri &&
               q.predicate.value === predicateIri &&
               q.object.value === objectIri,
        );
        if (asserted) {
          const triple = allBase.find(
            q => q.subject.value === subjectIri &&
                 q.predicate.value === predicateIri &&
                 q.object.value === objectIri,
          )!;
          return { isEntailed: true, justifications: [[triple]] };
        }
        return { isEntailed: false, justifications: [] as Quad[][] };
      }

      // ── Justification search (fallback) ─────────────────────────────────────────────
      // Only used in "minimal" mode. In "causal" mode (default), check
      // inferred graph for the triple — if present, it's entailed but we
      // couldn't synthesize a justification. If absent, not entailed.

      if (mode === "causal") {
        const inferredGraph = store.getQuads(
          subjectIri, predicateIri, objectIri,
          DataFactory.namedNode(ig),
        );
        const assertedMatch = allBase.some(
          q => q.subject.value === subjectIri &&
               q.predicate.value === predicateIri &&
               q.object.value === objectIri,
        );
        if (inferredGraph.length > 0 || assertedMatch) {
          return { isEntailed: true, justifications: [] as Quad[][] };
        }
        // buildInferredTripleBuffer suppresses X subClassOf owl:Nothing,
        // so check satisfiability directly for that case.
        if (objectIri === OWL_NOTHING && predicateIri === RDFS_SUB_CLASS_OF) {
          const sat = await this._isSatisfiableClassDirect(subjectIri);
          if (!sat) {
            return { isEntailed: true, justifications: [] as Quad[][] };
          }
        }
        // buildInferredTripleBuffer emits the Hasse diagram (direct edges only),
        // so a transitively-inferred A ⊑ C with A ⊑ B ⊑ C won't appear in the
        // inferred graph even though it is entailed. Fall back to the native
        // classifier which queries the full taxonomy.
        if (predicateIri === RDFS_SUB_CLASS_OF) {
          const entailed = await this._isSubClassOfDirect(subjectIri, objectIri);
          if (entailed) {
            return { isEntailed: true, justifications: [] as Quad[][] };
          }
        }
        return { isEntailed: false, justifications: [] as Quad[][] };
      }

      // C1: ontology must be consistent for the reduction to be sound
      if (await this._checkInconsistencyDirect(allBase)) {
        return {
          isEntailed: null as boolean | null,
          justifications: [] as Quad[][],
          ontologyInconsistent: true,
          reason: "Ontology is already inconsistent; entailment is vacuous.",
        };
      }

      const probeId = `probe_${++this._entailmentProbeCounter}`;
      const probe = buildEntailmentProbe(
        subjectIri, predicateIri, objectIri, objectIsClassLike, probeId,
      );

      // O ∪ ¬α — test entailment via the consistency oracle
      const withProbe = [...allBase, ...probe.probeQuads];
      const entailed = await this._checkInconsistencyDirect(withProbe);
      if (!entailed) {
        return { isEntailed: false, justifications: [] as Quad[][] };
      }

      // C2: vacuous-truth detection for subClassOf
      if (probe.kind === "subClassOf") {
        const { tripleBuffer, strTableBuffer } = encodeToBuffers(allBase);
        await this._callDirect("sync", [tripleBuffer, strTableBuffer], [tripleBuffer, strTableBuffer]);
        await this._callDirect("classification", []);
        const sat = await this._isSatisfiableClassDirect(subjectIri);
        if (!sat) {
          return {
            isEntailed: true as boolean | null,
            justifications: [] as Quad[][],
            vacuous: true,
            reason: "Subject class is unsatisfiable; it is a subclass of anything (vacuous truth).",
          };
        }
      }

      if (maxJustifications === 0) {
        return { isEntailed: true, justifications: [] as Quad[][] };
      }

      // Invalidate caches — sub-calls modify WASM state
      this._classifyCache = null;
      this._materializeCache = null;
      this._classifyPropertiesCache = null;
      this._lastExplBuffer = null;
      this._lastPropertyExplBuffer = null;
      this._consistencyCache = null;

      // Minimal justifications over AXIOM UNITS: QuickXplain plus a hitting-set tree, the same engine as
      // explainInconsistency (a triple-level search cannot work on real ontologies: it falls back to one reasoner
      // probe per triple). The negated entailment (probe) is part of the input, so every inconsistent unit set
      // contains it; it is stripped from each result. Declarations are fixed background of every check.
      const timeoutMs = opts?.timeout ?? 180_000;
      const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Infinity;
      const candidates = opts?.axiomFilter
        ? allBase.filter(q => isDeclaration(q) || opts.axiomFilter!(q))
        : allBase;
      const found = await this._minimalUnitSets(
        [...candidates, ...probe.probeQuads],
        (quads, d) => this._boundedInconsistencyCheck(quads, d),
        maxJustifications,
        deadline,
        false,
      );
      const justifications: Quad[][] = found
        .map(j => j.filter(q => !probe.probeKeys.has(probeTripleKey(q.subject.value, q.predicate.value, q.object.value))))
        .filter(j => j.length > 0);

      return { isEntailed: true, justifications };
    });
    this._queue = result.then(() => {}, () => {});
    return result;
  }

  // -------------------------------------------------------------------------
  // validate()
  // -------------------------------------------------------------------------

  /** Run a combined diagnostic: check consistency, find unsatisfiable classes,
   *  and (optionally) compute minimal justifications for each.
   *
   *  Returns `{ consistent, errors, warnings }` where:
   *  - `consistent` — `true` when the ontology has at least one model
   *  - `errors` — MIPS (minimal inconsistent sub-ontologies); non-empty only when inconsistent
   *  - `warnings` — one `ClassWarning` per unsatisfiable class (owl:Nothing excluded)
   *
   *  All reasoner calls of the justification search run inside this method's single _queue slot.
   *  Do NOT call public methods from inside — use private helpers only.
   */
  validate(store: Store, opts?: ValidateOptions): Promise<ValidationResult> {
    const result = this._queue.then(async () => {
      const maxErr  = opts?.maxJustificationsPerError  ?? 1;
      const maxWarn = opts?.maxJustificationsPerWarning ?? 1;
      const igIri = opts?.inferredGraph ?? INFERRED_GRAPH_IRI;
      const validateTimeoutMs = opts?.timeout ?? 180_000;
      const validateDeadline = validateTimeoutMs > 0 ? Date.now() + validateTimeoutMs : Infinity;

      const allBase = store.getQuads(null, null, null, null).filter(q =>
        q.graph.value !== igIri && q.graph.value !== HYPOTHETICAL_IRI && !this._excludeGraphs.has(q.graph.value),
      );

      const makeCandidates = () => store.getQuads(null, null, null, null).filter(q => {
        const g = q.graph.value;
        if (g === igIri || g === HYPOTHETICAL_IRI || this._excludeGraphs.has(g)) return false;
        if (opts?.axiomFilter && !opts.axiomFilter(q)) return false;
        return true;
      });

      // ── Step 1: consistency ───────────────────────────────────────────────
      const gen = await this._sync(store, igIri);
      let consistent: boolean;
      if (this._consistencyCache?.gen === gen) {
        consistent = this._consistencyCache.result;
      } else {
        consistent = !(await this._checkInconsistencyDirect(allBase));
        this._consistencyCache = { gen, result: consistent };
      }

      // ── Step 2: error justifications ─────────────────────────────────────
      const errors: Quad[][] = [];
      if (!consistent && maxErr > 0) {
        const allCandidates = makeCandidates();

        this._classifyCache = null;
        this._materializeCache = null;
        this._classifyPropertiesCache = null;
        this._consistencyCache = null;

        if (await this._checkInconsistencyDirect(allCandidates)) {
          for (const j of await this._minimalUnitSets(
            allCandidates,
            (q, d) => this._boundedInconsistencyCheck(q, d),
            maxErr,
            validateDeadline,
            false,
          )) {
            errors.push(j);
          }
        }
      }

      // ── Step 3: unsatisfiable classes ─────────────────────────────────────
      const unsatIRIs = await this._getUnsatisfiableClassesInternal(store);

      // ── Step 4: warning justifications ────────────────────────────────────
      // Native fast path: classification already ran (step 3), so the
      // dep-chain cache contains clash justifications for unsatisfiable
      // classes keyed as (C, owl:Nothing). Zero extra WASM reloads.
      // Falls back to the justification search only when the native justification is absent.
      const warnings: ClassWarning[] = [];
      if (unsatIRIs.length > 0) {
        for (const classIRI of unsatIRIs) {
          if (maxWarn === 0) {
            warnings.push({ classIRI, justifications: [] });
            continue;
          }

          // Try native justification first (O(1) lookup, no WASM reload)
          const hasNative = await this._hasNativeJustificationDirect(classIRI, OWL_NOTHING);
          if (hasNative) {
            const ntriples = await this._getSubClassJustificationDirect(classIRI, OWL_NOTHING);
            const justQuads = this._parseNTriplesJustification(ntriples);
            if (justQuads.length > 0) {
              warnings.push({ classIRI, justifications: [justQuads] });
              continue;
            }
          }

          // Justification-search fallback
          const warnCands = makeCandidates();

          this._classifyCache = null;
          this._materializeCache = null;
          this._classifyPropertiesCache = null;
          this._consistencyCache = null;

          if (!(await this._checkUnsatisfiabilityDirect(warnCands, classIRI))) {
            warnings.push({ classIRI, justifications: [] });
            continue;
          }

          const justs = await this._minimalUnitSets(
            warnCands,
            (q, d) => this._boundedCheck(x => this._checkUnsatisfiabilityDirect(x, classIRI), q, d),
            maxWarn,
            validateDeadline,
            false,
          );

          warnings.push({ classIRI, justifications: justs });
        }
      }

      return { consistent, errors, warnings };
    });
    this._queue = result.then(() => {}, () => {});
    return result;
  }

  /**
   * Terminate the underlying Worker and reject all pending calls.
   *
   * Must be called when the reasoner is no longer needed. Alternatively, use
   * the `using` keyword (TypeScript 5.2+ Explicit Resource Management):
   * ```ts
   * {
   *   using reasoner = new RdfReasoner();
   *   await reasoner.ready;
   *   const result = await reasoner.classify(quads);
   * } // Worker terminated automatically here
   * ```
   */
  terminate(): void {
    workerRegistry.unregister(this);
    this.worker.terminate();
    const err = new Error("Worker terminated");
    for (const entry of this.pending.values()) {
      entry.reject(err);
    }
    this.pending.clear();
  }

  /** Explicit Resource Management support (`using` keyword, TS 5.2+). */
  [Symbol.dispose](): void {
    this.terminate();
  }
}
