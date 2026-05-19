/**
 * Unit tests for RdfReasoner.materialize() — Quad[] and Store overloads.
 *
 * Follows the same vi.hoisted / vi.stubGlobal("Worker") scaffolding used in
 * RdfReasoner.test.ts and RdfReasoner.store.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { DataFactory, Store } from "n3";
import type { Quad } from "@rdfjs/types";
import { encodeToBuffers } from "../../ts/intern.js";

// ---------------------------------------------------------------------------
// Step 1: Hoist mock state
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
  const workerPostMessage = vi.fn<[unknown], void>();
  const listeners = new Map<string, Set<(event: unknown) => void>>();

  function addEventListener(type: string, fn: (event: unknown) => void) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type)!.add(fn);
  }

  function removeEventListener(type: string, fn: (event: unknown) => void) {
    listeners.get(type)?.delete(fn);
  }

  function dispatchToListeners(type: string, event: unknown) {
    listeners.get(type)?.forEach((fn) => fn(event));
  }

  function clearListeners() {
    listeners.clear();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const WorkerMock = vi.fn(function (this: any, _url: unknown, _opts: unknown) {
    this.postMessage = workerPostMessage;
    this.terminate = vi.fn();
    this.addEventListener = addEventListener;
    this.removeEventListener = removeEventListener;
  });

  return { workerPostMessage, WorkerMock, dispatchToListeners, clearListeners };
});

// ---------------------------------------------------------------------------
// Step 2: Mock Worker global
// ---------------------------------------------------------------------------
vi.stubGlobal("Worker", mocks.WorkerMock);

// ---------------------------------------------------------------------------
// Step 3: Import module under test
// ---------------------------------------------------------------------------
import { RdfReasoner, INFERRED_GRAPH_IRI } from "../../ts/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const { namedNode, quad, defaultGraph, literal } = DataFactory;

const rdfType = namedNode("http://www.w3.org/1999/02/22-rdf-syntax-ns#type");
const subClassOf = namedNode("http://www.w3.org/2000/01/rdf-schema#subClassOf");
const equivalentClass = namedNode("http://www.w3.org/2002/07/owl#equivalentClass");

const A = namedNode("http://example.org/A");
const B = namedNode("http://example.org/B");
const C = namedNode("http://example.org/C");
const alice = namedNode("http://example.org/alice");

function simulateWorkerMessage(data: unknown) {
  mocks.dispatchToListeners("message", { data } as MessageEvent);
}

async function makeReadyReasoner(): Promise<RdfReasoner> {
  const reasoner = new RdfReasoner();
  await Promise.resolve();
  simulateWorkerMessage({ type: "ready" });
  await reasoner.ready;
  return reasoner;
}

function buildCombinedBuffer(quads: Iterable<Quad>): ArrayBuffer {
  const { tripleBuffer, strTableBuffer } = encodeToBuffers(quads);
  const combined = new Uint8Array(4 + strTableBuffer.byteLength + tripleBuffer.byteLength);
  new DataView(combined.buffer).setUint32(0, strTableBuffer.byteLength, true);
  combined.set(new Uint8Array(strTableBuffer), 4);
  combined.set(new Uint8Array(tripleBuffer), 4 + strTableBuffer.byteLength);
  return combined.buffer;
}

/**
 * Set up mock responses for the realization pipeline sequence.
 * Returns the specified quads from getInferredTripleBuffer.
 */
function mockRealizationSequence(inferredQuads: Quad[]) {
  const buf = buildCombinedBuffer(inferredQuads);
  mocks.workerPostMessage.mockImplementation((msg: unknown) => {
    const req = msg as { id: number; method: string };
    if (req.method === "loadTripleBuffer") {
      simulateWorkerMessage({ id: req.id, result: true });
    } else if (req.method === "realization") {
      simulateWorkerMessage({ id: req.id, result: true });
    } else if (req.method === "getInferredTripleBuffer") {
      simulateWorkerMessage({ id: req.id, result: buf });
    }
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RdfReasoner.materialize()", () => {
  beforeEach(() => {
    mocks.workerPostMessage.mockClear();
    mocks.WorkerMock.mockClear();
    mocks.clearListeners();
  });

  // -------------------------------------------------------------------------
  // Quad[] overload — happy paths
  // -------------------------------------------------------------------------

  describe("Quad[] overload", () => {
    it("happy path: returns rdf:type triples when ABox individuals are present", async () => {
      const reasoner = await makeReadyReasoner();

      // Worker returns one rdf:type and one rdfs:subClassOf triple
      mockRealizationSequence([
        quad(alice, rdfType, A, defaultGraph()),
        quad(A, subClassOf, B, defaultGraph()),
      ]);

      const result = await reasoner.materialize([
        quad(alice, rdfType, A, defaultGraph()),
        quad(A, subClassOf, B, defaultGraph()),
      ]);

      // Default: only rdf:type returned; subClassOf filtered out
      expect(result).toHaveLength(1);
      expect(result[0].subject.value).toBe("http://example.org/alice");
      expect(result[0].predicate.value).toBe(
        "http://www.w3.org/1999/02/22-rdf-syntax-ns#type",
      );
      expect(result[0].object.value).toBe("http://example.org/A");
    });

    it("happy path: includeClassHierarchy:true returns both rdf:type and rdfs:subClassOf", async () => {
      const reasoner = await makeReadyReasoner();

      mockRealizationSequence([
        quad(alice, rdfType, A, defaultGraph()),
        quad(A, subClassOf, B, defaultGraph()),
        quad(A, equivalentClass, C, defaultGraph()),
      ]);

      const result = await reasoner.materialize(
        [quad(alice, rdfType, A, defaultGraph())],
        { includeClassHierarchy: true },
      );

      expect(result).toHaveLength(3);
      const predicates = result.map((q) => q.predicate.value);
      expect(predicates).toContain("http://www.w3.org/1999/02/22-rdf-syntax-ns#type");
      expect(predicates).toContain("http://www.w3.org/2000/01/rdf-schema#subClassOf");
      expect(predicates).toContain("http://www.w3.org/2002/07/owl#equivalentClass");
    });

    it("happy path: worker call sequence is [loadTripleBuffer, realization, getInferredTripleBuffer]", async () => {
      const reasoner = await makeReadyReasoner();

      mockRealizationSequence([quad(alice, rdfType, A, defaultGraph())]);

      await reasoner.materialize([quad(alice, rdfType, A, defaultGraph())]);

      const methods = mocks.workerPostMessage.mock.calls.map(
        (c) => (c[0] as { method: string }).method,
      );
      expect(methods).toEqual(["loadTripleBuffer", "realization", "getInferredTripleBuffer"]);
    });

    it("edge case: default options → rdfs:subClassOf filtered out", async () => {
      const reasoner = await makeReadyReasoner();

      mockRealizationSequence([
        quad(A, subClassOf, B, defaultGraph()),
        quad(A, subClassOf, C, defaultGraph()),
      ]);

      const result = await reasoner.materialize([quad(A, subClassOf, B, defaultGraph())]);

      // Both subClassOf triples filtered; result is empty
      expect(result).toHaveLength(0);
    });

    it("edge case: default options → owl:equivalentClass filtered out", async () => {
      const reasoner = await makeReadyReasoner();

      mockRealizationSequence([
        quad(A, equivalentClass, B, defaultGraph()),
      ]);

      const result = await reasoner.materialize([]);

      expect(result).toHaveLength(0);
    });

    it("edge case: TBox-only ontology (no rdf:type in result) → returns empty array, no throw", async () => {
      const reasoner = await makeReadyReasoner();

      // Only TBox triples returned; all filtered
      mockRealizationSequence([
        quad(A, subClassOf, B, defaultGraph()),
        quad(B, subClassOf, C, defaultGraph()),
      ]);

      const result = await reasoner.materialize([
        quad(A, subClassOf, B, defaultGraph()),
        quad(B, subClassOf, C, defaultGraph()),
      ]);

      expect(result).toEqual([]);
    });

    it("edge case: empty input → returns empty array", async () => {
      const reasoner = await makeReadyReasoner();

      mockRealizationSequence([]);

      const result = await reasoner.materialize([]);

      expect(result).toEqual([]);
    });

    it("error path: Worker error → materialize(quads) rejects", async () => {
      const reasoner = await makeReadyReasoner();

      mocks.workerPostMessage.mockImplementation((msg: unknown) => {
        const req = msg as { id: number; method: string };
        if (req.method === "loadTripleBuffer") {
          simulateWorkerMessage({ id: req.id, error: "binary decode error" });
        }
      });

      await expect(
        reasoner.materialize([quad(alice, rdfType, A, defaultGraph())]),
      ).rejects.toThrow("binary decode error");
    });
  });

  // -------------------------------------------------------------------------
  // Store overload
  // -------------------------------------------------------------------------

  describe("Store overload", () => {
    it("filtered quads written into inferredGraph named graph", async () => {
      const reasoner = await makeReadyReasoner();
      const store = new Store();
      store.addQuad(quad(alice, rdfType, A, defaultGraph()));
      store.addQuad(quad(A, subClassOf, B, defaultGraph()));

      // Worker returns rdf:type and rdfs:subClassOf triples
      mockRealizationSequence([
        quad(alice, rdfType, B, defaultGraph()),
        quad(A, subClassOf, B, defaultGraph()),
      ]);

      await reasoner.materialize(store);

      const inferredGraphNode = namedNode(INFERRED_GRAPH_IRI);
      const inferred = store.getQuads(null, null, null, inferredGraphNode);

      // Only the rdf:type triple is written (subClassOf filtered by default)
      expect(inferred).toHaveLength(1);
      expect(inferred[0].predicate.value).toBe(
        "http://www.w3.org/1999/02/22-rdf-syntax-ns#type",
      );
      expect(inferred[0].graph.value).toBe(INFERRED_GRAPH_IRI);
    });

    it("includeClassHierarchy:true writes all triples including subClassOf", async () => {
      const reasoner = await makeReadyReasoner();
      const store = new Store();

      mockRealizationSequence([
        quad(alice, rdfType, B, defaultGraph()),
        quad(A, subClassOf, B, defaultGraph()),
      ]);

      await reasoner.materialize(store, { includeClassHierarchy: true });

      const inferredGraphNode = namedNode(INFERRED_GRAPH_IRI);
      const inferred = store.getQuads(null, null, null, inferredGraphNode);
      expect(inferred).toHaveLength(2);
    });

    it("inferred graph cleared before each call — stale quads removed", async () => {
      const reasoner = await makeReadyReasoner();
      const store = new Store();

      const inferredNode = namedNode(INFERRED_GRAPH_IRI);
      const staleQuad = quad(
        namedNode("http://example.org/Stale"),
        rdfType,
        namedNode("http://example.org/OldClass"),
        inferredNode,
      );
      store.addQuad(staleQuad);

      mockRealizationSequence([quad(alice, rdfType, A, defaultGraph())]);

      await reasoner.materialize(store);

      const inferred = store.getQuads(null, null, null, inferredNode);
      expect(inferred).toHaveLength(1);
      expect(inferred[0].subject.value).toBe("http://example.org/alice");
    });

    it("custom inferredGraph option — writes to custom IRI, not default", async () => {
      const reasoner = await makeReadyReasoner();
      const store = new Store();

      mockRealizationSequence([quad(alice, rdfType, A, defaultGraph())]);

      const customIRI = "http://example.org/myMaterializeGraph";
      await reasoner.materialize(store, { inferredGraph: customIRI });

      const defaultInferred = store.getQuads(null, null, null, namedNode(INFERRED_GRAPH_IRI));
      expect(defaultInferred).toHaveLength(0);

      const customInferred = store.getQuads(null, null, null, namedNode(customIRI));
      expect(customInferred).toHaveLength(1);
      expect(customInferred[0].graph.value).toBe(customIRI);
    });

    it("uses realization worker pipeline (not classification)", async () => {
      const reasoner = await makeReadyReasoner();
      const store = new Store();

      mockRealizationSequence([]);

      await reasoner.materialize(store);

      const methods = mocks.workerPostMessage.mock.calls.map(
        (c) => (c[0] as { method: string }).method,
      );
      expect(methods).toEqual(["loadTripleBuffer", "realization", "getInferredTripleBuffer"]);
      expect(methods).not.toContain("classification");
    });

    it("error path: Worker error → materialize(store) rejects, inferred graph empty", async () => {
      const reasoner = await makeReadyReasoner();
      const store = new Store();

      // Pre-populate inferred graph (cleared before call)
      const inferredNode = namedNode(INFERRED_GRAPH_IRI);
      store.addQuad(quad(namedNode("http://example.org/Old"), rdfType, A, inferredNode));

      mocks.workerPostMessage.mockImplementation((msg: unknown) => {
        const req = msg as { id: number; method: string };
        if (req.method === "loadTripleBuffer") {
          simulateWorkerMessage({ id: req.id, error: "binary decode error" });
        }
      });

      await expect(reasoner.materialize(store)).rejects.toThrow("binary decode error");

      const inferred = store.getQuads(null, null, null, inferredNode);
      expect(inferred).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Concurrency — queue serialization
  // -------------------------------------------------------------------------

  describe("concurrency", () => {
    it("two materialize(store) calls are serialized, both complete", async () => {
      const reasoner = await makeReadyReasoner();
      const store1 = new Store([quad(alice, rdfType, A, defaultGraph())]);
      const store2 = new Store([quad(namedNode("http://example.org/bob"), rdfType, B, defaultGraph())]);

      let callCount = 0;
      mocks.workerPostMessage.mockImplementation((msg: unknown) => {
        const req = msg as { id: number; method: string };
        if (req.method === "loadTripleBuffer") {
          simulateWorkerMessage({ id: req.id, result: true });
        } else if (req.method === "realization") {
          simulateWorkerMessage({ id: req.id, result: true });
        } else if (req.method === "getInferredTripleBuffer") {
          callCount++;
          const buf = callCount === 1
            ? buildCombinedBuffer([quad(alice, rdfType, B, defaultGraph())])
            : buildCombinedBuffer([quad(namedNode("http://example.org/bob"), rdfType, C, defaultGraph())]);
          simulateWorkerMessage({ id: req.id, result: buf });
        }
      });

      await Promise.all([reasoner.materialize(store1), reasoner.materialize(store2)]);

      const g = namedNode(INFERRED_GRAPH_IRI);
      expect(store1.getQuads(null, null, null, g)).toHaveLength(1);
      expect(store2.getQuads(null, null, null, g)).toHaveLength(1);
    });
  });
});
