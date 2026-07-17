/**
 * Unit tests for explainInconsistencyLaconic() — Horridge laconic post-processing.
 *
 * Uses the same vi.hoisted / vi.stubGlobal("Worker") / simulateWorkerMessage
 * scaffolding as the other RdfReasoner unit tests.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { DataFactory, Store } from "n3";
import type { Quad } from "@rdfjs/types";

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

const owlDisjointWith = namedNode("http://www.w3.org/2002/07/owl#disjointWith");
const subClassOf = namedNode("http://www.w3.org/2000/01/rdf-schema#subClassOf");

const A = namedNode("http://example.org/A");
const B = namedNode("http://example.org/B");

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

/**
 * Mock that makes every consistency check return consistent.
 */
function mockAlwaysConsistent() {
  mocks.workerPostMessage.mockImplementation((msg: unknown) => {
    const req = msg as { id: number; method: string };
    if (req.method === "loadTripleBuffer") {
      simulateWorkerMessage({ id: req.id, result: true });
    } else if (req.method === "classification") {
      simulateWorkerMessage({ id: req.id, result: true });
    } else if (req.method === "consistency") {
      simulateWorkerMessage({ id: req.id, result: true }); // consistent
    }
  });
}

/**
 * Mock that makes the ontology inconsistent when the loaded triple set
 * contains at least `minTriples` triples, consistent otherwise.
 *
 * Triples in the binary buffer: each triple = 3 × uint32 = 12 bytes.
 */
function mockInconsistentWhenAtLeast(minTriples: number) {
  let lastTripleCount = 0;
  mocks.workerPostMessage.mockImplementation((msg: unknown) => {
    const req = msg as { id: number; method: string; args: unknown[] };
    if (req.method === "loadTripleBuffer") {
      lastTripleCount = Math.floor((req.args[0] as ArrayBuffer).byteLength / 12);
      simulateWorkerMessage({ id: req.id, result: true });
    } else if (req.method === "classification") {
      simulateWorkerMessage({ id: req.id, result: true });
    } else if (req.method === "consistency") {
      // consistent = true means consistent; false means inconsistent
      simulateWorkerMessage({ id: req.id, result: lastTripleCount < minTriples });
    }
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RdfReasoner — explainInconsistencyLaconic", () => {
  beforeEach(() => {
    mocks.workerPostMessage.mockClear();
    mocks.WorkerMock.mockClear();
    mocks.clearListeners();
  });

  // -------------------------------------------------------------------------
  // Test 1: Consistent ontology → empty array
  // -------------------------------------------------------------------------

  it("returns [] for a consistent ontology", async () => {
    const reasoner = await makeReadyReasoner();
    const store = new Store([
      quad(A, subClassOf, B, defaultGraph()),
    ]);

    mockAlwaysConsistent();

    const result = await reasoner.explainInconsistencyLaconic(store);

    expect(result).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Test 2: Inconsistent ontology → justification + laconic parts returned
  // -------------------------------------------------------------------------

  it("returns justification with laconic parts for an inconsistent ontology", async () => {
    const reasoner = await makeReadyReasoner();
    // Two axioms that together cause inconsistency:
    //   A owl:disjointWith B  +  A rdfs:subClassOf B
    const q1 = quad(A, owlDisjointWith, B, defaultGraph());
    const q2 = quad(A, subClassOf, B, defaultGraph());
    const store = new Store([q1, q2]);

    // Inconsistent when both quads (>= 2 triples) are present.
    // Single-quad subsets are consistent.
    mockInconsistentWhenAtLeast(2);

    const result = await reasoner.explainInconsistencyLaconic(store);

    expect(result).toHaveLength(1);
    const { justification, laconic } = result[0];

    // Justification is the MIPS: both axioms needed
    expect(justification).toHaveLength(2);

    // Laconic not skipped — simple axioms don't split further
    expect(laconic.skipped).toBe(false);

    // Both axioms are kept in the laconic result (each alone is consistent)
    expect(laconic.parts).toHaveLength(2);

    // Each part references its own source quad
    for (const part of laconic.parts) {
      expect(part.quad).toBeDefined();
      expect(part.sourceQuad).toBeDefined();
      // Simple (non-split) axioms: quad equals sourceQuad, isPartOf = false
      expect(part.isPartOf).toBe(false);
    }
  });

  // -------------------------------------------------------------------------
  // Test 3: Cost cap exceeded → skipped: true
  // -------------------------------------------------------------------------

  it("returns skipped:true when cost cap is exceeded", async () => {
    const reasoner = await makeReadyReasoner();
    const q1 = quad(A, owlDisjointWith, B, defaultGraph());
    const q2 = quad(A, subClassOf, B, defaultGraph());
    const store = new Store([q1, q2]);

    mockInconsistentWhenAtLeast(2);

    // laconicMaxAxioms: 1 — the 2-axiom MIPS exceeds this cap
    const result = await reasoner.explainInconsistencyLaconic(store, {
      laconicMaxAxioms: 1,
    });

    expect(result).toHaveLength(1);
    const { justification, laconic } = result[0];

    expect(justification).toHaveLength(2);
    expect(laconic.skipped).toBe(true);
    expect(laconic.sharpened).toBe(false);

    // Parts are the original axioms verbatim (no laconic post-processing)
    expect(laconic.parts).toHaveLength(2);
    for (const part of laconic.parts) {
      expect(part.isPartOf).toBe(false);
    }
  });

  // -------------------------------------------------------------------------
  // Test 4: maxJustifications: 0 → empty array
  // -------------------------------------------------------------------------

  it("returns [] when maxJustifications is 0", async () => {
    const reasoner = await makeReadyReasoner();
    const q1 = quad(A, owlDisjointWith, B, defaultGraph());
    const q2 = quad(A, subClassOf, B, defaultGraph());
    const store = new Store([q1, q2]);

    // Inconsistent ontology — but maxJustifications: 0 should short-circuit
    mockInconsistentWhenAtLeast(2);

    const result = await reasoner.explainInconsistencyLaconic(store, {
      maxJustifications: 0,
    });

    expect(result).toEqual([]);
  });
});
