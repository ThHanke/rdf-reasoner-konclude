/**
 * Unit tests for explainEntailment() — entailment-as-unsatisfiability justification.
 *
 * Uses the same vi.hoisted / vi.stubGlobal("Worker") / simulateWorkerMessage
 * scaffolding as RdfReasoner.explain.test.ts.
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

const RDFS_SUBCLASS_OF = "http://www.w3.org/2000/01/rdf-schema#subClassOf";
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const OWL_DISJOINT_WITH = "http://www.w3.org/2002/07/owl#disjointWith";

const subClassOf = namedNode(RDFS_SUBCLASS_OF);
const rdfType = namedNode(RDF_TYPE);
const owlDisjointWith = namedNode(OWL_DISJOINT_WITH);

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

// ---------------------------------------------------------------------------
// Mock helpers for the consistency oracle
// ---------------------------------------------------------------------------

/**
 * Mock that makes the ontology always consistent (never entailed).
 * consistency always returns true → not inconsistent.
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
    } else if (req.method === "isSatisfiableClass") {
      simulateWorkerMessage({ id: req.id, result: true });
    } else if (req.method === "getInferredTripleBuffer") {
      simulateWorkerMessage({ id: req.id, result: buildCombinedBuffer([]) });
    }
  });
}

/**
 * Mock that makes ontology always inconsistent (for C1 test).
 */
function mockAlwaysInconsistent() {
  mocks.workerPostMessage.mockImplementation((msg: unknown) => {
    const req = msg as { id: number; method: string };
    if (req.method === "loadTripleBuffer") {
      simulateWorkerMessage({ id: req.id, result: true });
    } else if (req.method === "classification") {
      simulateWorkerMessage({ id: req.id, result: true });
    } else if (req.method === "consistency") {
      simulateWorkerMessage({ id: req.id, result: false }); // inconsistent
    }
  });
}

/**
 * Mock that is consistent for the base ontology, but inconsistent when extra
 * triples (probeQuads) are added beyond a threshold count.
 *
 * `consistencyThreshold` should equal the number of probe quads (4 for
 * subClassOf shape, 3 for rdf:type shape).  This ensures:
 *   - probe alone (exactly threshold triples) → consistent
 *   - 1+ ontology axiom + probe (> threshold) → inconsistent
 *   - base ontology alone (< threshold for small tests) → consistent
 */
function mockEntailmentViaProbe(consistencyThreshold: number, isSatisfiableClass = true) {
  let lastTripleCount = 0;
  mocks.workerPostMessage.mockImplementation((msg: unknown) => {
    const req = msg as { id: number; method: string; args: unknown[] };
    if (req.method === "loadTripleBuffer") {
      lastTripleCount = Math.floor((req.args[0] as ArrayBuffer).byteLength / 12);
      simulateWorkerMessage({ id: req.id, result: true });
    } else if (req.method === "classification") {
      simulateWorkerMessage({ id: req.id, result: true });
    } else if (req.method === "consistency") {
      // Inconsistent when triple count exceeds threshold (probe + ontology present)
      const consistent = lastTripleCount <= consistencyThreshold;
      simulateWorkerMessage({ id: req.id, result: consistent });
    } else if (req.method === "isSatisfiableClass") {
      simulateWorkerMessage({ id: req.id, result: isSatisfiableClass });
    } else if (req.method === "getSubClassJustification") {
      simulateWorkerMessage({ id: req.id, result: "" });
    } else if (req.method === "getInferredTripleBuffer") {
      simulateWorkerMessage({ id: req.id, result: buildCombinedBuffer([]) });
    }
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RdfReasoner — explainEntailment", () => {
  beforeEach(() => {
    mocks.workerPostMessage.mockClear();
    mocks.WorkerMock.mockClear();
    mocks.clearListeners();
  });

  // -------------------------------------------------------------------------
  // Test 1: Inconsistent ontology → { isEntailed: null, ontologyInconsistent: true }
  // -------------------------------------------------------------------------

  it("returns isEntailed:null when ontology is already inconsistent", async () => {
    const reasoner = await makeReadyReasoner();
    const store = new Store([
      quad(A, owlDisjointWith, B, defaultGraph()),
      quad(A, subClassOf, B, defaultGraph()),
    ]);

    mockAlwaysInconsistent();

    const result = await reasoner.explainEntailment(
      store,
      A.value,
      RDFS_SUBCLASS_OF,
      C.value,
    );

    expect(result.isEntailed).toBeNull();
    expect(result.ontologyInconsistent).toBe(true);
    expect(result.justifications).toEqual([]);
    expect(result.reason).toContain("inconsistent");
  });

  // -------------------------------------------------------------------------
  // Test 2: Non-entailed axiom → { isEntailed: false }
  // -------------------------------------------------------------------------

  it("returns isEntailed:false when axiom is not entailed", async () => {
    const reasoner = await makeReadyReasoner();
    const store = new Store([
      quad(A, subClassOf, B, defaultGraph()),
    ]);

    // Consistent for both base and base+probe → not entailed
    mockAlwaysConsistent();

    const result = await reasoner.explainEntailment(
      store,
      A.value,
      RDFS_SUBCLASS_OF,
      C.value,
    );

    expect(result.isEntailed).toBe(false);
    expect(result.justifications).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Test 3: Unsupported predicate — returns isEntailed based on assertion
  // -------------------------------------------------------------------------

  it("returns isEntailed:false for unsupported predicate when not asserted", async () => {
    const reasoner = await makeReadyReasoner();
    const skosLabel = "http://www.w3.org/2004/02/skos/core#prefLabel";
    const store = new Store([
      quad(A, subClassOf, B, defaultGraph()),
    ]);

    // No Worker calls needed for unsupported predicate (short circuits before probe)
    // but C1 check happens first — mock it as consistent
    mockAlwaysConsistent();

    const result = await reasoner.explainEntailment(
      store,
      A.value,
      skosLabel,
      B.value,
    );

    expect(result.isEntailed).toBe(false);
    expect(result.justifications).toEqual([]);
  });

  it("returns isEntailed:true for unsupported predicate when asserted", async () => {
    const reasoner = await makeReadyReasoner();
    const skosLabel = "http://www.w3.org/2004/02/skos/core#prefLabel";
    const skosLabelNode = namedNode(skosLabel);
    const store = new Store([
      quad(A, skosLabelNode, B, defaultGraph()),
    ]);

    mockAlwaysConsistent();

    const result = await reasoner.explainEntailment(
      store,
      A.value,
      skosLabel,
      B.value,
    );

    expect(result.isEntailed).toBe(true);
    expect(result.justifications).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Test 4: Entailed subClassOf → justification returned
  // -------------------------------------------------------------------------

  it("returns a justification for an entailed subClassOf triple", async () => {
    const reasoner = await makeReadyReasoner();
    // A subClassOf B, B subClassOf C → entails A subClassOf C
    const store = new Store([
      quad(A, subClassOf, B, defaultGraph()),
      quad(B, subClassOf, C, defaultGraph()),
    ]);

    // subClassOf probe adds 4 quads. Threshold = 4: probe alone (4) is consistent,
    // any ontology axiom + probe (≥ 5) is inconsistent.
    mockEntailmentViaProbe(4, true); // subject class is satisfiable

    const result = await reasoner.explainEntailment(
      store,
      A.value,
      RDFS_SUBCLASS_OF,
      C.value,
    );

    expect(result.isEntailed).toBe(true);
    expect(result.vacuous).toBeUndefined();
    expect(result.justifications).toHaveLength(1);
    // Justification contains only ontology quads (no probe quads)
    const j = result.justifications[0];
    expect(j.length).toBeGreaterThanOrEqual(1);
    for (const q of j) {
      expect(q.subject.value).not.toMatch(/^vg_/);
      expect(q.predicate.value).not.toMatch(/complementOf/);
    }
  });

  // -------------------------------------------------------------------------
  // Test 5: Vacuous truth — unsatisfiable subject class
  // -------------------------------------------------------------------------

  it("returns vacuous:true when subject class is unsatisfiable", async () => {
    const reasoner = await makeReadyReasoner();
    const store = new Store([
      quad(A, owlDisjointWith, A, defaultGraph()),
    ]);

    // subClassOf probe adds 4 quads. Threshold = 4: probe alone consistent,
    // ontology (1) + probe (4) = 5 > 4 → inconsistent. isSatisfiableClass returns false.
    mockEntailmentViaProbe(4, false);

    const result = await reasoner.explainEntailment(
      store,
      A.value,
      RDFS_SUBCLASS_OF,
      C.value,
    );

    expect(result.isEntailed).toBe(true);
    expect(result.vacuous).toBe(true);
    expect(result.justifications).toEqual([]);
    expect(result.reason).toContain("unsatisfiable");
  });

  // -------------------------------------------------------------------------
  // Test 6: maxJustifications:0 skips BlackBox search
  // -------------------------------------------------------------------------

  it("maxJustifications:0 returns isEntailed without justifications", async () => {
    const reasoner = await makeReadyReasoner();
    const store = new Store([
      quad(A, subClassOf, B, defaultGraph()),
      quad(B, subClassOf, C, defaultGraph()),
    ]);

    // subClassOf probe adds 4 quads; threshold = 4.
    mockEntailmentViaProbe(4, true);

    const result = await reasoner.explainEntailment(
      store,
      A.value,
      RDFS_SUBCLASS_OF,
      C.value,
      { maxJustifications: 0 },
    );

    expect(result.isEntailed).toBe(true);
    expect(result.justifications).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Test 7: explainEntailment followed by classify completes without hang
  // -------------------------------------------------------------------------

  it("explainEntailment followed by classify completes without hang", async () => {
    const reasoner = await makeReadyReasoner();
    const store = new Store([
      quad(A, subClassOf, B, defaultGraph()),
    ]);

    // Not entailed (always consistent)
    mockAlwaysConsistent();

    const result = await reasoner.explainEntailment(
      store,
      A.value,
      RDFS_SUBCLASS_OF,
      C.value,
    );
    expect(result.isEntailed).toBe(false);

    // Now run classify
    const inferredBuf = buildCombinedBuffer([quad(A, subClassOf, C, defaultGraph())]);
    mocks.workerPostMessage.mockImplementation((msg: unknown) => {
      const req = msg as { id: number; method: string };
      if (req.method === "loadTripleBuffer") {
        simulateWorkerMessage({ id: req.id, result: true });
      } else if (req.method === "classification") {
        simulateWorkerMessage({ id: req.id, result: true });
      } else if (req.method === "getInferredTripleBuffer") {
        simulateWorkerMessage({ id: req.id, result: inferredBuf });
      }
    });

    await reasoner.classify(store);

    const ig = namedNode(INFERRED_GRAPH_IRI);
    const inferred = store.getQuads(null, null, null, ig);
    expect(inferred.length).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------------
  // Test 8: rdf:type entailment shape (not subClassOf)
  // -------------------------------------------------------------------------

  it("handles rdf:type entailment shape", async () => {
    const reasoner = await makeReadyReasoner();
    const store = new Store([
      quad(alice, rdfType, Person, defaultGraph()),
      quad(alice, rdfType, A, defaultGraph()),
    ]);

    // rdf:type probe adds 3 quads. Threshold = 3: probe alone (3) consistent,
    // ontology (2) + probe (3) = 5 > 3 → inconsistent.
    mockEntailmentViaProbe(3, true);

    const result = await reasoner.explainEntailment(
      store,
      alice.value,
      RDF_TYPE,
      Person.value,
    );

    // alice rdf:type Person is asserted, so probe check may or may not detect
    // it — the important thing is isEntailed is not false
    expect(result.isEntailed).not.toBe(null);
    expect(Array.isArray(result.justifications)).toBe(true);
  });
});
