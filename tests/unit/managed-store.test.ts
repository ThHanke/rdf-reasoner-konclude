/**
 * Unit tests for createManagedStore() — verifies that the proxy blocks
 * external writes to INFERRED_GRAPH_IRI, EXPLANATION_GRAPH_IRI, and
 * HYPOTHETICAL_IRI while allowing all other operations.
 */

import { describe, it, expect } from "vitest";
import { Store, DataFactory } from "n3";
import { createManagedStore, getRawStore } from "../../ts/n3Inject.js";
import { INFERRED_GRAPH_IRI, EXPLANATION_GRAPH_IRI, HYPOTHETICAL_IRI } from "../../ts/types.js";

const { namedNode, quad, literal } = DataFactory;
const S = namedNode("http://example.org/s");
const P = namedNode("http://example.org/p");
const O = namedNode("http://example.org/o");

const MANAGED = [INFERRED_GRAPH_IRI, EXPLANATION_GRAPH_IRI, HYPOTHETICAL_IRI] as const;

describe("createManagedStore", () => {
  it("getRawStore returns the original Store", () => {
    const store = new Store();
    const managed = createManagedStore(store);
    expect(getRawStore(managed)).toBe(store);
  });

  it("getRawStore on a plain Store returns the store itself", () => {
    const store = new Store();
    expect(getRawStore(store)).toBe(store);
  });

  it("reads pass through unchanged", () => {
    const store = new Store();
    store.addQuad(quad(S, P, O, namedNode("http://example.org/my-graph")));
    const managed = createManagedStore(store);
    expect(managed.size).toBe(1);
    expect(managed.getQuads(null, null, null, null)).toHaveLength(1);
  });

  it("writes to non-managed graphs pass through", () => {
    const store = new Store();
    const managed = createManagedStore(store);
    const g = namedNode("http://example.org/ontology");
    managed.addQuad(quad(S, P, O, g));
    expect(store.size).toBe(1);
  });

  for (const graphIri of MANAGED) {
    describe(`managed graph: ${graphIri}`, () => {
      it("addQuad throws", () => {
        const managed = createManagedStore(new Store());
        expect(() =>
          managed.addQuad(quad(S, P, O, namedNode(graphIri)))
        ).toThrow(RangeError);
      });

      it("add throws", () => {
        const managed = createManagedStore(new Store());
        expect(() =>
          managed.add(quad(S, P, O, namedNode(graphIri)))
        ).toThrow(RangeError);
      });

      it("removeQuad throws", () => {
        const managed = createManagedStore(new Store());
        expect(() =>
          managed.removeQuad(quad(S, P, O, namedNode(graphIri)))
        ).toThrow(RangeError);
      });

      it("removeQuads throws when any quad targets managed graph", () => {
        const managed = createManagedStore(new Store());
        const safeQuad = quad(S, P, O, namedNode("http://example.org/safe"));
        const badQuad = quad(S, P, O, namedNode(graphIri));
        expect(() => managed.removeQuads([safeQuad, badQuad])).toThrow(RangeError);
      });

      it("deleteGraph throws", () => {
        const managed = createManagedStore(new Store());
        expect(() => managed.deleteGraph(namedNode(graphIri))).toThrow(RangeError);
        expect(() => managed.deleteGraph(graphIri)).toThrow(RangeError);
      });

      it("removeMatches throws for explicit managed graph", () => {
        const managed = createManagedStore(new Store());
        expect(() =>
          managed.removeMatches(null, null, null, namedNode(graphIri))
        ).toThrow(RangeError);
      });

      it("removeMatches with null graph (wildcard) is allowed", () => {
        const managed = createManagedStore(new Store());
        expect(() =>
          managed.removeMatches(null, null, null, null)
        ).not.toThrow();
      });
    });
  }

  it("rawStore bypasses the guard (reasoner write path)", () => {
    const store = new Store();
    const managed = createManagedStore(store);
    const raw = getRawStore(managed);
    // Raw store can write to managed graph — this is what the reasoner does
    raw.addQuad(quad(S, P, O, namedNode(INFERRED_GRAPH_IRI)));
    expect(store.size).toBe(1);
    // The proxy still blocks the same quad from external callers
    expect(() =>
      managed.addQuad(quad(S, P, O, namedNode(INFERRED_GRAPH_IRI)))
    ).toThrow(RangeError);
  });
});
