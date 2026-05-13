/**
 * Unit tests for ts/index.ts — RdfReasoner
 *
 * Strategy: the Worker constructor is mocked so no real Worker thread is
 * spawned. The mock captures the message handler installed by RdfReasoner and
 * allows tests to simulate Worker responses (ready, error, method results)
 * synchronously via microtask-queuing.
 *
 * vi.hoisted() is used to create mock state before vi.mock factories run and
 * before module imports are evaluated.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { DataFactory } from "n3";
import type { Quad } from "@rdfjs/types";
import { encodeToBuffers } from "../../ts/intern.js";

// ---------------------------------------------------------------------------
// Step 1: Hoist mock state — must run before vi.mock factories and imports.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
  // Captured postMessage calls (Worker → main thread)
  const workerPostMessage = vi.fn<[unknown], void>();

  // Listeners registered via addEventListener
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

  return {
    workerPostMessage,
    WorkerMock,
    dispatchToListeners,
    clearListeners,
  };
});

// ---------------------------------------------------------------------------
// Step 2: Mock the Worker global.
// In Node / Vitest there is no global Worker, so we inject our mock.
// ---------------------------------------------------------------------------
vi.stubGlobal("Worker", mocks.WorkerMock);

// ---------------------------------------------------------------------------
// Step 3: Import module under test.
// ---------------------------------------------------------------------------
import { RdfReasoner } from "../../ts/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const { namedNode, quad, defaultGraph } = DataFactory;

// ---------------------------------------------------------------------------
// Binary-response helpers
// ---------------------------------------------------------------------------

export function buildCombinedBuffer(quads: Iterable<Quad>): ArrayBuffer {
  const { tripleBuffer, strTableBuffer } = encodeToBuffers(quads);
  const combined = new Uint8Array(4 + strTableBuffer.byteLength + tripleBuffer.byteLength);
  new DataView(combined.buffer).setUint32(0, strTableBuffer.byteLength, true);
  combined.set(new Uint8Array(strTableBuffer), 4);
  combined.set(new Uint8Array(tripleBuffer), 4 + strTableBuffer.byteLength);
  return combined.buffer;
}

/** Simulate a message arriving from the Worker to the main thread. */
function simulateWorkerMessage(data: unknown) {
  mocks.dispatchToListeners("message", {
    data,
  } as MessageEvent);
}

/** Simulate an error event from the Worker. */
function simulateWorkerError(message: string) {
  mocks.dispatchToListeners("error", { message } as ErrorEvent);
}

/**
 * Flush all microtasks / pending promises. Useful when the code under test
 * chains multiple await steps internally and we need all of them to settle
 * before asserting.
 */
async function flushPromises(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
}

/**
 * Create a RdfReasoner and immediately simulate the Worker posting {type:'ready'}.
 * Returns the ready reasoner.
 */
async function makeReadyReasoner(): Promise<RdfReasoner> {
  const reasoner = new RdfReasoner();
  // Let the constructor register its listener.
  await Promise.resolve();
  simulateWorkerMessage({ type: "ready" });
  await reasoner.ready;
  return reasoner;
}

/** Decode the string-table ArrayBuffer from a loadTripleBuffer worker message. */
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

/** Respond automatically to a sequence of Worker messages in the binary protocol flow. */
function autoRespond(inferredQuads: Quad[] = []): void {
  const buf = buildCombinedBuffer(inferredQuads);
  mocks.workerPostMessage.mockImplementation((msg: unknown) => {
    const req = msg as { id: number; method: string };
    if (req.method === "loadTripleBuffer") {
      simulateWorkerMessage({ id: req.id, result: true });
    } else if (req.method === "classify") {
      simulateWorkerMessage({ id: req.id, result: true });
    } else if (req.method === "getInferredTripleBuffer") {
      simulateWorkerMessage({ id: req.id, result: buf });
    } else if (req.method === "isConsistent") {
      simulateWorkerMessage({ id: req.id, result: true });
    }
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RdfReasoner", () => {
  beforeEach(() => {
    mocks.workerPostMessage.mockClear();
    mocks.WorkerMock.mockClear();
    mocks.clearListeners();
  });

  // -------------------------------------------------------------------------
  // ready promise
  // -------------------------------------------------------------------------

  describe("ready promise", () => {
    it("resolves when Worker posts {type:'ready'}", async () => {
      const reasoner = new RdfReasoner();
      await Promise.resolve();
      simulateWorkerMessage({ type: "ready" });
      await expect(reasoner.ready).resolves.toBeUndefined();
    });

    it("rejects when Worker posts {type:'error', error: string}", async () => {
      const reasoner = new RdfReasoner();
      await Promise.resolve();
      simulateWorkerMessage({ type: "error", error: "WASM load failed" });
      await expect(reasoner.ready).rejects.toThrow("WASM load failed");
    });

    it("rejects when Worker emits an error event before ready", async () => {
      const reasoner = new RdfReasoner();
      await Promise.resolve();
      simulateWorkerError("Worker crashed");
      await expect(reasoner.ready).rejects.toThrow("Worker crashed");
    });
  });

  // -------------------------------------------------------------------------
  // reason() — happy path
  // -------------------------------------------------------------------------

  describe("reason()", () => {
    it("happy path: reason() calls loadTripleBuffer → classify → getInferredTripleBuffer and returns Quad[]", async () => {
      const reasoner = await makeReadyReasoner();

      const A = namedNode("http://example.org/A");
      const B = namedNode("http://example.org/B");
      const C = namedNode("http://example.org/C");
      const subClassOf = namedNode(
        "http://www.w3.org/2000/01/rdf-schema#subClassOf",
      );

      autoRespond([quad(A, subClassOf, C, defaultGraph())]);

      const resultQuads = await reasoner.reason([
        quad(A, subClassOf, B, defaultGraph()),
        quad(B, subClassOf, C, defaultGraph()),
      ]);

      // Should have sent three Worker messages
      expect(mocks.workerPostMessage).toHaveBeenCalledTimes(3);
      const calls = mocks.workerPostMessage.mock.calls.map(
        (c) => (c[0] as { method: string }).method,
      );
      expect(calls).toEqual(["loadTripleBuffer", "classify", "getInferredTripleBuffer"]);

      // Result should contain A subClassOf C
      expect(resultQuads).toHaveLength(1);
      expect(resultQuads[0].subject.value).toBe("http://example.org/A");
      expect(resultQuads[0].predicate.value).toBe(
        "http://www.w3.org/2000/01/rdf-schema#subClassOf",
      );
      expect(resultQuads[0].object.value).toBe("http://example.org/C");
      // All returned quads in DefaultGraph
      expect(resultQuads[0].graph.termType).toBe("DefaultGraph");
    });

    it("edge case: reason([]) → empty array (no inferred triples)", async () => {
      const reasoner = await makeReadyReasoner();
      autoRespond([]);
      const result = await reasoner.reason([]);
      expect(result).toEqual([]);
    });

    it("edge case: named graphs in input quads → graph IRI not in string table", async () => {
      const reasoner = await makeReadyReasoner();

      const subject = namedNode("http://example.org/S");
      const predicate = namedNode("http://example.org/P");
      const object = namedNode("http://example.org/O");
      const graph = namedNode("http://example.org/G");

      let strEntries: string[] = [];
      mocks.workerPostMessage.mockImplementation((msg: unknown) => {
        const req = msg as { id: number; method: string; args: unknown[] };
        if (req.method === "loadTripleBuffer") {
          strEntries = decodeStrTableEntries(req.args[1] as ArrayBuffer);
          simulateWorkerMessage({ id: req.id, result: true });
        } else if (req.method === "classify") {
          simulateWorkerMessage({ id: req.id, result: true });
        } else if (req.method === "getInferredTripleBuffer") {
          simulateWorkerMessage({ id: req.id, result: buildCombinedBuffer([]) });
        }
      });

      await reasoner.reason([quad(subject, predicate, object, graph)]);

      // Graph IRI must not appear as a string-table entry
      expect(strEntries).not.toContain("http://example.org/G");
      // Subject, predicate, object IRIs must be present
      expect(strEntries).toContain("http://example.org/S");
      expect(strEntries).toContain("http://example.org/P");
      expect(strEntries).toContain("http://example.org/O");
    });

    it("error path: Worker method throws → reason() rejects with error message", async () => {
      const reasoner = await makeReadyReasoner();

      mocks.workerPostMessage.mockImplementation((msg: unknown) => {
        const req = msg as { id: number; method: string };
        if (req.method === "loadTripleBuffer") {
          simulateWorkerMessage({ id: req.id, error: "binary decode error" });
        }
      });

      await expect(
        reasoner.reason([
          quad(
            namedNode("http://example.org/A"),
            namedNode("http://example.org/P"),
            namedNode("http://example.org/B"),
          ),
        ]),
      ).rejects.toThrow("binary decode error");
    });

    it("mode:'consistency' → returns [] without calling getInferredTripleBuffer", async () => {
      const reasoner = await makeReadyReasoner();

      mocks.workerPostMessage.mockImplementation((msg: unknown) => {
        const req = msg as { id: number; method: string };
        if (req.method === "loadTripleBuffer") {
          simulateWorkerMessage({ id: req.id, result: true });
        } else if (req.method === "classify") {
          simulateWorkerMessage({ id: req.id, result: true });
        }
        // No response for getInferredTripleBuffer — it should not be called.
      });

      const result = await reasoner.reason([], { mode: "consistency" });
      expect(result).toEqual([]);

      const methods = mocks.workerPostMessage.mock.calls.map(
        (c) => (c[0] as { method: string }).method,
      );
      expect(methods).not.toContain("getInferredTripleBuffer");
    });

    it("mode:'full' → calls getInferredTripleBuffer and returns inferred quads", async () => {
      const reasoner = await makeReadyReasoner();

      autoRespond([quad(namedNode("http://example.org/A"), namedNode("http://example.org/P"), namedNode("http://example.org/B"), defaultGraph())]);

      const result = await reasoner.reason([], { mode: "full" });
      expect(result).toHaveLength(1);
      expect(result[0].subject.value).toBe("http://example.org/A");
    });
  });

  // -------------------------------------------------------------------------
  // classify()
  // -------------------------------------------------------------------------

  describe("classify()", () => {
    it("is an alias for reason(quads, {mode:'classify'})", async () => {
      const reasoner = await makeReadyReasoner();

      autoRespond([quad(namedNode("http://example.org/A"), namedNode("http://example.org/P"), namedNode("http://example.org/B"), defaultGraph())]);

      const result = await reasoner.classify([]);
      expect(result).toHaveLength(1);
      expect(result[0].subject.value).toBe("http://example.org/A");

      const methods = mocks.workerPostMessage.mock.calls.map(
        (c) => (c[0] as { method: string }).method,
      );
      expect(methods).toEqual(["loadTripleBuffer", "classify", "getInferredTripleBuffer"]);
    });
  });

  // -------------------------------------------------------------------------
  // checkConsistency()
  // -------------------------------------------------------------------------

  describe("checkConsistency()", () => {
    it("happy path: returns true for a consistent ontology", async () => {
      const reasoner = await makeReadyReasoner();

      mocks.workerPostMessage.mockImplementation((msg: unknown) => {
        const req = msg as { id: number; method: string };
        if (req.method === "loadTripleBuffer") {
          simulateWorkerMessage({ id: req.id, result: true });
        } else if (req.method === "classify") {
          simulateWorkerMessage({ id: req.id, result: true });
        } else if (req.method === "isConsistent") {
          simulateWorkerMessage({ id: req.id, result: true });
        }
      });

      const A = namedNode("http://example.org/A");
      const B = namedNode("http://example.org/B");
      const subClassOf = namedNode(
        "http://www.w3.org/2000/01/rdf-schema#subClassOf",
      );

      const result = await reasoner.checkConsistency([
        quad(A, subClassOf, B, defaultGraph()),
      ]);
      expect(result).toBe(true);

      const methods = mocks.workerPostMessage.mock.calls.map(
        (c) => (c[0] as { method: string }).method,
      );
      expect(methods).toEqual(["loadTripleBuffer", "classify", "isConsistent"]);
    });

    it("returns false for an inconsistent ontology", async () => {
      const reasoner = await makeReadyReasoner();

      mocks.workerPostMessage.mockImplementation((msg: unknown) => {
        const req = msg as { id: number; method: string };
        if (req.method === "loadTripleBuffer") {
          simulateWorkerMessage({ id: req.id, result: true });
        } else if (req.method === "classify") {
          simulateWorkerMessage({ id: req.id, result: false });
        } else if (req.method === "isConsistent") {
          simulateWorkerMessage({ id: req.id, result: false });
        }
      });

      const result = await reasoner.checkConsistency([]);
      expect(result).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // terminate()
  // -------------------------------------------------------------------------

  describe("terminate()", () => {
    it("calls worker.terminate()", async () => {
      const reasoner = await makeReadyReasoner();
      // Get the Worker instance created by the constructor
      const workerInstance = mocks.WorkerMock.mock.instances[0] as {
        terminate: ReturnType<typeof vi.fn>;
      };
      reasoner.terminate();
      expect(workerInstance.terminate).toHaveBeenCalledOnce();
    });

    it("rejects pending calls with 'Worker terminated'", async () => {
      const reasoner = await makeReadyReasoner();

      // Don't respond to any Worker messages — leave calls pending.
      mocks.workerPostMessage.mockImplementation(() => {
        // no-op
      });

      // Start a reason() call without awaiting it yet.
      const pendingCall = reasoner.reason([
        quad(
          namedNode("http://example.org/A"),
          namedNode("http://example.org/P"),
          namedNode("http://example.org/B"),
        ),
      ]);

      // Give the queue / async steps a chance to post to the Worker.
      await flushPromises(10);

      // Now terminate — should drain pending map.
      reasoner.terminate();

      await expect(pendingCall).rejects.toThrow("Worker terminated");
    });
  });

  // -------------------------------------------------------------------------
  // onerror handler
  // -------------------------------------------------------------------------

  describe("Worker onerror", () => {
    it("rejects ready if Worker crashes before posting ready", async () => {
      const reasoner = new RdfReasoner();
      await Promise.resolve();
      simulateWorkerError("init crash");
      await expect(reasoner.ready).rejects.toThrow("init crash");
    });

    it("rejects pending calls when Worker crashes after ready", async () => {
      const reasoner = await makeReadyReasoner();

      mocks.workerPostMessage.mockImplementation(() => {
        // no-op — leave call pending
      });

      const pendingCall = reasoner.reason([
        quad(
          namedNode("http://example.org/A"),
          namedNode("http://example.org/P"),
          namedNode("http://example.org/B"),
        ),
      ]);

      await flushPromises(10);

      simulateWorkerError("runtime crash");

      await expect(pendingCall).rejects.toThrow("runtime crash");
    });
  });

  // -------------------------------------------------------------------------
  // _call / message routing
  // -------------------------------------------------------------------------

  describe("internal message routing", () => {
    it("uses incrementing IDs for concurrent calls", async () => {
      const reasoner = await makeReadyReasoner();

      // Don't respond yet — just check IDs of dispatched messages
      mocks.workerPostMessage.mockImplementation(() => {
        // no-op, collect calls
      });

      // Fire two calls but don't await (they will hang since no responses)
      const _p1 = (reasoner as unknown as { _call: (...a: unknown[]) => Promise<unknown> })["_call"]("classify", []);
      const _p2 = (reasoner as unknown as { _call: (...a: unknown[]) => Promise<unknown> })["_call"]("classify", []);

      await flushPromises(5);

      const ids = mocks.workerPostMessage.mock.calls.map(
        (c) => (c[0] as { id: number }).id,
      );
      expect(ids[0]).not.toBe(ids[1]);
      expect(ids[1]).toBe(ids[0] + 1);
    });
  });
});
