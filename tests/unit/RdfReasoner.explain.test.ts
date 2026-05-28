/**
 * Unit tests for explain() and explainInconsistency() — BlackBox justification.
 *
 * Mirrors the vi.hoisted / vi.stubGlobal("Worker") / simulateWorkerMessage
 * scaffolding from RdfReasoner.store.test.ts exactly.
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
const rdfType = namedNode("http://www.w3.org/1999/02/22-rdf-syntax-ns#type");
const owlClass = namedNode("http://www.w3.org/2002/07/owl#Class");
const owlThing = namedNode("http://www.w3.org/2002/07/owl#Thing");
const owlNothing = namedNode("http://www.w3.org/2002/07/owl#Nothing");
const owlDisjointWith = namedNode("http://www.w3.org/2002/07/owl#disjointWith");

const A = namedNode("http://example.org/A");
const B = namedNode("http://example.org/B");
const C = namedNode("http://example.org/C");
const alice = namedNode("http://example.org/alice");
const Person = namedNode("http://example.org/Person");
const Organization = namedNode("http://example.org/Organization");

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

/** Respond to Worker calls for the classify pipeline, with dynamic entailment
 *  based on the size of the triple buffer (number of triples loaded). */
function mockClassifyWithSizeCheck(
  entailedAxiom: Quad,
  minTriplesForEntailment: number,
) {
  let lastTripleCount = 0;
  mocks.workerPostMessage.mockImplementation((msg: unknown) => {
    const req = msg as { id: number; method: string; args: unknown[] };
    if (req.method === "loadTripleBuffer") {
      // Each triple = 3 × uint32 = 12 bytes; args[0] is tripleBuffer
      lastTripleCount = (req.args[0] as ArrayBuffer).byteLength / 12;
      simulateWorkerMessage({ id: req.id, result: true });
    } else if (req.method === "classification") {
      simulateWorkerMessage({ id: req.id, result: true });
    } else if (req.method === "getInferredTripleBuffer") {
      const isFullSet = lastTripleCount >= minTriplesForEntailment;
      const buf = isFullSet ? buildCombinedBuffer([entailedAxiom]) : buildCombinedBuffer([]);
      simulateWorkerMessage({ id: req.id, result: buf });
    }
  });
}

/** Respond to all Worker calls with empty inferred results. */
function mockEmptyClassify() {
  const emptyBuf = buildCombinedBuffer([]);
  mocks.workerPostMessage.mockImplementation((msg: unknown) => {
    const req = msg as { id: number; method: string };
    if (req.method === "loadTripleBuffer") {
      simulateWorkerMessage({ id: req.id, result: true });
    } else if (req.method === "classification") {
      simulateWorkerMessage({ id: req.id, result: true });
    } else if (req.method === "realization") {
      simulateWorkerMessage({ id: req.id, result: true });
    } else if (req.method === "getInferredTripleBuffer") {
      simulateWorkerMessage({ id: req.id, result: emptyBuf });
    } else if (req.method === "getPropertyTripleBuffer") {
      simulateWorkerMessage({ id: req.id, result: emptyBuf });
    } else if (req.method === "consistency") {
      simulateWorkerMessage({ id: req.id, result: true });
    }
  });
}

/** Standard mock for classify pipeline */
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
    } else if (req.method === "getPropertyTripleBuffer") {
      simulateWorkerMessage({ id: req.id, result: buf });
    } else if (req.method === "consistency") {
      simulateWorkerMessage({ id: req.id, result: true });
    }
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RdfReasoner — explain", () => {
  beforeEach(() => {
    mocks.workerPostMessage.mockClear();
    mocks.WorkerMock.mockClear();
    mocks.clearListeners();
  });

  // -------------------------------------------------------------------------
  // Test 1: happy path — entailed axiom returns non-empty justification
  // -------------------------------------------------------------------------

  it("returns one minimal justification for subClassOf chain", async () => {
    const reasoner = await makeReadyReasoner();
    const store = new Store([
      quad(A, subClassOf, B, defaultGraph()),
      quad(B, subClassOf, C, defaultGraph()),
    ]);
    const axiom = quad(A, subClassOf, C, defaultGraph());

    // Return entailed iff >= 2 triples loaded (both axioms present)
    mockClassifyWithSizeCheck(axiom, 2);

    const result = await reasoner.explain(store, axiom);
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(2);
    const subjects = result[0].map(q => q.subject.value);
    expect(subjects).toContain("http://example.org/A");
    expect(subjects).toContain("http://example.org/B");
  });

  // -------------------------------------------------------------------------
  // Test 2: non-entailed axiom returns []
  // -------------------------------------------------------------------------

  it("returns [] when axiom is not entailed", async () => {
    const reasoner = await makeReadyReasoner();
    const store = new Store([
      quad(A, subClassOf, B, defaultGraph()),
    ]);
    const axiom = quad(A, subClassOf, C, defaultGraph());

    // Worker always returns empty — axiom not entailed
    mockEmptyClassify();

    const result = await reasoner.explain(store, axiom);
    expect(result).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Test 3: maxJustifications: 0 returns [] without Worker calls
  // -------------------------------------------------------------------------

  it("maxJustifications: 0 returns [] without calling Worker", async () => {
    const reasoner = await makeReadyReasoner();
    const store = new Store([
      quad(A, subClassOf, B, defaultGraph()),
    ]);
    const axiom = quad(A, subClassOf, C, defaultGraph());

    const result = await reasoner.explain(store, axiom, { maxJustifications: 0 });
    expect(result).toEqual([]);
    expect(mocks.workerPostMessage).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 4: unsupported predicate throws
  // -------------------------------------------------------------------------

  it("unsupported predicate rejects with error", async () => {
    const reasoner = await makeReadyReasoner();
    const store = new Store([quad(A, subClassOf, B, defaultGraph())]);
    const skosLabel = namedNode("http://www.w3.org/2004/02/skos/core#prefLabel");
    const axiom = quad(A, skosLabel, B, defaultGraph());

    await expect(reasoner.explain(store, axiom)).rejects.toThrow(
      "explain: unsupported predicate <http://www.w3.org/2004/02/skos/core#prefLabel>"
    );
  });

  // -------------------------------------------------------------------------
  // Test 5: axiomFilter restricts candidates
  // -------------------------------------------------------------------------

  it("axiomFilter restricts candidates — TBox-only filter yields justification", async () => {
    const reasoner = await makeReadyReasoner();
    // Store has TBox (subClassOf) + ABox (rdf:type) quads
    const store = new Store([
      quad(A, subClassOf, B, defaultGraph()),
      quad(B, subClassOf, C, defaultGraph()),
      quad(alice, rdfType, A, defaultGraph()),
    ]);
    const axiom = quad(A, subClassOf, C, defaultGraph());

    // Mock: entailed when >= 2 triples loaded
    mockClassifyWithSizeCheck(axiom, 2);

    // Filter out ABox quads (rdf:type assertions on individuals)
    const result = await reasoner.explain(store, axiom, {
      axiomFilter: (q) => q.predicate.value !== "http://www.w3.org/1999/02/22-rdf-syntax-ns#type",
    });

    expect(result).toHaveLength(1);
    // Only TBox quads in the justification
    for (const q of result[0]) {
      expect(q.predicate.value).toBe("http://www.w3.org/2000/01/rdf-schema#subClassOf");
    }
  });

  // -------------------------------------------------------------------------
  // Test 6: explain + classify queue sequencing (no hang)
  // -------------------------------------------------------------------------

  it("explain followed by classify completes without hang", async () => {
    const reasoner = await makeReadyReasoner();
    const store = new Store([
      quad(A, subClassOf, B, defaultGraph()),
      quad(B, subClassOf, C, defaultGraph()),
    ]);
    const axiom = quad(A, subClassOf, C, defaultGraph());

    // Mock for explain
    mockClassifyWithSizeCheck(axiom, 2);

    await reasoner.explain(store, axiom);

    // Now set up mock for classify
    mockWorkerSequence([quad(A, subClassOf, C, defaultGraph())]);

    await reasoner.classify(store);

    const ig = namedNode(INFERRED_GRAPH_IRI);
    const inferred = store.getQuads(null, null, null, ig);
    expect(inferred.length).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------------
  // Test 7: two sequential explain calls complete without hang
  // -------------------------------------------------------------------------

  it("two sequential explain calls both resolve", async () => {
    const reasoner = await makeReadyReasoner();
    const store = new Store([
      quad(A, subClassOf, B, defaultGraph()),
      quad(B, subClassOf, C, defaultGraph()),
    ]);
    const axiom = quad(A, subClassOf, C, defaultGraph());

    mockClassifyWithSizeCheck(axiom, 2);

    const r1 = await reasoner.explain(store, axiom);
    expect(r1).toHaveLength(1);

    // Second explain call on same store
    mockClassifyWithSizeCheck(axiom, 2);
    const r2 = await reasoner.explain(store, axiom);
    expect(r2).toHaveLength(1);
  });
});

describe("RdfReasoner — explainInconsistency", () => {
  beforeEach(() => {
    mocks.workerPostMessage.mockClear();
    mocks.WorkerMock.mockClear();
    mocks.clearListeners();
  });

  // -------------------------------------------------------------------------
  // Test 8: consistent ontology returns []
  // -------------------------------------------------------------------------

  it("consistent ontology returns []", async () => {
    const reasoner = await makeReadyReasoner();
    const store = new Store([
      quad(A, subClassOf, B, defaultGraph()),
    ]);

    // Mock: consistency returns true
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

    const result = await reasoner.explainInconsistency(store);
    expect(result).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Test 9: inconsistent ontology returns non-empty justification
  // -------------------------------------------------------------------------

  it("inconsistent ontology returns non-empty MIPS", async () => {
    const reasoner = await makeReadyReasoner();
    // Inconsistent: alice is both Person and Organization, which are disjoint
    const store = new Store([
      quad(alice, rdfType, Person, defaultGraph()),
      quad(alice, rdfType, Organization, defaultGraph()),
      quad(Person, owlDisjointWith, Organization, defaultGraph()),
    ]);

    // Mock: all sub-calls use the consistency oracle.
    // Inconsistent when >= 3 quads loaded (full set); consistent otherwise.
    let consistencyChecked = false;
    let lastTripleCount = 0;
    mocks.workerPostMessage.mockImplementation((msg: unknown) => {
      const req = msg as { id: number; method: string; args: unknown[] };
      if (req.method === "loadTripleBuffer") {
        // Each triple = 3 × uint32 = 12 bytes; args[0] is tripleBuffer
        lastTripleCount = Math.floor((req.args[0] as ArrayBuffer).byteLength / 12);
        simulateWorkerMessage({ id: req.id, result: true });
      } else if (req.method === "classification") {
        simulateWorkerMessage({ id: req.id, result: true });
      } else if (req.method === "consistency") {
        consistencyChecked = true;
        // Full set (>= 3 quads) is inconsistent; subsets are consistent
        simulateWorkerMessage({ id: req.id, result: lastTripleCount < 3 });
      }
    });

    const result = await reasoner.explainInconsistency(store);
    expect(consistencyChecked).toBe(true);
    expect(result).toHaveLength(1);
    expect(result[0].length).toBeGreaterThanOrEqual(1);
    expect(result[0].length).toBeLessThanOrEqual(3);
  });

  // -------------------------------------------------------------------------
  // Test 10: explainInconsistency followed by classify — no queue stall
  // -------------------------------------------------------------------------

  it("explainInconsistency followed by classify completes without hang", async () => {
    const reasoner = await makeReadyReasoner();
    const store = new Store([
      quad(A, subClassOf, B, defaultGraph()),
    ]);

    // Mock: consistent
    mocks.workerPostMessage.mockImplementation((msg: unknown) => {
      const req = msg as { id: number; method: string };
      if (req.method === "loadTripleBuffer") {
        simulateWorkerMessage({ id: req.id, result: true });
      } else if (req.method === "classification") {
        simulateWorkerMessage({ id: req.id, result: true });
      } else if (req.method === "consistency") {
        simulateWorkerMessage({ id: req.id, result: true });
      } else if (req.method === "getInferredTripleBuffer") {
        simulateWorkerMessage({ id: req.id, result: buildCombinedBuffer([]) });
      }
    });

    const result = await reasoner.explainInconsistency(store);
    expect(result).toEqual([]);

    // Now classify should work without stalling
    mockWorkerSequence([quad(A, subClassOf, C, defaultGraph())]);
    await reasoner.classify(store);

    const ig = namedNode(INFERRED_GRAPH_IRI);
    const inferred = store.getQuads(null, null, null, ig);
    expect(inferred.length).toBeGreaterThanOrEqual(1);
  });
});
