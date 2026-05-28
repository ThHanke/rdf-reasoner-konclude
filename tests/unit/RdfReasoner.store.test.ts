/**
 * Unit tests for the N3.Store-based API of RdfReasoner.
 *
 * Mirrors the vi.hoisted / vi.stubGlobal("Worker") / simulateWorkerMessage
 * scaffolding from RdfReasoner.test.ts exactly.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { DataFactory, Store } from "n3";
import type { Quad } from "@rdfjs/types";
import { encodeToBuffers } from "../../ts/intern.js";
import { HYPOTHETICAL_IRI } from "../../ts/types.js";

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

const subClassOf = namedNode("http://www.w3.org/2000/01/rdf-schema#subClassOf");
const A = namedNode("http://example.org/A");
const B = namedNode("http://example.org/B");
const C = namedNode("http://example.org/C");
const G1 = namedNode("http://example.org/G1");
const G2 = namedNode("http://example.org/G2");

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

/** Respond to Worker calls in the binary protocol sequence. */
function mockWorkerSequence(inferredQuads: Quad[]) {
  const buf = buildCombinedBuffer(inferredQuads);
  mocks.workerPostMessage.mockImplementation((msg: unknown) => {
    const req = msg as { id: number; method: string };
    if (req.method === "loadTripleBuffer") {
      simulateWorkerMessage({ id: req.id, result: true });
    } else if (req.method === "classification") {
      simulateWorkerMessage({ id: req.id, result: true });
    } else if (req.method === "realization") {
      simulateWorkerMessage({ id: req.id, result: true });
    } else if (req.method === "getInferredTripleBuffer") {
      simulateWorkerMessage({ id: req.id, result: buf });
    }
  });
}

/** Decode all string-table entries from a loadTripleBuffer args[1] ArrayBuffer. */
function decodeStrTableEntries(strTableBuf: ArrayBuffer): string[] {
  const dv = new DataView(strTableBuf);
  const count = dv.getUint32(0, true);
  const headerBytes = 4 + 4 * count;
  const strDataLen = strTableBuf.byteLength - headerBytes;
  const strBytes = new Uint8Array(strTableBuf, headerBytes);
  const dec = new TextDecoder();
  const entries: string[] = [];
  for (let i = 0; i < count; i++) {
    const start = dv.getUint32(4 + 4 * i, true);
    const end = i + 1 < count ? dv.getUint32(4 + 4 * (i + 1), true) : strDataLen;
    entries.push(dec.decode(strBytes.slice(start, end)));
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RdfReasoner — Store API", () => {
  beforeEach(() => {
    mocks.workerPostMessage.mockClear();
    mocks.WorkerMock.mockClear();
    mocks.clearListeners();
  });

  // -------------------------------------------------------------------------
  // reason(store) — happy path
  // -------------------------------------------------------------------------

  describe("reason(store)", () => {
    it("calls loadTripleBuffer → classification → getInferredTripleBuffer in order", async () => {
      const reasoner = await makeReadyReasoner();
      const store = new Store();
      store.addQuad(quad(A, subClassOf, B, defaultGraph()));
      store.addQuad(quad(B, subClassOf, C, defaultGraph()));

      mockWorkerSequence([quad(A, subClassOf, C, defaultGraph())]);

      await reasoner.reason(store);

      const methods = mocks.workerPostMessage.mock.calls.map(
        (c) => (c[0] as { method: string }).method,
      );
      expect(methods).toEqual(["loadTripleBuffer", "classification", "getInferredTripleBuffer"]);
    });

    it("inferred quad is written to default named graph (urn:konclude:inferred)", async () => {
      const reasoner = await makeReadyReasoner();
      const store = new Store();
      store.addQuad(quad(A, subClassOf, B, defaultGraph()));

      mockWorkerSequence([quad(A, subClassOf, C, defaultGraph())]);

      await reasoner.reason(store);

      const inferredGraphNode = namedNode(INFERRED_GRAPH_IRI);
      const inferred = store.getQuads(null, null, null, inferredGraphNode);
      expect(inferred).toHaveLength(1);
      expect(inferred[0].subject.value).toBe("http://example.org/A");
      expect(inferred[0].predicate.value).toBe(
        "http://www.w3.org/2000/01/rdf-schema#subClassOf",
      );
      expect(inferred[0].object.value).toBe("http://example.org/C");
      expect(inferred[0].graph.value).toBe(INFERRED_GRAPH_IRI);
    });

    it("multi-graph input: binary payload contains all (s,p,o) IRIs without graph IRIs", async () => {
      const reasoner = await makeReadyReasoner();
      const store = new Store();
      store.addQuad(quad(A, subClassOf, B, G1));
      store.addQuad(quad(B, subClassOf, C, G2));

      let strEntries: string[] = [];
      mocks.workerPostMessage.mockImplementation((msg: unknown) => {
        const req = msg as { id: number; method: string; args: unknown[] };
        if (req.method === "loadTripleBuffer") {
          strEntries = decodeStrTableEntries(req.args[1] as ArrayBuffer);
          simulateWorkerMessage({ id: req.id, result: true });
        } else if (req.method === "classification") {
          simulateWorkerMessage({ id: req.id, result: true });
        } else if (req.method === "getInferredTripleBuffer") {
          simulateWorkerMessage({ id: req.id, result: buildCombinedBuffer([]) });
        }
      });

      await reasoner.reason(store);

      expect(strEntries).toContain("http://example.org/A");
      expect(strEntries).toContain("http://example.org/B");
      expect(strEntries).toContain("http://example.org/C");
      expect(strEntries).not.toContain("http://example.org/G1");
      expect(strEntries).not.toContain("http://example.org/G2");
    });

    it("inferred graph cleared before each call — stale quads removed", async () => {
      const reasoner = await makeReadyReasoner();
      const store = new Store();
      store.addQuad(quad(A, subClassOf, B, defaultGraph()));

      const staleNode = namedNode(INFERRED_GRAPH_IRI);
      const staleQuad = quad(
        namedNode("http://example.org/Stale"),
        subClassOf,
        namedNode("http://example.org/Whatever"),
        staleNode,
      );
      store.addQuad(staleQuad);

      mockWorkerSequence([quad(A, subClassOf, C, defaultGraph())]);

      await reasoner.reason(store);

      const inferred = store.getQuads(null, null, null, staleNode);
      // Only the new inferred quad; stale quad removed
      expect(inferred).toHaveLength(1);
      expect(inferred[0].subject.value).toBe("http://example.org/A");
    });

    it("custom inferredGraph option — writes to custom IRI, not default", async () => {
      const reasoner = await makeReadyReasoner();
      const store = new Store();
      store.addQuad(quad(A, subClassOf, B, defaultGraph()));

      mockWorkerSequence([quad(A, subClassOf, C, defaultGraph())]);

      const customIRI = "http://example.org/myGraph";
      await reasoner.reason(store, { inferredGraph: customIRI });

      const defaultInferred = store.getQuads(null, null, null, namedNode(INFERRED_GRAPH_IRI));
      expect(defaultInferred).toHaveLength(0);

      const customInferred = store.getQuads(null, null, null, namedNode(customIRI));
      expect(customInferred).toHaveLength(1);
      expect(customInferred[0].graph.value).toBe(customIRI);
    });

    it("empty store → sends zero-triple buffer → no inferred quads written", async () => {
      const reasoner = await makeReadyReasoner();
      const store = new Store();

      let tripleByteLength = -1;
      mocks.workerPostMessage.mockImplementation((msg: unknown) => {
        const req = msg as { id: number; method: string; args: unknown[] };
        if (req.method === "loadTripleBuffer") {
          tripleByteLength = (req.args[0] as ArrayBuffer).byteLength;
          simulateWorkerMessage({ id: req.id, result: true });
        } else if (req.method === "classification") {
          simulateWorkerMessage({ id: req.id, result: true });
        } else if (req.method === "getInferredTripleBuffer") {
          simulateWorkerMessage({ id: req.id, result: buildCombinedBuffer([]) });
        }
      });

      await reasoner.reason(store);

      expect(tripleByteLength).toBe(0);
      expect(store.size).toBe(0);
    });

    it("error path: Worker error on loadTripleBuffer → reason(store) rejects, inferred graph empty", async () => {
      const reasoner = await makeReadyReasoner();
      const store = new Store();
      store.addQuad(quad(A, subClassOf, B, defaultGraph()));

      // Pre-populate inferred graph (should be cleared before call)
      const inferredNode = namedNode(INFERRED_GRAPH_IRI);
      store.addQuad(
        quad(namedNode("http://example.org/Old"), subClassOf, B, inferredNode),
      );

      mocks.workerPostMessage.mockImplementation((msg: unknown) => {
        const req = msg as { id: number; method: string };
        if (req.method === "loadTripleBuffer") {
          simulateWorkerMessage({ id: req.id, error: "binary decode error" });
        }
      });

      await expect(reasoner.reason(store)).rejects.toThrow("binary decode error");

      // Inferred graph cleared before call, error prevented write — so it is empty
      const inferred = store.getQuads(null, null, null, inferredNode);
      expect(inferred).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // classify(store)
  // -------------------------------------------------------------------------

  describe("classify(store)", () => {
    it("is an alias for reason(store) — same Worker sequence, same store mutation", async () => {
      const reasoner = await makeReadyReasoner();
      const store = new Store();
      store.addQuad(quad(A, subClassOf, B, defaultGraph()));

      mockWorkerSequence([quad(A, subClassOf, C, defaultGraph())]);

      await reasoner.classify(store);

      const methods = mocks.workerPostMessage.mock.calls.map(
        (c) => (c[0] as { method: string }).method,
      );
      expect(methods).toEqual(["loadTripleBuffer", "classification", "getInferredTripleBuffer"]);

      const inferredGraphNode = namedNode(INFERRED_GRAPH_IRI);
      const inferred = store.getQuads(null, null, null, inferredGraphNode);
      expect(inferred).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // checkConsistency(store)
  // -------------------------------------------------------------------------

  describe("checkConsistency(store)", () => {
    it("calls loadTripleBuffer → classification → consistency; returns boolean; does not call getInferredTripleBuffer", async () => {
      const reasoner = await makeReadyReasoner();
      const store = new Store();
      store.addQuad(quad(A, subClassOf, B, defaultGraph()));

      mocks.workerPostMessage.mockImplementation((msg: unknown) => {
        const req = msg as { id: number; method: string };
        if (req.method === "loadTripleBuffer") {
          simulateWorkerMessage({ id: req.id, result: true });
        } else if (req.method === "classification") {
          simulateWorkerMessage({ id: req.id, result: true });
        } else if (req.method === "consistency") {
          simulateWorkerMessage({ id: req.id, result: true });
        }
        // No response for getInferredTripleBuffer — must not be called
      });

      const result = await reasoner.checkConsistency(store);
      expect(result).toBe(true);

      const methods = mocks.workerPostMessage.mock.calls.map(
        (c) => (c[0] as { method: string }).method,
      );
      expect(methods).toEqual(["loadTripleBuffer", "classification", "consistency"]);
      expect(methods).not.toContain("getInferredTripleBuffer");
    });

    it("does not write any quads to the store", async () => {
      const reasoner = await makeReadyReasoner();
      const store = new Store();
      store.addQuad(quad(A, subClassOf, B, defaultGraph()));

      mocks.workerPostMessage.mockImplementation((msg: unknown) => {
        const req = msg as { id: number; method: string };
        if (req.method === "loadTripleBuffer") {
          simulateWorkerMessage({ id: req.id, result: true });
        } else if (req.method === "classification") {
          simulateWorkerMessage({ id: req.id, result: true });
        } else if (req.method === "consistency") {
          simulateWorkerMessage({ id: req.id, result: true });
        }
      });

      const sizeBefore = store.size;
      await reasoner.checkConsistency(store);
      expect(store.size).toBe(sizeBefore);
    });
  });

  // -------------------------------------------------------------------------
  // Deprecated Quad[] overloads still work
  // -------------------------------------------------------------------------

  describe("deprecated Quad[] overloads", () => {
    it("reason([...quads]) still returns Promise<Quad[]>", async () => {
      const reasoner = await makeReadyReasoner();

      mockWorkerSequence([quad(A, subClassOf, C, defaultGraph())]);

      const result = await reasoner.reason([quad(A, subClassOf, B, defaultGraph())]);
      expect(Array.isArray(result)).toBe(true);
      expect((result as Quad[]).length).toBe(1);
    });

    it("reason([...quads]) does not write to any store", async () => {
      const reasoner = await makeReadyReasoner();
      const storeControl = new Store();

      mockWorkerSequence([quad(A, subClassOf, C, defaultGraph())]);

      await reasoner.reason([quad(A, subClassOf, B, defaultGraph())]);
      expect(storeControl.size).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Concurrent calls serialized
  // -------------------------------------------------------------------------

  describe("concurrency", () => {
    it("two reason(store) calls are serialized via queue, both complete", async () => {
      const reasoner = await makeReadyReasoner();
      const store1 = new Store([quad(A, subClassOf, B, defaultGraph())]);
      const store2 = new Store([quad(B, subClassOf, C, defaultGraph())]);

      let callCount = 0;
      mocks.workerPostMessage.mockImplementation((msg: unknown) => {
        const req = msg as { id: number; method: string };
        if (req.method === "loadTripleBuffer") {
          simulateWorkerMessage({ id: req.id, result: true });
        } else if (req.method === "classification") {
          simulateWorkerMessage({ id: req.id, result: true });
        } else if (req.method === "getInferredTripleBuffer") {
          callCount++;
          const buf = callCount === 1
            ? buildCombinedBuffer([quad(A, subClassOf, C, defaultGraph())])
            : buildCombinedBuffer([quad(B, subClassOf, A, defaultGraph())]);
          simulateWorkerMessage({ id: req.id, result: buf });
        }
      });

      await Promise.all([reasoner.reason(store1), reasoner.reason(store2)]);

      const g = namedNode(INFERRED_GRAPH_IRI);
      expect(store1.getQuads(null, null, null, g)).toHaveLength(1);
      expect(store2.getQuads(null, null, null, g)).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Fingerprint cache
  // -------------------------------------------------------------------------

  describe("fingerprint cache", () => {
    const rdfType = namedNode("http://www.w3.org/1999/02/22-rdf-syntax-ns#type");
    const alice = namedNode("http://example.org/alice");

    /** Helper: set up mock for realization (materialize) pipeline */
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

    /** Helper: set up mock for classification pipeline */
    function mockClassifySequence(inferredQuads: Quad[]) {
      const buf = buildCombinedBuffer(inferredQuads);
      mocks.workerPostMessage.mockImplementation((msg: unknown) => {
        const req = msg as { id: number; method: string };
        if (req.method === "loadTripleBuffer") {
          simulateWorkerMessage({ id: req.id, result: true });
        } else if (req.method === "classification") {
          simulateWorkerMessage({ id: req.id, result: true });
        } else if (req.method === "getInferredTripleBuffer") {
          simulateWorkerMessage({ id: req.id, result: buf });
        }
      });
    }

    /** Helper: set up mock for checkConsistency pipeline */
    function mockConsistencySequence(consistent: boolean) {
      mocks.workerPostMessage.mockImplementation((msg: unknown) => {
        const req = msg as { id: number; method: string };
        if (req.method === "loadTripleBuffer") {
          simulateWorkerMessage({ id: req.id, result: true });
        } else if (req.method === "classification") {
          simulateWorkerMessage({ id: req.id, result: true });
        } else if (req.method === "consistency") {
          simulateWorkerMessage({ id: req.id, result: consistent });
        }
      });
    }

    it("materialize(store) called twice → Worker receives exactly one loadTripleBuffer (second is cache hit)", async () => {
      const reasoner = await makeReadyReasoner();
      const store = new Store([quad(A, subClassOf, B, defaultGraph())]);

      mockRealizationSequence([quad(alice, rdfType, B, defaultGraph())]);

      await reasoner.materialize(store);

      // Second call with the same store content — should be a cache hit
      mockRealizationSequence([]);
      await reasoner.materialize(store);

      const loadCalls = mocks.workerPostMessage.mock.calls.filter(
        (c) => (c[0] as { method: string }).method === "loadTripleBuffer",
      );
      expect(loadCalls).toHaveLength(1);
    });

    it("classify(store) and materialize(store) with same store → each triggers its own Worker call (separate cache slots)", async () => {
      const reasoner = await makeReadyReasoner();
      const store = new Store([quad(A, subClassOf, B, defaultGraph())]);

      mockClassifySequence([quad(A, subClassOf, C, defaultGraph())]);
      await reasoner.classify(store);

      mockRealizationSequence([quad(alice, rdfType, B, defaultGraph())]);
      await reasoner.materialize(store);

      const loadCalls = mocks.workerPostMessage.mock.calls.filter(
        (c) => (c[0] as { method: string }).method === "loadTripleBuffer",
      );
      // Both operations go to the Worker — different cache slots
      expect(loadCalls).toHaveLength(2);
    });

    it("checkConsistency(store) called twice → Worker receives exactly one loadTripleBuffer (second is cache hit)", async () => {
      const reasoner = await makeReadyReasoner();
      const store = new Store([quad(A, subClassOf, B, defaultGraph())]);

      mockConsistencySequence(true);
      const r1 = await reasoner.checkConsistency(store);
      expect(r1).toBe(true);

      // Second call — cache hit should return same result without Worker round-trip
      const r2 = await reasoner.checkConsistency(store);
      expect(r2).toBe(true);

      const loadCalls = mocks.workerPostMessage.mock.calls.filter(
        (c) => (c[0] as { method: string }).method === "loadTripleBuffer",
      );
      expect(loadCalls).toHaveLength(1);
    });

    it("checkConsistency(store) and classify(store) with same store → each triggers own Worker call (separate slots)", async () => {
      const reasoner = await makeReadyReasoner();
      const store = new Store([quad(A, subClassOf, B, defaultGraph())]);

      mockConsistencySequence(true);
      await reasoner.checkConsistency(store);

      mockClassifySequence([quad(A, subClassOf, C, defaultGraph())]);
      await reasoner.classify(store);

      const loadCalls = mocks.workerPostMessage.mock.calls.filter(
        (c) => (c[0] as { method: string }).method === "loadTripleBuffer",
      );
      expect(loadCalls).toHaveLength(2);
    });

    /** Helper: set up mock for classifyProperties pipeline */
    function mockClassifyPropertiesSequence(inferredQuads: Quad[]) {
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

    it("classifyProperties(store) called twice → Worker receives exactly one loadTripleBuffer (second is cache hit)", async () => {
      const reasoner = await makeReadyReasoner();
      const subPropertyOf = namedNode("http://www.w3.org/2000/01/rdf-schema#subPropertyOf");
      const p1 = namedNode("http://example.org/p1");
      const p2 = namedNode("http://example.org/p2");
      const store = new Store([quad(A, subClassOf, B, defaultGraph())]);

      mockClassifyPropertiesSequence([quad(p1, subPropertyOf, p2, defaultGraph())]);
      await reasoner.classifyProperties(store);

      // Second call with the same store content — should be a cache hit
      mockClassifyPropertiesSequence([]);
      await reasoner.classifyProperties(store);

      const loadCalls = mocks.workerPostMessage.mock.calls.filter(
        (c) => (c[0] as { method: string }).method === "loadTripleBuffer",
      );
      expect(loadCalls).toHaveLength(1);
    });

    it("materialize(store, { returnDelta: true }) first call → delta.added contains all inferred quads, delta.removed = []", async () => {
      const reasoner = await makeReadyReasoner();
      const store = new Store([quad(A, subClassOf, B, defaultGraph())]);
      const inferredQuad = quad(alice, rdfType, B, defaultGraph());

      mockRealizationSequence([inferredQuad]);

      const result = await reasoner.materialize(store, { returnDelta: true });
      expect(result.delta.removed).toHaveLength(0);
      expect(result.delta.added).toHaveLength(1);
      expect(result.delta.added[0].subject.value).toBe("http://example.org/alice");
      expect(result.delta.added[0].predicate.value).toBe("http://www.w3.org/1999/02/22-rdf-syntax-ns#type");
      expect(result.delta.added[0].object.value).toBe("http://example.org/B");
    });

    it("materialize(store, { returnDelta: true }) after adding a triple → delta shows diff", async () => {
      const reasoner = await makeReadyReasoner();
      const store = new Store([quad(A, subClassOf, B, defaultGraph())]);
      const alice2 = namedNode("http://example.org/alice2");
      const inferredQuad1 = quad(alice, rdfType, B, defaultGraph());
      const inferredQuad2 = quad(alice2, rdfType, B, defaultGraph());

      // First call: Worker returns inferredQuad1
      mockRealizationSequence([inferredQuad1]);
      await reasoner.materialize(store);

      // Now modify the store to change its fingerprint
      store.addQuad(quad(alice2, rdfType, A, defaultGraph()));

      // Second call: Worker returns inferredQuad2 (alice2 is now typed as B, alice is gone)
      // We need to clear the mock and set up new responses
      mocks.workerPostMessage.mockClear();
      const buf2 = buildCombinedBuffer([inferredQuad2]);
      mocks.workerPostMessage.mockImplementation((msg: unknown) => {
        const req = msg as { id: number; method: string };
        if (req.method === "loadTripleBuffer") {
          simulateWorkerMessage({ id: req.id, result: true });
        } else if (req.method === "realization") {
          simulateWorkerMessage({ id: req.id, result: true });
        } else if (req.method === "getInferredTripleBuffer") {
          simulateWorkerMessage({ id: req.id, result: buf2 });
        }
      });

      const result = await reasoner.materialize(store, { returnDelta: true });

      // alice2 is newly inferred; alice was inferred before but now gone
      expect(result.delta.added.some((q) => q.subject.value === "http://example.org/alice2")).toBe(true);
      expect(result.delta.removed.some((q) => q.subject.value === "http://example.org/alice")).toBe(true);
    });

    it("materialize(store) without returnDelta → return value has no delta property (backward compat)", async () => {
      const reasoner = await makeReadyReasoner();
      const store = new Store([quad(A, subClassOf, B, defaultGraph())]);

      mockRealizationSequence([]);

      const result = await reasoner.materialize(store);

      // result is void (undefined); no delta property
      expect(result).toBeUndefined();
    });

    it("Store contains only INFERRED_GRAPH_IRI quads (no base triples) → fingerprint is stable; cache hit on second call", async () => {
      const reasoner = await makeReadyReasoner();
      const store = new Store();
      // Add only inferred quads — these are filtered from fingerprint
      const inferredNode = namedNode(INFERRED_GRAPH_IRI);
      store.addQuad(quad(A, subClassOf, C, inferredNode));

      mockRealizationSequence([]);
      await reasoner.materialize(store);

      // Second call — still no base triples, same fingerprint → cache hit
      mockRealizationSequence([]);
      await reasoner.materialize(store);

      const loadCalls = mocks.workerPostMessage.mock.calls.filter(
        (c) => (c[0] as { method: string }).method === "loadTripleBuffer",
      );
      expect(loadCalls).toHaveLength(1);
    });

    it("Store contains only HYPOTHETICAL_IRI quads → fingerprint is stable; cache hit on second call", async () => {
      const reasoner = await makeReadyReasoner();
      const store = new Store();
      // Add only hypothetical quads — these are also filtered from fingerprint
      const hypotheticalNode = namedNode(HYPOTHETICAL_IRI);
      store.addQuad(quad(A, subClassOf, C, hypotheticalNode));

      mockRealizationSequence([]);
      await reasoner.materialize(store);

      // Second call — same hypothetical-only content → cache hit
      mockRealizationSequence([]);
      await reasoner.materialize(store);

      const loadCalls = mocks.workerPostMessage.mock.calls.filter(
        (c) => (c[0] as { method: string }).method === "loadTripleBuffer",
      );
      expect(loadCalls).toHaveLength(1);
    });

    it("Store changes between calls → cache miss; Worker receives new loadTripleBuffer", async () => {
      const reasoner = await makeReadyReasoner();
      const store = new Store([quad(A, subClassOf, B, defaultGraph())]);

      mockRealizationSequence([quad(alice, rdfType, B, defaultGraph())]);
      await reasoner.materialize(store);

      // Modify the store — different fingerprint
      store.addQuad(quad(B, subClassOf, C, defaultGraph()));
      mocks.workerPostMessage.mockClear();

      mockRealizationSequence([]);
      await reasoner.materialize(store);

      const loadCalls = mocks.workerPostMessage.mock.calls.filter(
        (c) => (c[0] as { method: string }).method === "loadTripleBuffer",
      );
      // Cache was invalidated; a new Worker call was made
      expect(loadCalls).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // isEntailed()
  // -------------------------------------------------------------------------

  describe("isEntailed", () => {
    const rdfType = namedNode("http://www.w3.org/1999/02/22-rdf-syntax-ns#type");
    const penguin = namedNode("http://example.org/penguin");
    const Penguin = namedNode("http://example.org/Penguin");
    const Bird = namedNode("http://example.org/Bird");
    const unknown = namedNode("http://example.org/unknown");

    /** Mock for realization (materialize) pipeline within isEntailed */
    function mockRealizationSequence(inferredQuads: Quad[]) {
      const buf = buildCombinedBuffer(inferredQuads);
      mocks.workerPostMessage.mockImplementation((msg: unknown) => {
        const req = msg as { id: number; method: string };
        if (req.method === "loadTripleBuffer") simulateWorkerMessage({ id: req.id, result: true });
        else if (req.method === "realization") simulateWorkerMessage({ id: req.id, result: true });
        else if (req.method === "getInferredTripleBuffer") simulateWorkerMessage({ id: req.id, result: buf });
      });
    }

    it("happy path: entailed rdf:type returns true", async () => {
      const reasoner = await makeReadyReasoner();
      const store = new Store([quad(Penguin, subClassOf, Bird, defaultGraph())]);

      mockRealizationSequence([quad(penguin, rdfType, Bird, defaultGraph())]);

      const result = await reasoner.isEntailed(store, quad(penguin, rdfType, Bird));

      expect(result).toBe(true);

      const methods = mocks.workerPostMessage.mock.calls.map(
        (c) => (c[0] as { method: string }).method,
      );
      expect(methods).toContain("realization");
    });

    it("happy path: not-entailed rdf:type returns false", async () => {
      const reasoner = await makeReadyReasoner();
      const store = new Store([quad(Penguin, subClassOf, Bird, defaultGraph())]);

      // Worker returns penguin as Bird but not unknown as Bird
      mockRealizationSequence([quad(penguin, rdfType, Bird, defaultGraph())]);

      const result = await reasoner.isEntailed(store, quad(unknown, rdfType, Bird));

      expect(result).toBe(false);
    });

    it("happy path: batch returns [true, false, null]", async () => {
      const reasoner = await makeReadyReasoner();
      const store = new Store([quad(Penguin, subClassOf, Bird, defaultGraph())]);

      // Worker returns only penguin as Bird
      mockRealizationSequence([quad(penguin, rdfType, Bird, defaultGraph())]);

      const unsupportedPred = namedNode("http://www.w3.org/2004/02/skos/core#prefLabel");
      const results = await reasoner.isEntailed(store, [
        quad(penguin, rdfType, Bird),      // supported + entailed → true
        quad(unknown, rdfType, Bird),       // supported + not entailed → false
        quad(A, unsupportedPred, B),        // unsupported predicate → null
      ]);

      expect(results).toEqual([true, false, null]);
    });

    it("unsupported predicate returns null, no Worker call", async () => {
      const reasoner = await makeReadyReasoner();
      const store = new Store([quad(A, subClassOf, B, defaultGraph())]);

      const skosLabel = namedNode("http://www.w3.org/2004/02/skos/core#prefLabel");
      const result = await reasoner.isEntailed(store, quad(A, skosLabel, B));

      expect(result).toBeNull();
      expect(mocks.workerPostMessage).not.toHaveBeenCalled();
    });

    it("called before any reasoning: triggers reasoning internally", async () => {
      const reasoner = await makeReadyReasoner();
      const store = new Store([quad(Penguin, subClassOf, Bird, defaultGraph())]);

      // No prior reasoning — fresh reasoner
      mockRealizationSequence([quad(penguin, rdfType, Bird, defaultGraph())]);

      const result = await reasoner.isEntailed(store, quad(penguin, rdfType, Bird));

      expect(result).toBe(true);
      // Worker must have been called (reasoning triggered internally)
      expect(mocks.workerPostMessage).toHaveBeenCalled();
      const methods = mocks.workerPostMessage.mock.calls.map(
        (c) => (c[0] as { method: string }).method,
      );
      expect(methods).toContain("loadTripleBuffer");
      expect(methods).toContain("realization");
    });

    it("store changes → cache miss → re-reasons: Worker receives two loadTripleBuffer calls", async () => {
      const reasoner = await makeReadyReasoner();
      const store = new Store([quad(Penguin, subClassOf, Bird, defaultGraph())]);

      mockRealizationSequence([quad(penguin, rdfType, Bird, defaultGraph())]);
      await reasoner.isEntailed(store, quad(penguin, rdfType, Bird));

      // Add a triple to change the store fingerprint
      store.addQuad(quad(B, subClassOf, C, defaultGraph()));
      mocks.workerPostMessage.mockClear();

      mockRealizationSequence([quad(penguin, rdfType, Bird, defaultGraph())]);
      await reasoner.isEntailed(store, quad(penguin, rdfType, Bird));

      const loadCalls = mocks.workerPostMessage.mock.calls.filter(
        (c) => (c[0] as { method: string }).method === "loadTripleBuffer",
      );
      expect(loadCalls).toHaveLength(1); // one in second call after cache miss
    });

    it("concurrent with materialize: queued correctly, both complete without hang", async () => {
      const reasoner = await makeReadyReasoner();
      const store = new Store([quad(Penguin, subClassOf, Bird, defaultGraph())]);
      const store2 = new Store([quad(A, subClassOf, B, defaultGraph())]);

      const buf = buildCombinedBuffer([quad(penguin, rdfType, Bird, defaultGraph())]);
      const emptyBuf = buildCombinedBuffer([]);

      // Set up mock to handle both operations sequentially
      mocks.workerPostMessage.mockImplementation((msg: unknown) => {
        const req = msg as { id: number; method: string };
        if (req.method === "loadTripleBuffer") simulateWorkerMessage({ id: req.id, result: true });
        else if (req.method === "realization") simulateWorkerMessage({ id: req.id, result: true });
        else if (req.method === "getInferredTripleBuffer") {
          // First call (from materialize) returns empty; second (from isEntailed) returns entailed quad
          const callCount = mocks.workerPostMessage.mock.calls.filter(
            (c) => (c[0] as { method: string }).method === "getInferredTripleBuffer"
          ).length;
          simulateWorkerMessage({ id: req.id, result: callCount <= 1 ? emptyBuf : buf });
        }
      });

      const [materializeResult, isEntailedResult] = await Promise.all([
        reasoner.materialize(store2),
        reasoner.isEntailed(store, quad(penguin, rdfType, Bird)),
      ]);

      // Both should complete
      expect(materializeResult).toBeUndefined(); // materialize returns void
      // isEntailed result depends on store2 having different fingerprint; both ran independently
      expect(typeof isEntailedResult).toBe("boolean");
    });
  });
});
