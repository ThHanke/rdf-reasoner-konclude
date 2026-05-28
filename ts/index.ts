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
import { encodeToBuffers, decodeBuffers, computeStoreFingerprint } from "./intern.js";

export type { ReasoningOptions, ReasoningResult, StoreReasoningOptions, MaterializeOptions, MaterializeStoreOptions, ClassifyPropertiesStoreOptions, InferenceDelta, WhatIfOptions, ExplainOptions } from "./types.js";
export { INFERRED_GRAPH_IRI, HYPOTHETICAL_IRI } from "./types.js";
import type { ReasoningOptions, StoreReasoningOptions, MaterializeOptions, MaterializeStoreOptions, ClassifyPropertiesStoreOptions, InferenceDelta, WhatIfOptions, ExplainOptions } from "./types.js";
import { INFERRED_GRAPH_IRI, HYPOTHETICAL_IRI } from "./types.js";

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
const RDFS_CLASS = "http://www.w3.org/2000/01/rdf-schema#Class";
const OWL_THING = "http://www.w3.org/2002/07/owl#Thing";
const OWL_NOTHING = "http://www.w3.org/2002/07/owl#Nothing";

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
   * loadTripleBuffer → realization → getInferredTripleBuffer sequences.
   */
  private _queue: Promise<void> = Promise.resolve();

  // Per-operation fingerprint caches. Each slot stores the last input hash and
  // result so that identical consecutive calls skip the Worker round-trip.
  private _classifyCache: { hash: string; result: void } | null = null;
  private _materializeCache: { hash: string; result: void } | null = null;
  private _classifyPropertiesCache: { hash: string; result: void } | null = null;
  private _consistencyCache: { hash: string; result: boolean } | null = null;

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
   * @deprecated Use `classify()`, `materialize()`, or `checkConsistency()` instead.
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
    // Known limitation: fingerprint always covers all graphs, including any
    // custom inferredGraph. If the caller uses a non-default inferredGraph,
    // the cache may incorrectly report a hit when the inferred graph has
    // changed between calls. Acceptable for the current use-cases.
    const fingerprint = computeStoreFingerprint(store.getQuads(null, null, null, null));
    const result = this._queue.then(async () => {
      // Cache hit: same store content as last classify call
      if (this._classifyCache !== null && this._classifyCache.hash === fingerprint) {
        return;
      }

      const inferredGraphNode = DataFactory.namedNode(
        opts?.inferredGraph ?? INFERRED_GRAPH_IRI,
      );
      store.removeQuads(store.getQuads(null, null, null, inferredGraphNode));

      const { tripleBuffer, strTableBuffer } = encodeToBuffers(store.getQuads(null, null, null, null));

      await this._call("loadTripleBuffer", [tripleBuffer, strTableBuffer], [tripleBuffer, strTableBuffer]);
      // Always uses classification (TBox-only); opts.mode is reserved for future use.
      await this._call("classification", []);

      const resultBuf = (await this._call("getInferredTripleBuffer", [])) as ArrayBuffer;
      const inferredQuads = decodeBuffers(resultBuf);

      for (const q of inferredQuads) {
        store.addQuad(
          DataFactory.quad(q.subject, q.predicate, q.object, inferredGraphNode),
        );
      }

      this._classifyCache = { hash: fingerprint, result: undefined as void };
      this._materializeCache = null;
      this._classifyPropertiesCache = null;
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

      if (mode === "consistency") {
        // Consistency mode: no inferred quads are returned via reason().
        // Callers wanting a boolean should use checkConsistency().
        await this._call("realization", []);
        return [];
      }

      // "classify" (default) → TBox-only classification; "full" → full TBox+ABox realization.
      await this._call(mode === "full" ? "realization" : "classification", []);

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

  /** Classify a Store. Inferred rdfs:subClassOf and owl:equivalentClass triples
   *  are written into `opts.inferredGraph` (default `INFERRED_GRAPH_IRI`). The
   *  graph is cleared before each call. Concurrent calls are serialized.
   *
   *  Internally sends a single `classification` command to the WASM worker, which
   *  runs TBox-only reasoning (class hierarchy + property hierarchy). No ABox
   *  realization is performed. For individual rdf:type entailments use
   *  `materialize(store)` instead. */
  classify(store: Store, opts?: StoreReasoningOptions): Promise<void>;
  /**
   * @deprecated Use `classify(store)` instead. For ABox/rdf:type results, use `materialize(store)`.
   *
   * Classify the given quads. Returns the inferred rdfs:subClassOf quads in the
   * default graph. Internally sends a single `classification` command to the
   * WASM worker (TBox-only; no ABox realization).
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
   * Internally: loadTripleBuffer → classification → consistency.
   * Concurrent calls are serialized: each call waits for the previous one to
   * complete before sending its first Worker message.
   */
  // Unit 4 judgment (2026-05-28): full classification pipeline runs ≤300ms for
  // cases 5 and 6 after mConfExtractSimpleABoxAssertions fix. consistencyOnly()
  // removed as no longer needed; full pipeline preferred for correctness.
  checkConsistency(quads: Iterable<Quad>): Promise<boolean>;
  checkConsistency(input: Store | Iterable<Quad>): Promise<boolean> {
    const isStore = input instanceof Store;
    // Compute fingerprint before entering the queue (snapshot of current store state)
    const fingerprint = isStore
      ? computeStoreFingerprint((input as Store).getQuads(null, null, null, null))
      : null;
    const quads = isStore
      ? (input as Store).getQuads(null, null, null, null)
      : input as Iterable<Quad>;
    const result = this._queue.then(async () => {
      // Cache hit: only available for Store-based calls
      if (fingerprint !== null && this._consistencyCache !== null && this._consistencyCache.hash === fingerprint) {
        return this._consistencyCache.result;
      }

      const { tripleBuffer, strTableBuffer } = encodeToBuffers(quads);
      await this._call("loadTripleBuffer", [tripleBuffer, strTableBuffer], [tripleBuffer, strTableBuffer]);
      await this._call("classification", []);
      const consistent = (await this._call("consistency", [])) as boolean;

      if (fingerprint !== null) {
        this._consistencyCache = { hash: fingerprint, result: consistent };
      }

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

  /** Materialize ABox entailments (rdf:type) into a Store. Inferred triples are
   *  written into `opts.inferredGraph` (default `INFERRED_GRAPH_IRI`). The
   *  graph is cleared before each call. When `opts.includeClassHierarchy` is
   *  `true`, rdfs:subClassOf and owl:equivalentClass triples are also included.
   *  Concurrent calls are serialized.
   *
   *  Internally sends a single `realization` command to the WASM worker.
   *  Classification (TBox: class hierarchy + property hierarchy) is always a
   *  prerequisite inside the realization pipeline — it is NOT a separate call.
   *  Both TBox and ABox steps are submitted together in one `prepareOntology()`
   *  invocation at the C++ level. Use `classify(store)` when ABox individuals
   *  are absent or rdf:type entailments are not needed.
   *
   *  Pass `{ returnDelta: true }` to receive `{ delta: InferenceDelta }` with the
   *  quads added and removed compared to the previous inferred state. */
  materialize(store: Store, opts: MaterializeStoreOptions & { returnDelta: true }): Promise<{ delta: InferenceDelta }>;
  materialize(store: Store, opts?: MaterializeStoreOptions): Promise<void>;
  /**
   * Materialize ABox entailments (rdf:type assertions) for the given quads.
   *
   * Internally sends a single `realization` command to the WASM worker.
   * Classification (TBox: class hierarchy + property hierarchy) is always a
   * prerequisite inside the realization pipeline — it runs as part of the same
   * `prepareOntology()` call, not as a separate step. By default only rdf:type
   * entailments are returned. Pass `{ includeClassHierarchy: true }` to also
   * receive rdfs:subClassOf and owl:equivalentClass triples.
   *
   * Named graphs in the input are dropped (NTriples wire format is
   * triple-only). All returned quads are in the DefaultGraph.
   *
   * Concurrent calls are serialized: each call waits for the previous one to
   * complete before sending its first Worker message.
   */
  materialize(quads: Iterable<Quad>, opts?: MaterializeOptions): Promise<Quad[]>;
  materialize(
    input: Store | Iterable<Quad>,
    opts?: MaterializeStoreOptions | MaterializeOptions,
  ): Promise<void> | Promise<{ delta: InferenceDelta }> | Promise<Quad[]> {
    if (input instanceof Store) {
      return this._materializeOnStore(input, opts as MaterializeStoreOptions | undefined);
    }
    return this._materializeOnQuads(input as Iterable<Quad>, opts as MaterializeOptions | undefined);
  }

  private _materializeOnStore(store: Store, opts?: MaterializeStoreOptions): Promise<void> | Promise<{ delta: InferenceDelta }> {
    // Known limitation: fingerprint always covers all graphs, including any
    // custom inferredGraph. If the caller uses a non-default inferredGraph,
    // the cache may incorrectly report a hit when the inferred graph has
    // changed between calls. Acceptable for the current use-cases.
    const fingerprint = computeStoreFingerprint(store.getQuads(null, null, null, null));
    const returnDelta = opts?.returnDelta === true;
    const result = this._queue.then(async () => {
      const inferredGraphNode = DataFactory.namedNode(
        opts?.inferredGraph ?? INFERRED_GRAPH_IRI,
      );

      // Cache hit: same store content as last materialize call
      if (this._materializeCache !== null && this._materializeCache.hash === fingerprint) {
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

      store.removeQuads(store.getQuads(null, null, null, inferredGraphNode));

      const { tripleBuffer, strTableBuffer } = encodeToBuffers(store.getQuads(null, null, null, null));

      await this._call("loadTripleBuffer", [tripleBuffer, strTableBuffer], [tripleBuffer, strTableBuffer]);
      await this._call("realization", []);

      const resultBuf = (await this._call("getInferredTripleBuffer", [])) as ArrayBuffer;
      const allQuads = decodeBuffers(resultBuf);

      const inferredQuads = opts?.includeClassHierarchy === true
        ? allQuads
        : allQuads.filter(
            (q) =>
              q.predicate.value !== "http://www.w3.org/2000/01/rdf-schema#subClassOf" &&
              q.predicate.value !== "http://www.w3.org/2002/07/owl#equivalentClass",
          );

      for (const q of inferredQuads) {
        store.addQuad(
          DataFactory.quad(q.subject, q.predicate, q.object, inferredGraphNode),
        );
      }

      this._materializeCache = { hash: fingerprint, result: undefined as void };
      this._classifyCache = null;
      this._classifyPropertiesCache = null;

      if (returnDelta) {
        // Build after set from what was just written.
        // Wrap each quad with inferredGraphNode so delta.added and delta.removed
        // are both consistently in the inferred named graph.
        const afterSet = new Map<string, Quad>();
        for (const q of inferredQuads) {
          const key = `${q.subject.value}\0${q.predicate.value}\0${q.object.value}`;
          afterSet.set(key, DataFactory.quad(q.subject, q.predicate, q.object, inferredGraphNode));
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

  private _materializeOnQuads(quads: Iterable<Quad>, opts?: MaterializeOptions): Promise<Quad[]> {
    const result = this._queue.then(async () => {
      const { tripleBuffer, strTableBuffer } = encodeToBuffers(quads);

      await this._call("loadTripleBuffer", [tripleBuffer, strTableBuffer], [tripleBuffer, strTableBuffer]);
      await this._call("realization", []);

      const resultBuf = (await this._call("getInferredTripleBuffer", [])) as ArrayBuffer;
      const allQuads = decodeBuffers(resultBuf);

      if (opts?.includeClassHierarchy === true) {
        return allQuads;
      }
      return allQuads.filter(
        (q) =>
          q.predicate.value !== "http://www.w3.org/2000/01/rdf-schema#subClassOf" &&
          q.predicate.value !== "http://www.w3.org/2002/07/owl#equivalentClass",
      );
    });
    this._queue = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  // -------------------------------------------------------------------------
  // classifyProperties()
  // -------------------------------------------------------------------------

  /** Classify property hierarchy of a Store. Inferred rdfs:subPropertyOf triples
   *  are written into `opts.inferredGraph` (default `INFERRED_GRAPH_IRI`). The
   *  graph is cleared before each call. Concurrent calls are serialized. */
  classifyProperties(store: Store, opts?: ClassifyPropertiesStoreOptions): Promise<void>;
  /**
   * Classify the property hierarchy for the given quads.
   *
   * Returns the inferred rdfs:subPropertyOf quads in the default graph.
   *
   * Named graphs in the input are dropped (NTriples wire format is
   * triple-only). All returned quads are in the DefaultGraph.
   *
   * Concurrent calls are serialized: each call waits for the previous one to
   * complete before sending its first Worker message.
   */
  classifyProperties(quads: Iterable<Quad>): Promise<Quad[]>;
  classifyProperties(
    input: Store | Iterable<Quad>,
    opts?: ClassifyPropertiesStoreOptions,
  ): Promise<void> | Promise<Quad[]> {
    if (input instanceof Store) {
      return this._classifyPropertiesOnStore(input, opts);
    }
    return this._classifyPropertiesOnQuads(input as Iterable<Quad>);
  }

  private _classifyPropertiesOnStore(store: Store, opts?: ClassifyPropertiesStoreOptions): Promise<void> {
    // Known limitation: fingerprint always covers all graphs, including any
    // custom inferredGraph. If the caller uses a non-default inferredGraph,
    // the cache may incorrectly report a hit when the inferred graph has
    // changed between calls. Acceptable for the current use-cases.
    const fingerprint = computeStoreFingerprint(store.getQuads(null, null, null, null));
    const result = this._queue.then(async () => {
      // Cache hit: same store content as last classifyProperties call
      if (this._classifyPropertiesCache !== null && this._classifyPropertiesCache.hash === fingerprint) {
        return;
      }

      const inferredGraphNode = DataFactory.namedNode(
        opts?.inferredGraph ?? INFERRED_GRAPH_IRI,
      );
      store.removeQuads(store.getQuads(null, null, null, inferredGraphNode));

      const { tripleBuffer, strTableBuffer } = encodeToBuffers(store.getQuads(null, null, null, null));

      await this._call("loadTripleBuffer", [tripleBuffer, strTableBuffer], [tripleBuffer, strTableBuffer]);
      await this._call("classification", []);

      const resultBuf = (await this._call("getPropertyTripleBuffer", [])) as ArrayBuffer;
      const inferredQuads = decodeBuffers(resultBuf);

      for (const q of inferredQuads) {
        store.addQuad(
          DataFactory.quad(q.subject, q.predicate, q.object, inferredGraphNode),
        );
      }

      this._classifyPropertiesCache = { hash: fingerprint, result: undefined as void };
      this._classifyCache = null;
      this._materializeCache = null;
    });
    this._queue = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  private _classifyPropertiesOnQuads(quads: Iterable<Quad>): Promise<Quad[]> {
    const result = this._queue.then(async () => {
      const { tripleBuffer, strTableBuffer } = encodeToBuffers(quads);

      await this._call("loadTripleBuffer", [tripleBuffer, strTableBuffer], [tripleBuffer, strTableBuffer]);
      await this._call("classification", []);

      const resultBuf = (await this._call("getPropertyTripleBuffer", [])) as ArrayBuffer;
      return decodeBuffers(resultBuf);
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

  private async _classifyInline(store: Store, fingerprint: string): Promise<void> {
    if (this._classifyCache?.hash === fingerprint) return;
    const ig = DataFactory.namedNode(INFERRED_GRAPH_IRI);
    store.removeQuads(store.getQuads(null, null, null, ig));
    const { tripleBuffer, strTableBuffer } = encodeToBuffers(store.getQuads(null, null, null, null));
    await this._call("loadTripleBuffer", [tripleBuffer, strTableBuffer], [tripleBuffer, strTableBuffer]);
    await this._call("classification", []);
    const buf = (await this._call("getInferredTripleBuffer", [])) as ArrayBuffer;
    for (const q of decodeBuffers(buf))
      store.addQuad(DataFactory.quad(q.subject, q.predicate, q.object, ig));
    this._classifyCache = { hash: fingerprint, result: undefined as void };
    this._materializeCache = null;           // cross-invalidate
    this._classifyPropertiesCache = null;    // cross-invalidate
  }

  private async _materializeInline(store: Store, fingerprint: string): Promise<void> {
    if (this._materializeCache?.hash === fingerprint) return;
    const ig = DataFactory.namedNode(INFERRED_GRAPH_IRI);
    store.removeQuads(store.getQuads(null, null, null, ig));
    const { tripleBuffer, strTableBuffer } = encodeToBuffers(store.getQuads(null, null, null, null));
    await this._call("loadTripleBuffer", [tripleBuffer, strTableBuffer], [tripleBuffer, strTableBuffer]);
    await this._call("realization", []);
    const buf = (await this._call("getInferredTripleBuffer", [])) as ArrayBuffer;
    // Write ALL results (including subClassOf) so rdf:type AND subClassOf checks work
    for (const q of decodeBuffers(buf))
      store.addQuad(DataFactory.quad(q.subject, q.predicate, q.object, ig));
    this._materializeCache = { hash: fingerprint, result: undefined as void };
    this._classifyCache = null;              // cross-invalidate
    this._classifyPropertiesCache = null;    // cross-invalidate
  }

  private async _classifyPropertiesInline(store: Store, fingerprint: string): Promise<void> {
    if (this._classifyPropertiesCache?.hash === fingerprint) return;
    const ig = DataFactory.namedNode(INFERRED_GRAPH_IRI);
    store.removeQuads(store.getQuads(null, null, null, ig));
    const { tripleBuffer, strTableBuffer } = encodeToBuffers(store.getQuads(null, null, null, null));
    await this._call("loadTripleBuffer", [tripleBuffer, strTableBuffer], [tripleBuffer, strTableBuffer]);
    await this._call("classification", []);
    const buf = (await this._call("getPropertyTripleBuffer", [])) as ArrayBuffer;
    for (const q of decodeBuffers(buf))
      store.addQuad(DataFactory.quad(q.subject, q.predicate, q.object, ig));
    this._classifyPropertiesCache = { hash: fingerprint, result: undefined as void };
    this._classifyCache = null;              // cross-invalidate
    this._materializeCache = null;           // cross-invalidate
  }

  /** Check whether a single axiom is entailed by the store's ontology. Returns
   *  null for unsupported predicates (a warning is logged). Triggers reasoning
   *  internally if the store has changed since the last call. */
  isEntailed(store: Store, axiom: Quad): Promise<boolean | null>;
  /** Check whether each axiom in a batch is entailed. Returns null for
   *  individual unsupported predicates. Reasoning is triggered at most once
   *  per required operation type. */
  isEntailed(store: Store, axioms: Quad[]): Promise<(boolean | null)[]>;
  isEntailed(
    store: Store,
    axiomOrAxioms: Quad | Quad[],
  ): Promise<boolean | null> | Promise<(boolean | null)[]> {
    const isBatch = Array.isArray(axiomOrAxioms);
    const axioms: Quad[] = isBatch ? (axiomOrAxioms as Quad[]) : [axiomOrAxioms as Quad];

    // Fast-path unsupported check for single axiom (no queue entry needed)
    if (!isBatch) {
      const op = this._opForPredicate((axiomOrAxioms as Quad).predicate.value);
      if (op === null) {
        console.warn(`isEntailed: unsupported predicate <${(axiomOrAxioms as Quad).predicate.value}>`);
        return Promise.resolve(null);
      }
    }

    const result = this._queue.then(async () => {
      const ig = DataFactory.namedNode(INFERRED_GRAPH_IRI);
      const fingerprint = computeStoreFingerprint(store.getQuads(null, null, null, null));

      // Determine which operations are needed
      const needsClassify = axioms.some(a => this._opForPredicate(a.predicate.value) === "classify");
      const needsMaterialize = axioms.some(a => this._opForPredicate(a.predicate.value) === "materialize");
      const needsClassifyProps = axioms.some(a => this._opForPredicate(a.predicate.value) === "classifyProperties");

      // Run needed operations in order; each cross-invalidates others
      // Check classify axioms immediately after classify runs (before materialize overwrites INFERRED_GRAPH_IRI)
      const classifyResults = new Map<Quad, boolean>();
      if (needsClassify) {
        await this._classifyInline(store, fingerprint);
        for (const a of axioms) {
          if (this._opForPredicate(a.predicate.value) === "classify") {
            classifyResults.set(a, store.has(DataFactory.quad(a.subject, a.predicate, a.object, ig)));
          }
        }
      }

      const materializeResults = new Map<Quad, boolean>();
      if (needsMaterialize) {
        await this._materializeInline(store, fingerprint);
        for (const a of axioms) {
          if (this._opForPredicate(a.predicate.value) === "materialize") {
            materializeResults.set(a, store.has(DataFactory.quad(a.subject, a.predicate, a.object, ig)));
          }
        }
      }

      const classifyPropsResults = new Map<Quad, boolean>();
      if (needsClassifyProps) {
        await this._classifyPropertiesInline(store, fingerprint);
        for (const a of axioms) {
          if (this._opForPredicate(a.predicate.value) === "classifyProperties") {
            classifyPropsResults.set(a, store.has(DataFactory.quad(a.subject, a.predicate, a.object, ig)));
          }
        }
      }

      // Assemble results
      if (!isBatch) {
        const axiom = axioms[0];
        const op = this._opForPredicate(axiom.predicate.value);
        if (op === "classify") return classifyResults.get(axiom) ?? false;
        if (op === "materialize") return materializeResults.get(axiom) ?? false;
        if (op === "classifyProperties") return classifyPropsResults.get(axiom) ?? false;
        return null;
      }

      return axioms.map(a => {
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
  whatIf(store: Store, additions: Quad[], opts?: WhatIfOptions): Promise<{ added: Quad[]; removed: Quad[] }> {
    if (opts?.outputGraph === INFERRED_GRAPH_IRI) {
      return Promise.reject(new Error(`whatIf: outputGraph must not equal INFERRED_GRAPH_IRI`));
    }
    if (opts?.outputGraph === HYPOTHETICAL_IRI) {
      return Promise.reject(new Error(`whatIf: outputGraph must not equal HYPOTHETICAL_IRI`));
    }

    const result = this._queue.then(async () => {
      const ig = DataFactory.namedNode(INFERRED_GRAPH_IRI);

      // Snapshot before: current INFERRED_GRAPH_IRI quads (these quads have graph=ig)
      const before: Quad[] = store.getQuads(null, null, null, ig);

      // Build hypothetical quad set: base quads excluding INFERRED/HYPOTHETICAL graphs
      const removalKeys = new Set(
        (opts?.removals ?? []).map(q => `${q.subject.value}\0${q.predicate.value}\0${q.object.value}`)
      );
      const baseQuads = store.getQuads(null, null, null, null).filter(q => {
        const g = q.graph.value;
        if (g === INFERRED_GRAPH_IRI || g === HYPOTHETICAL_IRI) return false;
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
      await this._call("loadTripleBuffer", [tripleBuffer, strTableBuffer], [tripleBuffer, strTableBuffer]);
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
  ): Promise<boolean> {
    const { tripleBuffer, strTableBuffer } = encodeToBuffers(candidates);
    await this._callDirect("loadTripleBuffer", [tripleBuffer, strTableBuffer], [tripleBuffer, strTableBuffer]);
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
    await this._callDirect("loadTripleBuffer", [tripleBuffer, strTableBuffer], [tripleBuffer, strTableBuffer]);
    await this._callDirect("classification", []);
    const consistent = (await this._callDirect("consistency", [])) as boolean;
    return !consistent;
  }

  // -------------------------------------------------------------------------
  // explain()
  // -------------------------------------------------------------------------

  /** Compute minimal justifications for an axiom using the BlackBox algorithm.
   *
   * Returns a list of minimal subsets of the store's base quads, each of which
   * alone entails the axiom. Returns [] if the axiom is not entailed.
   * Each inner Quad[] is a minimal justification.
   *
   * Throws for unsupported predicates (unlike isEntailed which returns null).
   *
   * All BlackBox sub-calls run inside this method's single _queue slot using
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
      // Build candidate set: base quads only (exclude inferred/hypothetical graphs),
      // apply default declaration filter, apply user filter
      const allCandidates = store.getQuads(null, null, null, null).filter(q => {
        const g = q.graph.value;
        if (g === INFERRED_GRAPH_IRI || g === HYPOTHETICAL_IRI) return false;
        if (this._isBuiltInDeclaration(q)) return false;
        if (opts?.axiomFilter && !opts.axiomFilter(q)) return false;
        return true;
      });

      // Invalidate all caches (sub-calls use WASM directly)
      this._classifyCache = null;
      this._materializeCache = null;
      this._classifyPropertiesCache = null;
      this._consistencyCache = null;

      // Fast-path: axiom not entailed at all
      const entailedByAll = await this._checkEntailmentDirect(allCandidates, axiom, opInfo);
      if (!entailedByAll) return [];

      const justifications: Quad[][] = [];

      // Find one MUS via binary-partition shrink + deletion pass
      const findOneJustification = async (candidates: Quad[]): Promise<Quad[] | null> => {
        let working = [...candidates];

        // Shrink phase: binary partition
        let changed = true;
        while (changed && working.length > 1) {
          changed = false;
          const mid = Math.floor(working.length / 2);
          const firstHalf = working.slice(0, mid);
          const secondHalf = working.slice(mid);

          const firstEntails = await this._checkEntailmentDirect(firstHalf, axiom, opInfo);
          if (firstEntails) {
            working = firstHalf;
            changed = true;
            continue;
          }
          const secondEntails = await this._checkEntailmentDirect(secondHalf, axiom, opInfo);
          if (secondEntails) {
            working = secondHalf;
            changed = true;
            continue;
          }
          // Neither half alone entails — need both; stop shrinking
          break;
        }

        // Deletion pass: remove each axiom that is not individually required
        let i = 0;
        while (i < working.length) {
          if (working.length === 1) break; // single axiom must stay
          const without = [...working.slice(0, i), ...working.slice(i + 1)];
          const stillEntails = await this._checkEntailmentDirect(without, axiom, opInfo);
          if (stillEntails) {
            working = without;
            // don't increment i — next element shifted into position i
          } else {
            i++;
          }
        }

        return working;
      };

      // First justification
      const j1 = await findOneJustification(allCandidates);
      if (!j1 || j1.length === 0) return [];
      justifications.push(j1);

      // HSDAG for additional justifications
      if (maxJustifications > 1) {
        // HSDAG queue: pairs of (excluded set, justification to expand from)
        const hsQueue: Array<{ excluded: Set<string>; justification: Quad[] }> = [
          { excluded: new Set(), justification: j1 },
        ];
        const exploredExclusions = new Set<string>();

        while (hsQueue.length > 0 && justifications.length < maxJustifications) {
          const { excluded, justification: currentJ } = hsQueue.shift()!;
          const excludedKey = [...excluded].sort().join("|");
          if (exploredExclusions.has(excludedKey)) continue;
          exploredExclusions.add(excludedKey);

          for (const axiomInJ of currentJ) {
            const newExcluded = new Set(excluded);
            const axKey = `${axiomInJ.subject.value}\0${axiomInJ.predicate.value}\0${axiomInJ.object.value}`;
            newExcluded.add(axKey);

            const newExcludedKey = [...newExcluded].sort().join("|");
            if (exploredExclusions.has(newExcludedKey)) continue;

            const reduced = allCandidates.filter(q => {
              const k = `${q.subject.value}\0${q.predicate.value}\0${q.object.value}`;
              return !newExcluded.has(k);
            });

            const entailed = await this._checkEntailmentDirect(reduced, axiom, opInfo);
            if (!entailed) continue;

            const jNew = await findOneJustification(reduced);
            if (!jNew || jNew.length === 0) continue;

            const jKey = jNew.map(q => `${q.subject.value}\0${q.predicate.value}\0${q.object.value}`).sort().join("|");
            const alreadyFound = justifications.some(j => {
              const k = j.map(q => `${q.subject.value}\0${q.predicate.value}\0${q.object.value}`).sort().join("|");
              return k === jKey;
            });
            if (!alreadyFound) {
              justifications.push(jNew);
              if (justifications.length >= maxJustifications) break;
              hsQueue.push({ excluded: newExcluded, justification: jNew });
            }
          }
        }
      }

      return justifications;
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
   * consistency) for all BlackBox iterations. Does not depend on
   * owl:Thing rdfs:subClassOf owl:Nothing being emitted as an inferred triple.
   */
  explainInconsistency(store: Store, opts?: ExplainOptions): Promise<Quad[][]> {
    const result = this._queue.then(async () => {
      // Build base quads (exclude inferred/hypothetical graphs)
      const allBase = store.getQuads(null, null, null, null).filter(q => {
        const g = q.graph.value;
        return g !== INFERRED_GRAPH_IRI && g !== HYPOTHETICAL_IRI;
      });

      // Fast-path: check consistency using existing cache or direct Worker call
      const fingerprint = computeStoreFingerprint(store.getQuads(null, null, null, null));
      let consistent: boolean;
      if (this._consistencyCache?.hash === fingerprint) {
        consistent = this._consistencyCache.result;
      } else {
        consistent = !(await this._checkInconsistencyDirect(allBase));
        this._consistencyCache = { hash: fingerprint, result: consistent };
      }

      // Invalidate other caches (sub-calls modify WASM state)
      this._classifyCache = null;
      this._materializeCache = null;
      this._classifyPropertiesCache = null;

      if (consistent) return [];

      const maxJustifications = opts?.maxJustifications ?? 1;
      if (maxJustifications === 0) return [];

      // Build candidates: exclude only inferred/hypothetical graphs and user filter.
      // Unlike explain(), we do NOT apply _isBuiltInDeclaration here because
      // rdf:type owl:Class declarations are semantically meaningful for
      // ABox inconsistency (Konclude requires them to recognize disjoint classes).
      const allCandidates = store.getQuads(null, null, null, null).filter(q => {
        const g = q.graph.value;
        if (g === INFERRED_GRAPH_IRI || g === HYPOTHETICAL_IRI) return false;
        if (opts?.axiomFilter && !opts.axiomFilter(q)) return false;
        return true;
      });

      // Invalidate caches before BlackBox sub-calls (we already ran one consistency check)
      this._classifyCache = null;
      this._materializeCache = null;
      this._classifyPropertiesCache = null;
      this._consistencyCache = null;

      // Verify full candidate set is indeed inconsistent (axiomFilter may have changed the set)
      if (!(await this._checkInconsistencyDirect(allCandidates))) return [];

      const justifications: Quad[][] = [];

      const findOneJustification = async (candidates: Quad[]): Promise<Quad[] | null> => {
        let working = [...candidates];
        let changed = true;
        while (changed && working.length > 1) {
          changed = false;
          const mid = Math.floor(working.length / 2);
          const firstHalf = working.slice(0, mid);
          const secondHalf = working.slice(mid);
          if (await this._checkInconsistencyDirect(firstHalf)) {
            working = firstHalf; changed = true; continue;
          }
          if (await this._checkInconsistencyDirect(secondHalf)) {
            working = secondHalf; changed = true; continue;
          }
          break;
        }
        let i = 0;
        while (i < working.length) {
          if (working.length === 1) break;
          const without = [...working.slice(0, i), ...working.slice(i + 1)];
          if (await this._checkInconsistencyDirect(without)) {
            working = without;
          } else {
            i++;
          }
        }
        return working;
      };

      const j1 = await findOneJustification(allCandidates);
      if (!j1 || j1.length === 0) return [];
      justifications.push(j1);

      if (maxJustifications > 1) {
        // HSDAG queue: pairs of (excluded set, justification to expand from)
        const hsQueue: Array<{ excluded: Set<string>; justification: Quad[] }> = [
          { excluded: new Set(), justification: j1 },
        ];
        const exploredExclusions = new Set<string>();
        while (hsQueue.length > 0 && justifications.length < maxJustifications) {
          const { excluded, justification: currentJ } = hsQueue.shift()!;
          const excludedKey = [...excluded].sort().join("|");
          if (exploredExclusions.has(excludedKey)) continue;
          exploredExclusions.add(excludedKey);
          for (const axiomInJ of currentJ) {
            const newExcluded = new Set(excluded);
            const axKey = `${axiomInJ.subject.value}\0${axiomInJ.predicate.value}\0${axiomInJ.object.value}`;
            newExcluded.add(axKey);
            const newExcludedKey = [...newExcluded].sort().join("|");
            if (exploredExclusions.has(newExcludedKey)) continue;
            const reduced = allCandidates.filter(q => !newExcluded.has(`${q.subject.value}\0${q.predicate.value}\0${q.object.value}`));
            if (!(await this._checkInconsistencyDirect(reduced))) continue;
            const jNew = await findOneJustification(reduced);
            if (!jNew || jNew.length === 0) continue;
            const jKey = jNew.map(q => `${q.subject.value}\0${q.predicate.value}\0${q.object.value}`).sort().join("|");
            const alreadyFound = justifications.some(j => j.map(q => `${q.subject.value}\0${q.predicate.value}\0${q.object.value}`).sort().join("|") === jKey);
            if (!alreadyFound) {
              justifications.push(jNew);
              if (justifications.length >= maxJustifications) break;
              hsQueue.push({ excluded: newExcluded, justification: jNew });
            }
          }
        }
      }

      return justifications;
    });
    this._queue = result.then(() => {}, () => {});
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
