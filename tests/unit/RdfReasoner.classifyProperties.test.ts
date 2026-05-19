/**
 * Unit tests for RdfReasoner.classifyProperties() — Quad[] and Store overloads.
 *
 * Follows the same vi.hoisted / vi.stubGlobal("Worker") scaffolding used in
 * RdfReasoner.test.ts and RdfReasoner.materialize.test.ts.
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

const { namedNode, quad, defaultGraph } = DataFactory;

const subPropertyOf = namedNode("http://www.w3.org/2000/01/rdf-schema#subPropertyOf");
const P = namedNode("http://example.org/P");
const Q = namedNode("http://example.org/Q");
const R = namedNode("http://example.org/R");

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
 * Set up mock responses for the classifyProperties pipeline.
 * Returns the specified quads from getPropertyTripleBuffer.
 */
function mockPropertySequence(inferredQuads: Quad[]) {
  const buf = buildCombinedBuffer(inferredQuads);
  mocks.workerPostMessage.mockImplementation((msg: unknown) => {
    const req = msg as { id: number; method: string };
    if (req.method === "loadTripleBuffer") {
      simulateWorkerMessage({ id: req.id, result: true });
    } else if (req.method === "classification") {
      simulateWorkerMessage({ id: req.id, result: true });
    } else if (req.method === "getPropertyTripleBuffer") {
      simulateWorkerMessage({ id: req.id, result: buf });
    }
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RdfReasoner.classifyProperties()", () => {
  beforeEach(() => {
    mocks.workerPostMessage.mockClear();
    mocks.WorkerMock.mockClear();
    mocks.clearListeners();
  });

  // -------------------------------------------------------------------------
  // Quad[] overload — happy paths
  // -------------------------------------------------------------------------

  describe("Quad[] overload", () => {
    it("happy path: worker call sequence is [loadTripleBuffer, classification, getPropertyTripleBuffer]", async () => {
      const reasoner = await makeReadyReasoner();

      mockPropertySequence([quad(P, subPropertyOf, R, defaultGraph())]);

      await reasoner.classifyProperties([
        quad(P, subPropertyOf, Q, defaultGraph()),
        quad(Q, subPropertyOf, R, defaultGraph()),
      ]);

      const methods = mocks.workerPostMessage.mock.calls.map(
        (c) => (c[0] as { method: string }).method,
      );
      expect(methods).toEqual(["loadTripleBuffer", "classification", "getPropertyTripleBuffer"]);
    });

    it("happy path: mock returns rdfs:subPropertyOf quads; they are returned", async () => {
      const reasoner = await makeReadyReasoner();

      mockPropertySequence([quad(P, subPropertyOf, R, defaultGraph())]);

      const result = await reasoner.classifyProperties([
        quad(P, subPropertyOf, Q, defaultGraph()),
        quad(Q, subPropertyOf, R, defaultGraph()),
      ]);

      expect(result).toHaveLength(1);
      expect(result[0].subject.value).toBe("http://example.org/P");
      expect(result[0].predicate.value).toBe("http://www.w3.org/2000/01/rdf-schema#subPropertyOf");
      expect(result[0].object.value).toBe("http://example.org/R");
      expect(result[0].graph.termType).toBe("DefaultGraph");
    });

    it("edge case: ontology with no user-defined properties → empty result, no throw", async () => {
      const reasoner = await makeReadyReasoner();

      mockPropertySequence([]);

      const result = await reasoner.classifyProperties([]);
      expect(result).toEqual([]);
    });

    it("edge case: worker error → promise rejects correctly", async () => {
      const reasoner = await makeReadyReasoner();

      mocks.workerPostMessage.mockImplementation((msg: unknown) => {
        const req = msg as { id: number; method: string };
        if (req.method === "loadTripleBuffer") {
          simulateWorkerMessage({ id: req.id, error: "binary decode error" });
        }
      });

      await expect(
        reasoner.classifyProperties([quad(P, subPropertyOf, Q, defaultGraph())]),
      ).rejects.toThrow("binary decode error");
    });
  });

  // -------------------------------------------------------------------------
  // Store overload
  // -------------------------------------------------------------------------

  describe("Store overload", () => {
    it("happy path: Store overload writes quads to inferredGraph named graph", async () => {
      const reasoner = await makeReadyReasoner();
      const store = new Store();
      store.addQuad(quad(P, subPropertyOf, Q, defaultGraph()));
      store.addQuad(quad(Q, subPropertyOf, R, defaultGraph()));

      mockPropertySequence([quad(P, subPropertyOf, R, defaultGraph())]);

      await reasoner.classifyProperties(store);

      const inferredGraphNode = namedNode(INFERRED_GRAPH_IRI);
      const inferred = store.getQuads(null, null, null, inferredGraphNode);

      expect(inferred).toHaveLength(1);
      expect(inferred[0].subject.value).toBe("http://example.org/P");
      expect(inferred[0].predicate.value).toBe("http://www.w3.org/2000/01/rdf-schema#subPropertyOf");
      expect(inferred[0].object.value).toBe("http://example.org/R");
      expect(inferred[0].graph.value).toBe(INFERRED_GRAPH_IRI);
    });

    it("inferred graph cleared before each call — stale quads removed", async () => {
      const reasoner = await makeReadyReasoner();
      const store = new Store();

      const inferredNode = namedNode(INFERRED_GRAPH_IRI);
      store.addQuad(quad(namedNode("http://example.org/Stale"), subPropertyOf, namedNode("http://example.org/Old"), inferredNode));

      mockPropertySequence([quad(P, subPropertyOf, R, defaultGraph())]);

      await reasoner.classifyProperties(store);

      const inferred = store.getQuads(null, null, null, inferredNode);
      expect(inferred).toHaveLength(1);
      expect(inferred[0].subject.value).toBe("http://example.org/P");
    });

    it("custom inferredGraph option — writes to custom IRI, not default", async () => {
      const reasoner = await makeReadyReasoner();
      const store = new Store();

      mockPropertySequence([quad(P, subPropertyOf, R, defaultGraph())]);

      const customIRI = "http://example.org/myPropGraph";
      await reasoner.classifyProperties(store, { inferredGraph: customIRI });

      const defaultInferred = store.getQuads(null, null, null, namedNode(INFERRED_GRAPH_IRI));
      expect(defaultInferred).toHaveLength(0);

      const customInferred = store.getQuads(null, null, null, namedNode(customIRI));
      expect(customInferred).toHaveLength(1);
      expect(customInferred[0].graph.value).toBe(customIRI);
    });

    it("uses classification pipeline (not realization)", async () => {
      const reasoner = await makeReadyReasoner();
      const store = new Store();

      mockPropertySequence([]);

      await reasoner.classifyProperties(store);

      const methods = mocks.workerPostMessage.mock.calls.map(
        (c) => (c[0] as { method: string }).method,
      );
      expect(methods).toEqual(["loadTripleBuffer", "classification", "getPropertyTripleBuffer"]);
      expect(methods).not.toContain("realization");
      expect(methods).not.toContain("getInferredTripleBuffer");
    });

    it("error path: Worker error → classifyProperties(store) rejects, inferred graph empty", async () => {
      const reasoner = await makeReadyReasoner();
      const store = new Store();

      const inferredNode = namedNode(INFERRED_GRAPH_IRI);
      store.addQuad(quad(namedNode("http://example.org/Old"), subPropertyOf, P, inferredNode));

      mocks.workerPostMessage.mockImplementation((msg: unknown) => {
        const req = msg as { id: number; method: string };
        if (req.method === "loadTripleBuffer") {
          simulateWorkerMessage({ id: req.id, error: "binary decode error" });
        }
      });

      await expect(reasoner.classifyProperties(store)).rejects.toThrow("binary decode error");

      const inferred = store.getQuads(null, null, null, inferredNode);
      expect(inferred).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Concurrency — queue serialization
  // -------------------------------------------------------------------------

  describe("concurrency", () => {
    it("concurrent calls serialize correctly (queue pattern)", async () => {
      const reasoner = await makeReadyReasoner();

      let callCount = 0;
      mocks.workerPostMessage.mockImplementation((msg: unknown) => {
        const req = msg as { id: number; method: string };
        if (req.method === "loadTripleBuffer") {
          simulateWorkerMessage({ id: req.id, result: true });
        } else if (req.method === "classification") {
          simulateWorkerMessage({ id: req.id, result: true });
        } else if (req.method === "getPropertyTripleBuffer") {
          callCount++;
          const buf = callCount === 1
            ? buildCombinedBuffer([quad(P, subPropertyOf, R, defaultGraph())])
            : buildCombinedBuffer([quad(Q, subPropertyOf, R, defaultGraph())]);
          simulateWorkerMessage({ id: req.id, result: buf });
        }
      });

      const [result1, result2] = await Promise.all([
        reasoner.classifyProperties([quad(P, subPropertyOf, Q, defaultGraph())]),
        reasoner.classifyProperties([quad(Q, subPropertyOf, R, defaultGraph())]),
      ]);

      expect(result1).toHaveLength(1);
      expect(result1[0].subject.value).toBe("http://example.org/P");
      expect(result2).toHaveLength(1);
      expect(result2[0].subject.value).toBe("http://example.org/Q");
    });
  });
});
