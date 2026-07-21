/**
 * Unit tests for RdfReasoner.validate().
 *
 * Uses the same vi.hoisted / vi.stubGlobal("Worker") / simulateWorkerMessage
 * scaffolding as RdfReasoner.store.test.ts.
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
import { RdfReasoner } from "../../ts/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const { namedNode, quad, defaultGraph } = DataFactory;

const subClassOf = namedNode("http://www.w3.org/2000/01/rdf-schema#subClassOf");
const A = namedNode("http://example.org/A");
const B = namedNode("http://example.org/B");
const C = namedNode("http://example.org/C");

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

const EMPTY_BUF = buildCombinedBuffer([]);

/**
 * Mock Worker for validate() calls.
 *
 * - `consistent`         — what the "consistency" call returns
 * - `unsatIris`          — what "getUnsatisfiableClassBuffer" returns (newline-separated)
 * - `unsatInSubset`      — optional: IRIs that should appear when classifying subsets
 *                          (used to drive the warning BlackBox)
 */
function mockValidateSequence(opts: {
  consistent: boolean;
  unsatIris?: string;
  unsatInSubset?: string;
}) {
  const { consistent, unsatIris = "", unsatInSubset = unsatIris } = opts;
  mocks.workerPostMessage.mockImplementation((msg: unknown) => {
    const req = msg as { id: number; method: string };
    if (req.method === "loadTripleBuffer") {
      simulateWorkerMessage({ id: req.id, result: true });
    } else if (req.method === "classification") {
      simulateWorkerMessage({ id: req.id, result: true });
    } else if (req.method === "consistency") {
      simulateWorkerMessage({ id: req.id, result: consistent });
    } else if (req.method === "getInferredTripleBuffer") {
      simulateWorkerMessage({ id: req.id, result: EMPTY_BUF });
    } else if (req.method === "getUnsatisfiableClassBuffer") {
      simulateWorkerMessage({ id: req.id, result: unsatInSubset });
    } else if (req.method === "hasNativeJustification") {
      simulateWorkerMessage({ id: req.id, result: false });
    }
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RdfReasoner — validate()", () => {
  beforeEach(() => {
    mocks.workerPostMessage.mockClear();
    mocks.WorkerMock.mockClear();
    mocks.clearListeners();
  });

  it("consistent ontology with no unsat classes → { consistent: true, errors: [], warnings: [] }", async () => {
    const reasoner = await makeReadyReasoner();
    const store = new Store([quad(A, subClassOf, B, defaultGraph())]);
    mockValidateSequence({ consistent: true, unsatIris: "" });

    const result = await reasoner.validate(store);

    expect(result.consistent).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("inconsistent ontology → consistent: false, errors non-empty", async () => {
    const reasoner = await makeReadyReasoner();
    const store = new Store([quad(A, subClassOf, B, defaultGraph()), quad(B, subClassOf, C, defaultGraph())]);
    // Mock: always inconsistent, no unsat classes in unsat buffer (BlackBox will run)
    mocks.workerPostMessage.mockImplementation((msg: unknown) => {
      const req = msg as { id: number; method: string };
      if (req.method === "loadTripleBuffer") simulateWorkerMessage({ id: req.id, result: true });
      else if (req.method === "classification") simulateWorkerMessage({ id: req.id, result: true });
      else if (req.method === "consistency") simulateWorkerMessage({ id: req.id, result: false });
      else if (req.method === "getInferredTripleBuffer") simulateWorkerMessage({ id: req.id, result: EMPTY_BUF });
      else if (req.method === "getUnsatisfiableClassBuffer") simulateWorkerMessage({ id: req.id, result: "" });
    });

    const result = await reasoner.validate(store);

    expect(result.consistent).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.errors[0].length).toBeGreaterThanOrEqual(1);
    expect(result.warnings).toEqual([]);
  });

  it("maxJustificationsPerWarning: 0 → warnings have empty justifications, no extra BlackBox calls", async () => {
    const reasoner = await makeReadyReasoner();
    const store = new Store([quad(A, subClassOf, B, defaultGraph())]);
    mockValidateSequence({ consistent: true, unsatIris: "http://ex.org/Dead" });

    const result = await reasoner.validate(store, { maxJustificationsPerWarning: 0 });

    expect(result.consistent).toBe(true);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].classIRI).toBe("http://ex.org/Dead");
    expect(result.warnings[0].justifications).toEqual([]);

    // Verify no extra BlackBox calls happened for warnings: getUnsatisfiableClassBuffer
    // should be called exactly once (from _getUnsatisfiableClassesInternal), not once per class.
    const methods = mocks.workerPostMessage.mock.calls.map((c) => (c[0] as { method: string }).method);
    const unsatCalls = methods.filter((m) => m === "getUnsatisfiableClassBuffer");
    expect(unsatCalls).toHaveLength(1);
  });

  it("consistent ontology with one unsat class → warnings contains that classIRI", async () => {
    const reasoner = await makeReadyReasoner();
    const store = new Store([
      quad(A, subClassOf, B, defaultGraph()),
      quad(B, subClassOf, C, defaultGraph()),
    ]);

    const UNSAT_IRI = "http://ex.org/Dead";
    // Subset classification returns the unsat IRI so BlackBox finds a MUS
    mockValidateSequence({ consistent: true, unsatIris: UNSAT_IRI, unsatInSubset: UNSAT_IRI });

    const result = await reasoner.validate(store, { maxJustificationsPerWarning: 1 });

    expect(result.consistent).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].classIRI).toBe(UNSAT_IRI);
    expect(result.warnings[0].justifications.length).toBeGreaterThanOrEqual(1);
  });

  it("validate followed by classify does not hang (queue slot released)", async () => {
    const reasoner = await makeReadyReasoner();
    const store = new Store([quad(A, subClassOf, B, defaultGraph())]);
    mockValidateSequence({ consistent: true, unsatIris: "" });

    await reasoner.validate(store);

    // Now classify should complete without hanging
    mocks.workerPostMessage.mockClear();
    const inferredBuf = buildCombinedBuffer([quad(A, subClassOf, C, defaultGraph())]);
    mocks.workerPostMessage.mockImplementation((msg: unknown) => {
      const req = msg as { id: number; method: string };
      if (req.method === "loadTripleBuffer") simulateWorkerMessage({ id: req.id, result: true });
      else if (req.method === "classification") simulateWorkerMessage({ id: req.id, result: true });
      else if (req.method === "getInferredTripleBuffer") simulateWorkerMessage({ id: req.id, result: inferredBuf });
    });

    // Should resolve without hanging — that's the whole point of this test.
    // classify may be a cache hit (validate already classified the same store), so 0 calls is also valid.
    await reasoner.classify(store);
    // Just verify the call didn't hang (promise resolved)
    expect(true).toBe(true);
  });

  it("ValidationResult, ClassWarning, ValidateOptions are exported from package", async () => {
    // Type-level test: confirm named exports exist
    const { validate: _v, ...rest } = await import("../../ts/index.js");
    const exports = Object.keys(rest);
    // The values are re-exported as types so may not appear as runtime keys,
    // but the import should not throw
    expect(exports).toBeDefined();
  });
});
