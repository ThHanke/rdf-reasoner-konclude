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

// Duck-type check for N3.Store — resilient to duplicate n3 module instances
// (e.g. file:-linked packages with their own node_modules).
function isStore(input: unknown): input is Store {
  return (
    input != null &&
    typeof (input as Store).getQuads === "function" &&
    typeof (input as Store).addQuad === "function" &&
    typeof (input as Store).removeQuads === "function"
  );
}

export type { ReasoningOptions, ReasoningResult, StoreReasoningOptions, MaterializeOptions, MaterializeStoreOptions, ClassifyPropertiesStoreOptions, InferenceDelta, WhatIfOptions, ExplainOptions, ClassWarning, ValidationResult, ValidateOptions, RdfReasonerOptions, EntailmentResult, ExplainEntailmentOptions, LaconicPart, LaconicJustification, LaconicExplainOptions } from "./types.js";
export { INFERRED_GRAPH_IRI, HYPOTHETICAL_IRI } from "./types.js";
export { createInlineWorker } from "./inlineWorker.js";
import type { ReasoningOptions, ReasoningResult, StoreReasoningOptions, MaterializeOptions, MaterializeStoreOptions, ClassifyPropertiesStoreOptions, InferenceDelta, WhatIfOptions, ExplainOptions, ClassWarning, ValidationResult, ValidateOptions, RdfReasonerOptions, EntailmentResult, ExplainEntailmentOptions, LaconicPart, LaconicJustification, LaconicExplainOptions } from "./types.js";
import { INFERRED_GRAPH_IRI, HYPOTHETICAL_IRI } from "./types.js";
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
const OWL_ONTOLOGY = "http://www.w3.org/2002/07/owl#Ontology";
const RDFS_CLASS = "http://www.w3.org/2000/01/rdf-schema#Class";
const OWL_THING = "http://www.w3.org/2002/07/owl#Thing";
const OWL_NOTHING = "http://www.w3.org/2002/07/owl#Nothing";
const OWL_SAME_AS = "http://www.w3.org/2002/07/owl#sameAs";
const OWL_EQUIVALENT_PROPERTY = "http://www.w3.org/2002/07/owl#equivalentProperty";
const OWL_FUNCTIONAL_PROPERTY = "http://www.w3.org/2002/07/owl#FunctionalProperty";
const OWL_INVERSE_FUNCTIONAL_PROPERTY = "http://www.w3.org/2002/07/owl#InverseFunctionalProperty";
const OWL_DISJOINT_UNION_OF = "http://www.w3.org/2002/07/owl#disjointUnionOf";
const OWL_ONE_OF = "http://www.w3.org/2002/07/owl#oneOf";
const RDF_FIRST = "http://www.w3.org/1999/02/22-rdf-syntax-ns#first";
const RDF_REST = "http://www.w3.org/1999/02/22-rdf-syntax-ns#rest";
const RDF_NIL = "http://www.w3.org/1999/02/22-rdf-syntax-ns#nil";
const OWL_SOME_VALUES_FROM = "http://www.w3.org/2002/07/owl#someValuesFrom";
const OWL_ON_PROPERTY = "http://www.w3.org/2002/07/owl#onProperty";
const OWL_RESTRICTION = "http://www.w3.org/2002/07/owl#Restriction";
const OWL_MIN_CARDINALITY = "http://www.w3.org/2002/07/owl#minCardinality";
const OWL_MIN_QUALIFIED_CARDINALITY = "http://www.w3.org/2002/07/owl#minQualifiedCardinality";
const OWL_ON_CLASS = "http://www.w3.org/2002/07/owl#onClass";
const OWL_DIFFERENT_FROM = "http://www.w3.org/2002/07/owl#differentFrom";
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
  private _entailmentProbeCounter = 0;

  constructor(opts?: RdfReasonerOptions) {
    if (opts?.worker) {
      this.worker = opts.worker;
    } else {
      const url = opts?.workerUrl
        ? (typeof opts.workerUrl === "string" ? new URL(opts.workerUrl) : opts.workerUrl)
        : new URL("./worker.js", import.meta.url);

      // Indirect constructor reference so bundlers (Vite) that statically
      // analyze `new Worker(...)` calls skip this dynamic instantiation.
      const W = globalThis.Worker;
      this.worker = new W(url, { type: "module" });
    }

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
    if (isStore(input)) {
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

      await this._call("loadTripleBuffer", [tripleBuffer, strTableBuffer, false], [tripleBuffer, strTableBuffer]);
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

      // Materialize iterable so we can both encode it and post-process it.
      const inputQuads = Array.isArray(quads) ? (quads as Quad[]) : [...quads];

      const { tripleBuffer, strTableBuffer } = encodeToBuffers(inputQuads);

      await this._call("loadTripleBuffer", [tripleBuffer, strTableBuffer, mode !== "classify"], [tripleBuffer, strTableBuffer]);

      if (mode === "consistency") {
        // Consistency mode: no inferred quads are returned via reason().
        // Callers wanting a boolean should use checkConsistency().
        await this._call("realization", []);
        return [];
      }

      // "classify" (default) → TBox-only classification; "full" → full TBox+ABox realization.
      await this._call(mode === "full" ? "realization" : "classification", []);

      const resultBuf = (await this._call("getInferredTripleBuffer", [])) as ArrayBuffer;
      const resultQuads = decodeBuffers(resultBuf);

      return resultQuads;
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
    if (isStore(input)) {
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
    const inputIsStore = isStore(input);
    // Compute fingerprint before entering the queue (snapshot of current store state)
    const fingerprint = inputIsStore
      ? computeStoreFingerprint((input as Store).getQuads(null, null, null, null))
      : null;
    const quads = inputIsStore
      ? (input as Store).getQuads(null, null, null, null)
      : input as Iterable<Quad>;
    // Pre-check: materialise quads once so we can scan and encode from the same array.
    const quadsArray = Array.isArray(quads) ? quads as Quad[] : Array.from(quads);
    const result = this._queue.then(async () => {
      // Cache hit: only available for Store-based calls
      if (fingerprint !== null && this._consistencyCache !== null && this._consistencyCache.hash === fingerprint) {
        return this._consistencyCache.result;
      }

      const { tripleBuffer, strTableBuffer } = encodeToBuffers(quadsArray);
      await this._call("loadTripleBuffer", [tripleBuffer, strTableBuffer, false], [tripleBuffer, strTableBuffer]);
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
    if (isStore(input)) {
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

      await this._call("loadTripleBuffer", [tripleBuffer, strTableBuffer, true], [tripleBuffer, strTableBuffer]);
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
      // Materialize iterable so we can both encode it and post-process it.
      const inputQuads = Array.isArray(quads) ? (quads as Quad[]) : [...quads];

      const { tripleBuffer, strTableBuffer } = encodeToBuffers(inputQuads);

      await this._call("loadTripleBuffer", [tripleBuffer, strTableBuffer, true], [tripleBuffer, strTableBuffer]);
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
    if (isStore(input)) {
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

      await this._call("loadTripleBuffer", [tripleBuffer, strTableBuffer, false], [tripleBuffer, strTableBuffer]);
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
      // Materialize iterable so we can both encode it and post-process it.
      const inputQuads = Array.isArray(quads) ? (quads as Quad[]) : [...quads];

      const { tripleBuffer, strTableBuffer } = encodeToBuffers(inputQuads);

      await this._call("loadTripleBuffer", [tripleBuffer, strTableBuffer, false], [tripleBuffer, strTableBuffer]);
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
    await this._call("loadTripleBuffer", [tripleBuffer, strTableBuffer, false], [tripleBuffer, strTableBuffer]);
    await this._call("classification", []);
    const buf = (await this._call("getInferredTripleBuffer", [])) as ArrayBuffer;
    // Capture base quads BEFORE writing inferred quads so the disjointUnionOf scan
    // only sees the original store contents, not the newly added inferred triples.
    const allQuads = store.getQuads(null, null, null, null);
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
    // Capture base quads BEFORE writing inferred quads so someValuesFrom scan
    // only sees the original store contents.
    const { tripleBuffer, strTableBuffer } = encodeToBuffers(store.getQuads(null, null, null, null));
    await this._call("loadTripleBuffer", [tripleBuffer, strTableBuffer, true], [tripleBuffer, strTableBuffer]);
    await this._call("realization", []);
    const buf = (await this._call("getInferredTripleBuffer", [])) as ArrayBuffer;
    const allQuads = decodeBuffers(buf);
    // Write ALL results (including subClassOf) so rdf:type AND subClassOf checks work
    for (const q of allQuads)
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
    await this._call("loadTripleBuffer", [tripleBuffer, strTableBuffer, false], [tripleBuffer, strTableBuffer]);
    await this._call("classification", []);
    const buf = (await this._call("getPropertyTripleBuffer", [])) as ArrayBuffer;
    for (const q of decodeBuffers(buf))
      store.addQuad(DataFactory.quad(q.subject, q.predicate, q.object, ig));
    this._classifyPropertiesCache = { hash: fingerprint, result: undefined as void };
    this._classifyCache = null;              // cross-invalidate
    this._materializeCache = null;           // cross-invalidate
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
  private async _getUnsatisfiableClassesInternal(store: Store): Promise<string[]> {
    const fingerprint = computeStoreFingerprint(store.getQuads(null, null, null, null));
    if (this._classifyCache?.hash !== fingerprint) {
      const ig = DataFactory.namedNode(INFERRED_GRAPH_IRI);
      store.removeQuads(store.getQuads(null, null, null, ig));
      const { tripleBuffer, strTableBuffer } = encodeToBuffers(store.getQuads(null, null, null, null));
      await this._callDirect("loadTripleBuffer", [tripleBuffer, strTableBuffer, false], [tripleBuffer, strTableBuffer]);
      await this._callDirect("classification", []);
      const buf = (await this._callDirect("getInferredTripleBuffer", [])) as ArrayBuffer;
      for (const q of decodeBuffers(buf))
        store.addQuad(DataFactory.quad(q.subject, q.predicate, q.object, ig));
      this._classifyCache = { hash: fingerprint, result: undefined as void };
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
  getUnsatisfiableClasses(store: Store): Promise<string[]> {
    const result = this._queue.then(async () =>
      this._getUnsatisfiableClassesInternal(store),
    );
    this._queue = result.then(() => {}, () => {});
    return result;
  }

  /** Return `false` if `classIRI` is equivalent to owl:Nothing in the ontology.
   *  Returns `true` for any class absent from the taxonomy (open-world assumption).
   *  owl:Nothing is always unsatisfiable; returns `false` without a Worker call. */
  isSatisfiable(store: Store, classIRI: string): Promise<boolean> {
    if (classIRI === OWL_NOTHING) return Promise.resolve(false);
    const result = this._queue.then(async () => {
      const unsatSet = await this._getUnsatisfiableClassesInternal(store);
      return !unsatSet.includes(classIRI);
    });
    this._queue = result.then(() => {}, () => {});
    return result;
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
      await this._call("loadTripleBuffer", [tripleBuffer, strTableBuffer, true], [tripleBuffer, strTableBuffer]);
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
    await this._callDirect("loadTripleBuffer", [tripleBuffer, strTableBuffer, opInfo.op === "realization"], [tripleBuffer, strTableBuffer]);
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
    await this._callDirect("loadTripleBuffer", [tripleBuffer, strTableBuffer, false], [tripleBuffer, strTableBuffer]);
    await this._callDirect("classification", []);
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
    await this._callDirect("loadTripleBuffer", [tripleBuffer, strTableBuffer, false], [tripleBuffer, strTableBuffer]);
    await this._callDirect("classification", []);
    const raw = (await this._callDirect("getUnsatisfiableClassBuffer", [])) as string;
    return raw.split('\n').filter(Boolean).includes(classIRI);
  }

  private async _isSubClassOfDirect(sub: string, sup: string): Promise<boolean> {
    return (await this._callDirect("isSubClassOf", [sub, sup])) as boolean;
  }

  private async _isInstanceOfDirect(indi: string, cls: string): Promise<boolean> {
    return (await this._callDirect("isInstanceOf", [indi, cls])) as boolean;
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

  /** IU-A1: Reverse-map a concept tag to source axiom NTriples. */
  async _getAxiomsForConceptTag(tag: number): Promise<string> {
    return (await this._callDirect("getAxiomsForConceptTag", [tag])) as string;
  }

  /** IU-A1: Reverse-map a role tag to source axiom NTriples. */
  async _getAxiomsForRoleTag(tag: number): Promise<string> {
    return (await this._callDirect("getAxiomsForRoleTag", [tag])) as string;
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

  // ── TS synthesis helpers ──────────────────────────────────────────
  // For workaround-computed types: justification = relevant input axioms.

  private _synthesizeSameAsJustification(
    allBase: Quad[], subjectIri: string, objectIri: string,
  ): Quad[] | null {
    // FP case: find functional property R where both subject and object
    // have assertions with the same filler
    const fpDecls = allBase.filter(
      q => q.predicate.value === RDF_TYPE && q.object.value === OWL_FUNCTIONAL_PROPERTY,
    );
    for (const fpDecl of fpDecls) {
      const prop = fpDecl.subject.value;
      const subFillers = allBase.filter(
        q => q.subject.value === subjectIri && q.predicate.value === prop,
      );
      const objFillers = allBase.filter(
        q => q.subject.value === objectIri && q.predicate.value === prop,
      );
      for (const sf of subFillers) {
        for (const of_ of objFillers) {
          if (sf.object.value === of_.object.value) {
            return [fpDecl, sf, of_];
          }
        }
      }
    }

    // IFP case: find inverse-functional property R where both subject and
    // object appear as objects with the same source
    const ifpDecls = allBase.filter(
      q => q.predicate.value === RDF_TYPE && q.object.value === OWL_INVERSE_FUNCTIONAL_PROPERTY,
    );
    for (const ifpDecl of ifpDecls) {
      const prop = ifpDecl.subject.value;
      const subSources = allBase.filter(
        q => q.object.value === subjectIri && q.predicate.value === prop,
      );
      const objSources = allBase.filter(
        q => q.object.value === objectIri && q.predicate.value === prop,
      );
      for (const ss of subSources) {
        for (const os of objSources) {
          if (ss.subject.value === os.subject.value) {
            return [ifpDecl, ss, os];
          }
        }
      }
    }

    return null;
  }

  private _synthesizeEquivalentPropertyJustification(
    allBase: Quad[], subjectIri: string, objectIri: string,
  ): Quad[] | null {
    const direct = allBase.find(
      q => q.subject.value === subjectIri &&
           q.predicate.value === OWL_EQUIVALENT_PROPERTY &&
           q.object.value === objectIri,
    );
    if (direct) return [direct];

    const reverse = allBase.find(
      q => q.subject.value === objectIri &&
           q.predicate.value === OWL_EQUIVALENT_PROPERTY &&
           q.object.value === subjectIri,
    );
    if (reverse) return [reverse];

    return null;
  }

  private _synthesizeEquivalentClassJustification(
    allBase: Quad[], subjectIri: string, objectIri: string,
  ): Quad[] | null {
    // Direct assertion
    const direct = allBase.find(
      q => q.subject.value === subjectIri &&
           q.predicate.value === OWL_EQUIVALENT_CLASS &&
           q.object.value === objectIri,
    );
    if (direct) return [direct];

    const reverse = allBase.find(
      q => q.subject.value === objectIri &&
           q.predicate.value === OWL_EQUIVALENT_CLASS &&
           q.object.value === subjectIri,
    );
    if (reverse) return [reverse];

    // Bidirectional subClassOf via native cache
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

  private _walkRdfList(allBase: Quad[], headNode: string): string[] {
    const members: string[] = [];
    let current = headNode;
    for (let i = 0; i < 1000; i++) {
      if (current === RDF_NIL) break;
      const first = allBase.find(
        q => q.subject.value === current && q.predicate.value === RDF_FIRST,
      );
      if (first) members.push(first.object.value);
      const rest = allBase.find(
        q => q.subject.value === current && q.predicate.value === RDF_REST,
      );
      if (!rest) break;
      current = rest.object.value;
    }
    return members;
  }

  private _collectRdfListQuads(allBase: Quad[], headNode: string): Quad[] {
    const quads: Quad[] = [];
    let current = headNode;
    for (let i = 0; i < 1000; i++) {
      if (current === RDF_NIL) break;
      const first = allBase.find(
        q => q.subject.value === current && q.predicate.value === RDF_FIRST,
      );
      if (first) quads.push(first);
      const rest = allBase.find(
        q => q.subject.value === current && q.predicate.value === RDF_REST,
      );
      if (rest) quads.push(rest);
      if (!rest) break;
      current = rest.object.value;
    }
    return quads;
  }

  private _synthesizeSomeValuesFromJustification(
    allBase: Quad[], inferred: Quad[], subjectIri: string, objectIri: string,
  ): Quad[] | null {
    const restrictions = allBase.filter(
      q => q.predicate.value === OWL_SOME_VALUES_FROM && q.object.value === objectIri,
    );
    for (const svfQuad of restrictions) {
      const rNode = svfQuad.subject.value;
      const propQuad = allBase.find(
        q => q.subject.value === rNode && q.predicate.value === OWL_ON_PROPERTY,
      );
      if (!propQuad) continue;
      const prop = propQuad.object.value;
      const classQuad = allBase.find(
        q => (q.predicate.value === OWL_EQUIVALENT_CLASS || q.predicate.value === RDFS_SUB_CLASS_OF) &&
             q.object.value === rNode,
      );
      if (!classQuad) continue;
      const sourceClass = classQuad.subject.value;
      const typeQuads = allBase.filter(
        q => q.predicate.value === RDF_TYPE && q.object.value === sourceClass,
      );
      const inferredTypeQuads = inferred.filter(
        q => q.predicate.value === RDF_TYPE && q.object.value === sourceClass,
      );
      const allTypeQuads = [...typeQuads, ...inferredTypeQuads];
      for (const tq of allTypeQuads) {
        const sourceIndi = tq.subject.value;
        const roleQuad = allBase.find(
          q => q.subject.value === sourceIndi && q.predicate.value === prop && q.object.value === subjectIri,
        );
        if (!roleQuad) continue;
        const restrictionTypeQuad = allBase.find(
          q => q.subject.value === rNode && q.predicate.value === RDF_TYPE && q.object.value === OWL_RESTRICTION,
        );
        const justification: Quad[] = [];
        if (restrictionTypeQuad) justification.push(restrictionTypeQuad);
        justification.push(svfQuad, propQuad, classQuad, tq, roleQuad);
        return justification;
      }
    }
    return null;
  }

  private _synthesizeMinCardinalityJustification(
    allBase: Quad[], subjectIri: string, objectIri: string,
  ): Quad[] | null {
    const mcQuads = allBase.filter(
      q => q.predicate.value === OWL_MIN_CARDINALITY || q.predicate.value === OWL_MIN_QUALIFIED_CARDINALITY,
    );
    for (const mcQuad of mcQuads) {
      const rNode = mcQuad.subject.value;
      const minCard = parseInt(mcQuad.object.value, 10);
      if (isNaN(minCard) || minCard < 1) continue;
      const propQuad = allBase.find(
        q => q.subject.value === rNode && q.predicate.value === OWL_ON_PROPERTY,
      );
      if (!propQuad) continue;
      const prop = propQuad.object.value;
      const classQuad = allBase.find(
        q => (q.predicate.value === OWL_EQUIVALENT_CLASS || q.predicate.value === RDFS_SUB_CLASS_OF) &&
             q.object.value === rNode,
      );
      if (!classQuad) continue;
      if (classQuad.subject.value !== objectIri) continue;
      const roleAssertions = allBase.filter(
        q => q.subject.value === subjectIri && q.predicate.value === prop,
      );
      if (roleAssertions.length < minCard) continue;
      if (minCard === 1) {
        const restrictionTypeQuad = allBase.find(
          q => q.subject.value === rNode && q.predicate.value === RDF_TYPE && q.object.value === OWL_RESTRICTION,
        );
        const justification: Quad[] = [];
        if (restrictionTypeQuad) justification.push(restrictionTypeQuad);
        justification.push(mcQuad, propQuad, classQuad, roleAssertions[0]);
        return justification;
      }
      const fillers = roleAssertions.map(q => q.object.value);
      const diffPairs: Quad[] = [];
      for (let a = 0; a < fillers.length && diffPairs.length < minCard * (minCard - 1); a++) {
        for (let b = a + 1; b < fillers.length; b++) {
          const df = allBase.find(
            q => (q.subject.value === fillers[a] && q.predicate.value === OWL_DIFFERENT_FROM && q.object.value === fillers[b]) ||
                 (q.subject.value === fillers[b] && q.predicate.value === OWL_DIFFERENT_FROM && q.object.value === fillers[a]),
          );
          if (df) diffPairs.push(df);
        }
      }
      if (diffPairs.length >= (minCard * (minCard - 1)) / 2) {
        const restrictionTypeQuad = allBase.find(
          q => q.subject.value === rNode && q.predicate.value === RDF_TYPE && q.object.value === OWL_RESTRICTION,
        );
        const justification: Quad[] = [];
        if (restrictionTypeQuad) justification.push(restrictionTypeQuad);
        justification.push(mcQuad, propQuad, classQuad, ...roleAssertions.slice(0, minCard), ...diffPairs);
        return justification;
      }
    }
    return null;
  }

  private _synthesizeOneOfTypeJustification(
    allBase: Quad[], subjectIri: string, objectIri: string,
  ): Quad[] | null {
    const oneOfQuads = allBase.filter(
      q => q.subject.value === objectIri && q.predicate.value === OWL_ONE_OF,
    );
    for (const oneOfQuad of oneOfQuads) {
      const listHead = oneOfQuad.object.value;
      const members = this._walkRdfList(allBase, listHead);
      if (members.includes(subjectIri)) {
        const listQuads = this._collectRdfListQuads(allBase, listHead);
        return [oneOfQuad, ...listQuads];
      }
    }
    return null;
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
      // Partition base quads into:
      //   allCandidates — justification candidates (built-in declarations excluded)
      //   background    — built-in declarations always passed to WASM so Konclude
      //                   can recognise classes/properties, but never returned as
      //                   part of a justification
      const allCandidates: Quad[] = [];
      const background: Quad[] = [];
      for (const q of store.getQuads(null, null, null, null)) {
        const g = q.graph.value;
        if (g === INFERRED_GRAPH_IRI || g === HYPOTHETICAL_IRI) continue;
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
      this._consistencyCache = null;

      // Fast-path: axiom not entailed at all
      const entailedByAll = await this._checkEntailmentDirect(allCandidates, axiom, opInfo, background);
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

          const firstEntails = await this._checkEntailmentDirect(firstHalf, axiom, opInfo, background);
          if (firstEntails) {
            working = firstHalf;
            changed = true;
            continue;
          }
          const secondEntails = await this._checkEntailmentDirect(secondHalf, axiom, opInfo, background);
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
          const stillEntails = await this._checkEntailmentDirect(without, axiom, opInfo, background);
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

            const entailed = await this._checkEntailmentDirect(reduced, axiom, opInfo, background);
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
      const ig = opts?.inferredGraph ?? INFERRED_GRAPH_IRI;
      // Build base quads (exclude inferred/hypothetical graphs)
      const allBase = store.getQuads(null, null, null, null).filter(q => {
        const g = q.graph.value;
        return g !== ig && g !== HYPOTHETICAL_IRI;
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
        if (g === ig || g === HYPOTHETICAL_IRI) return false;
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
        return g !== ig && g !== HYPOTHETICAL_IRI;
      });

      const fingerprint = computeStoreFingerprint(store.getQuads(null, null, null, null));
      let consistent: boolean;
      if (this._consistencyCache?.hash === fingerprint) {
        consistent = this._consistencyCache.result;
      } else {
        consistent = !(await this._checkInconsistencyDirect(allBase));
        this._consistencyCache = { hash: fingerprint, result: consistent };
      }

      this._classifyCache = null;
      this._materializeCache = null;
      this._classifyPropertiesCache = null;

      if (consistent) return [];

      const maxJustifications = opts?.maxJustifications ?? 1;
      if (maxJustifications === 0) return [];

      const allCandidates = store.getQuads(null, null, null, null).filter(q => {
        const g = q.graph.value;
        if (g === ig || g === HYPOTHETICAL_IRI) return false;
        if (opts?.axiomFilter && !opts.axiomFilter(q)) return false;
        return true;
      });

      this._classifyCache = null;
      this._materializeCache = null;
      this._classifyPropertiesCache = null;
      this._consistencyCache = null;

      if (!(await this._checkInconsistencyDirect(allCandidates))) return [];

      // Find MIPS (same inline BlackBox as explainInconsistency)
      const findOne = async (cands: Quad[]): Promise<Quad[] | null> => {
        let w = [...cands];
        let changed = true;
        while (changed && w.length > 1) {
          changed = false;
          const mid = Math.floor(w.length / 2);
          const [fh, sh] = [w.slice(0, mid), w.slice(mid)];
          if (await this._checkInconsistencyDirect(fh)) { w = fh; changed = true; continue; }
          if (await this._checkInconsistencyDirect(sh)) { w = sh; changed = true; continue; }
          break;
        }
        let i = 0;
        while (i < w.length) {
          if (w.length === 1) break;
          const without = [...w.slice(0, i), ...w.slice(i + 1)];
          if (await this._checkInconsistencyDirect(without)) { w = without; } else { i++; }
        }
        return w;
      };

      const justifications: Quad[][] = [];
      const j1 = await findOne(allCandidates);
      if (!j1 || j1.length === 0) return [];
      justifications.push(j1);

      if (maxJustifications > 1) {
        const hsQueue: Array<{ excluded: Set<string>; justification: Quad[] }> = [
          { excluded: new Set(), justification: j1 },
        ];
        const explored = new Set<string>();
        const keyOf = (q: Quad) => `${q.subject.value}\0${q.predicate.value}\0${q.object.value}`;
        while (hsQueue.length > 0 && justifications.length < maxJustifications) {
          const { excluded, justification: curJ } = hsQueue.shift()!;
          const eKey = [...excluded].sort().join("|");
          if (explored.has(eKey)) continue;
          explored.add(eKey);
          for (const ax of curJ) {
            const newExcl = new Set(excluded);
            newExcl.add(keyOf(ax));
            const nKey = [...newExcl].sort().join("|");
            if (explored.has(nKey)) continue;
            const reduced = allCandidates.filter(q => !newExcl.has(keyOf(q)));
            if (!(await this._checkInconsistencyDirect(reduced))) continue;
            const jN = await findOne(reduced);
            if (!jN || jN.length === 0) continue;
            const jKey = jN.map(keyOf).sort().join("|");
            if (!justifications.some(j => j.map(keyOf).sort().join("|") === jKey)) {
              justifications.push(jN);
              if (justifications.length >= maxJustifications) break;
              hsQueue.push({ excluded: newExcl, justification: jN });
            }
          }
        }
      }

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
        return g !== ig && g !== HYPOTHETICAL_IRI;
      });

      const probeKind = classifyAxiom(predicateIri, objectIsClassLike);

      if (probeKind === "unsupported") {
        const asserted = allBase.some(
          q => q.subject.value === subjectIri &&
               q.predicate.value === predicateIri &&
               q.object.value === objectIri,
        );
        return { isEntailed: asserted, justifications: [] as Quad[][] };
      }

      // ── Native fast path ──────────────────────────────────────────────
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
          const hasNative = await this._hasNativeJustificationDirect(assertedType, objectIri);
          if (!hasNative) continue;
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

        // someValuesFrom synthesis: restriction + role assertion → type
        const inferredQuads = store.getQuads(null, null, null, DataFactory.namedNode(ig));
        const svfJust = this._synthesizeSomeValuesFromJustification(allBase, inferredQuads, subjectIri, objectIri);
        if (svfJust) return { isEntailed: true, justifications: [svfJust] };

        // minCardinality synthesis: restriction + enough distinct fillers → type
        const mcJust = this._synthesizeMinCardinalityJustification(allBase, subjectIri, objectIri);
        if (mcJust) return { isEntailed: true, justifications: [mcJust] };

        // oneOf synthesis: class owl:oneOf (...members...) → member rdf:type class
        const oneOfJust = this._synthesizeOneOfTypeJustification(allBase, subjectIri, objectIri);
        if (oneOfJust) return { isEntailed: true, justifications: [oneOfJust] };
      }

      // ── TS synthesis path ────────────────────────────────────────────
      // Workaround-computed types: justification = input axiom data.

      if (probeKind === "sameAs") {
        const just = this._synthesizeSameAsJustification(allBase, subjectIri, objectIri);
        if (just) return { isEntailed: true, justifications: [just] };
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
        return { isEntailed: false, justifications: [] as Quad[][] };
      }

      if (probeKind === "equivalentProperty") {
        const just = this._synthesizeEquivalentPropertyJustification(allBase, subjectIri, objectIri);
        if (just) return { isEntailed: true, justifications: [just] };
        return { isEntailed: false, justifications: [] as Quad[][] };
      }

      if (probeKind === "equivalentClass") {
        const just = this._synthesizeEquivalentClassJustification(allBase, subjectIri, objectIri);
        if (just) return { isEntailed: true, justifications: [just] };

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

      if (probeKind === "disjointWith") {
        const just = this._synthesizeDisjointWithJustification(allBase, subjectIri, objectIri);
        if (just) return { isEntailed: true, justifications: [just] };

        // Native classification cache: disjointness stored as Classification entries
        const hasNative = await this._hasJustificationByTypeDirect(
          subjectIri, objectIri, RdfReasoner._ET_CLASSIFICATION);
        if (hasNative) {
          const ntriples = await this._getJustificationByTypeDirect(
            subjectIri, objectIri, RdfReasoner._ET_CLASSIFICATION);
          const justQuads = this._parseNTriplesJustification(ntriples);
          if (justQuads.length > 0) {
            return { isEntailed: true, justifications: [justQuads] };
          }
        }
        return { isEntailed: false, justifications: [] as Quad[][] };
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

      // ── BlackBox fallback ─────────────────────────────────────────────
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
        await this._callDirect("loadTripleBuffer", [tripleBuffer, strTableBuffer, false], [tripleBuffer, strTableBuffer]);
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
      this._consistencyCache = null;

      // Partition into justification candidates vs background declarations
      const ontologyCandidates: Quad[] = [];
      const background: Quad[] = [];
      for (const q of allBase) {
        if (this._isBuiltInDeclaration(q)) { background.push(q); }
        else { ontologyCandidates.push(q); }
      }
      const filteredCandidates = opts?.axiomFilter
        ? ontologyCandidates.filter(q => opts.axiomFilter!(q))
        : ontologyCandidates;

      const keyOf = (q: Quad) => `${q.subject.value}\0${q.predicate.value}\0${q.object.value}`;
      const stripProbe = (j: Quad[]): Quad[] =>
        j.filter(q => !probe.probeKeys.has(probeTripleKey(q.subject.value, q.predicate.value, q.object.value)));

      const justifications: Quad[][] = [];

      // BlackBox find one justification
      const findOne = async (ontCandidates: Quad[]): Promise<Quad[] | null> => {
        let working = [...ontCandidates];

        let changed = true;
        while (changed && working.length > 1) {
          changed = false;
          const mid = Math.floor(working.length / 2);
          const fh = working.slice(0, mid);
          const sh = working.slice(mid);
          if (await this._checkInconsistencyDirect([...fh, ...probe.probeQuads, ...background])) {
            working = fh; changed = true; continue;
          }
          if (await this._checkInconsistencyDirect([...sh, ...probe.probeQuads, ...background])) {
            working = sh; changed = true; continue;
          }
          break;
        }

        let i = 0;
        while (i < working.length) {
          if (working.length === 0) break;
          const without = [...working.slice(0, i), ...working.slice(i + 1)];
          if (await this._checkInconsistencyDirect([...without, ...probe.probeQuads, ...background])) {
            working = without;
          } else {
            i++;
          }
        }

        return working.length > 0 ? [...working, ...probe.probeQuads] : null;
      };

      if (!(await this._checkInconsistencyDirect([...filteredCandidates, ...probe.probeQuads, ...background]))) {
        return { isEntailed: true, justifications: [] as Quad[][] };
      }

      const j1 = await findOne(filteredCandidates);
      if (!j1 || j1.length === 0) {
        return { isEntailed: true, justifications: [] as Quad[][] };
      }
      justifications.push(stripProbe(j1));

      if (maxJustifications > 1) {
        const hsQueue: Array<{ excluded: Set<string>; justification: Quad[] }> = [
          { excluded: new Set(), justification: j1 },
        ];
        const explored = new Set<string>();
        while (hsQueue.length > 0 && justifications.length < maxJustifications) {
          const { excluded, justification: curJ } = hsQueue.shift()!;
          const eKey = [...excluded].sort().join("|");
          if (explored.has(eKey)) continue;
          explored.add(eKey);
          for (const ax of curJ) {
            if (probe.probeKeys.has(probeTripleKey(ax.subject.value, ax.predicate.value, ax.object.value))) continue;
            const newExcl = new Set(excluded);
            newExcl.add(keyOf(ax));
            const nKey = [...newExcl].sort().join("|");
            if (explored.has(nKey)) continue;
            const reduced = filteredCandidates.filter(q => !newExcl.has(keyOf(q)));
            if (!(await this._checkInconsistencyDirect([...reduced, ...probe.probeQuads, ...background]))) continue;
            const jNew = await findOne(reduced);
            if (!jNew || jNew.length === 0) continue;
            const jKey = stripProbe(jNew).map(keyOf).sort().join("|");
            if (!justifications.some(j => j.map(keyOf).sort().join("|") === jKey)) {
              justifications.push(stripProbe(jNew));
              if (justifications.length >= maxJustifications) break;
              hsQueue.push({ excluded: newExcl, justification: jNew });
            }
          }
        }
      }

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
   *  All BlackBox iterations run inside this method's single _queue slot.
   *  Do NOT call public methods from inside — use private helpers only.
   */
  validate(store: Store, opts?: ValidateOptions): Promise<ValidationResult> {
    const result = this._queue.then(async () => {
      const maxErr  = opts?.maxJustificationsPerError  ?? 1;
      const maxWarn = opts?.maxJustificationsPerWarning ?? 1;

      const allBase = store.getQuads(null, null, null, null).filter(q =>
        q.graph.value !== INFERRED_GRAPH_IRI && q.graph.value !== HYPOTHETICAL_IRI,
      );

      const makeCandidates = () => store.getQuads(null, null, null, null).filter(q => {
        const g = q.graph.value;
        if (g === INFERRED_GRAPH_IRI || g === HYPOTHETICAL_IRI) return false;
        if (opts?.axiomFilter && !opts.axiomFilter(q)) return false;
        return true;
      });

      // ── Step 1: consistency ───────────────────────────────────────────────
      const fingerprint = computeStoreFingerprint(store.getQuads(null, null, null, null));
      let consistent: boolean;
      if (this._consistencyCache?.hash === fingerprint) {
        consistent = this._consistencyCache.result;
      } else {
        consistent = !(await this._checkInconsistencyDirect(allBase));
        this._consistencyCache = { hash: fingerprint, result: consistent };
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
          const findOneIncons = async (cands: Quad[]): Promise<Quad[] | null> => {
            let w = [...cands];
            let changed = true;
            while (changed && w.length > 1) {
              changed = false;
              const mid = Math.floor(w.length / 2);
              const [fh, sh] = [w.slice(0, mid), w.slice(mid)];
              if (await this._checkInconsistencyDirect(fh)) { w = fh; changed = true; continue; }
              if (await this._checkInconsistencyDirect(sh)) { w = sh; changed = true; continue; }
              break;
            }
            let i = 0;
            while (i < w.length) {
              if (w.length === 1) break;
              const without = [...w.slice(0, i), ...w.slice(i + 1)];
              if (await this._checkInconsistencyDirect(without)) { w = without; } else { i++; }
            }
            return w;
          };

          const j1 = await findOneIncons(allCandidates);
          if (j1 && j1.length > 0) {
            errors.push(j1);
            if (maxErr > 1) {
              const hsQ: Array<{ excluded: Set<string>; justification: Quad[] }> = [{ excluded: new Set(), justification: j1 }];
              const explored = new Set<string>();
              outer: while (hsQ.length > 0 && errors.length < maxErr) {
                const { excluded, justification: curJ } = hsQ.shift()!;
                const eKey = [...excluded].sort().join("|");
                if (explored.has(eKey)) continue;
                explored.add(eKey);
                for (const ax of curJ) {
                  const newExcl = new Set(excluded);
                  newExcl.add(`${ax.subject.value}\0${ax.predicate.value}\0${ax.object.value}`);
                  const nKey = [...newExcl].sort().join("|");
                  if (explored.has(nKey)) continue;
                  const reduced = allCandidates.filter(q => !newExcl.has(`${q.subject.value}\0${q.predicate.value}\0${q.object.value}`));
                  if (!(await this._checkInconsistencyDirect(reduced))) continue;
                  const jN = await findOneIncons(reduced);
                  if (!jN || jN.length === 0) continue;
                  const jNKey = jN.map(q => `${q.subject.value}\0${q.predicate.value}\0${q.object.value}`).sort().join("|");
                  if (!errors.some(j => j.map(q => `${q.subject.value}\0${q.predicate.value}\0${q.object.value}`).sort().join("|") === jNKey)) {
                    errors.push(jN);
                    if (errors.length >= maxErr) break outer;
                    hsQ.push({ excluded: newExcl, justification: jN });
                  }
                }
              }
            }
          }
        }
      }

      // ── Step 3: unsatisfiable classes ─────────────────────────────────────
      const unsatIRIs = await this._getUnsatisfiableClassesInternal(store);

      // ── Step 4: warning justifications ────────────────────────────────────
      // Native fast path: classification already ran (step 3), so the
      // dep-chain cache contains clash justifications for unsatisfiable
      // classes keyed as (C, owl:Nothing). Zero extra WASM reloads.
      // Falls back to BlackBox only when native justification is absent.
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

          // BlackBox fallback
          const warnCands = makeCandidates();

          this._classifyCache = null;
          this._materializeCache = null;
          this._classifyPropertiesCache = null;
          this._consistencyCache = null;

          if (!(await this._checkUnsatisfiabilityDirect(warnCands, classIRI))) {
            warnings.push({ classIRI, justifications: [] });
            continue;
          }

          const findOneWarning = async (cands: Quad[]): Promise<Quad[] | null> => {
            let w = [...cands];
            let changed = true;
            while (changed && w.length > 1) {
              changed = false;
              const mid = Math.floor(w.length / 2);
              const [fh, sh] = [w.slice(0, mid), w.slice(mid)];
              if (await this._checkUnsatisfiabilityDirect(fh, classIRI)) { w = fh; changed = true; continue; }
              if (await this._checkUnsatisfiabilityDirect(sh, classIRI)) { w = sh; changed = true; continue; }
              break;
            }
            let i = 0;
            while (i < w.length) {
              if (w.length === 1) break;
              const without = [...w.slice(0, i), ...w.slice(i + 1)];
              if (await this._checkUnsatisfiabilityDirect(without, classIRI)) { w = without; } else { i++; }
            }
            return w;
          };

          const justs: Quad[][] = [];
          const j1 = await findOneWarning(warnCands);
          if (j1 && j1.length > 0) {
            justs.push(j1);
            if (maxWarn > 1) {
              const hsQ: Array<{ excluded: Set<string>; justification: Quad[] }> = [{ excluded: new Set(), justification: j1 }];
              const explored = new Set<string>();
              outer: while (hsQ.length > 0 && justs.length < maxWarn) {
                const { excluded, justification: curJ } = hsQ.shift()!;
                const eKey = [...excluded].sort().join("|");
                if (explored.has(eKey)) continue;
                explored.add(eKey);
                for (const ax of curJ) {
                  const newExcl = new Set(excluded);
                  newExcl.add(`${ax.subject.value}\0${ax.predicate.value}\0${ax.object.value}`);
                  const nKey = [...newExcl].sort().join("|");
                  if (explored.has(nKey)) continue;
                  const reduced = warnCands.filter(q => !newExcl.has(`${q.subject.value}\0${q.predicate.value}\0${q.object.value}`));
                  if (!(await this._checkUnsatisfiabilityDirect(reduced, classIRI))) continue;
                  const jN = await findOneWarning(reduced);
                  if (!jN || jN.length === 0) continue;
                  const jNKey = jN.map(q => `${q.subject.value}\0${q.predicate.value}\0${q.object.value}`).sort().join("|");
                  if (!justs.some(j => j.map(q => `${q.subject.value}\0${q.predicate.value}\0${q.object.value}`).sort().join("|") === jNKey)) {
                    justs.push(jN);
                    if (justs.length >= maxWarn) break outer;
                    hsQ.push({ excluded: newExcl, justification: jN });
                  }
                }
              }
            }
          }

          warnings.push({ classIRI, justifications: justs });
        }
      }

      return { consistent, errors, warnings };
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
