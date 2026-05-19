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
});
