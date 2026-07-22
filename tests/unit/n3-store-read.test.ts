/**
 * Tests for direct N3 Store reading — encodeStoreToBuffers and
 * computeStoreFingerprintDirect produce identical output to the
 * existing getQuads()-based paths.
 */

import { describe, it, expect } from "vitest";
import { Store, DataFactory } from "n3";
import {
  fromN3EntityKey,
  encodeStoreToBuffers,
  computeStoreFingerprintDirect,
} from "../../ts/n3Inject.js";
import {
  encodeToBuffers,
  decodeBuffers,
  computeStoreFingerprint,
} from "../../ts/intern.js";
import { INFERRED_GRAPH_IRI, EXPLANATION_GRAPH_IRI } from "../../ts/types.js";

const { namedNode, blankNode, literal, quad, defaultGraph } = DataFactory;

describe("fromN3EntityKey", () => {
  it("round-trips NamedNode", () => {
    const r = fromN3EntityKey("http://example.org/Foo");
    expect(r).toEqual({ raw: "http://example.org/Foo", type: 0 });
  });

  it("round-trips BlankNode", () => {
    const r = fromN3EntityKey("_:b0");
    expect(r).toEqual({ raw: "b0", type: 1 });
  });

  it("round-trips literal with language", () => {
    const r = fromN3EntityKey('"hello"@en');
    expect(r).toEqual({ raw: "hello\0\0en", type: 2 });
  });

  it("round-trips literal with datatype", () => {
    const r = fromN3EntityKey('"30"^^http://www.w3.org/2001/XMLSchema#integer');
    expect(r).toEqual({ raw: "30\0http://www.w3.org/2001/XMLSchema#integer\0", type: 2 });
  });

  it("round-trips plain literal", () => {
    const r = fromN3EntityKey('"plain"');
    expect(r).toEqual({ raw: "plain\0\0", type: 2 });
  });

  it("round-trips empty string NamedNode", () => {
    const r = fromN3EntityKey("");
    expect(r).toEqual({ raw: "", type: 0 });
  });
});

describe("encodeStoreToBuffers", () => {
  it("produces identical decoded quads to encodeToBuffers for simple triples", () => {
    const store = new Store();
    store.addQuad(quad(namedNode("ex:Alice"), namedNode("ex:knows"), namedNode("ex:Bob")));
    store.addQuad(quad(namedNode("ex:Bob"), namedNode("ex:age"), literal("30", namedNode("http://www.w3.org/2001/XMLSchema#integer"))));
    store.addQuad(quad(blankNode("b0"), namedNode("ex:label"), literal("hello", "en")));

    const allQuads = store.getQuads(null, null, null, null);
    const refBufs = encodeToBuffers(allQuads);
    const testBufs = encodeStoreToBuffers(store);

    const refDecoded = decodeBuffers(combineBufs(refBufs));
    const testDecoded = decodeBuffers(combineBufs(testBufs));

    expect(testDecoded.length).toBe(refDecoded.length);
    for (const rq of refDecoded as any[]) {
      const found = (testDecoded as any[]).some(
        (tq: any) => tq.subject.value === rq.subject.value &&
              tq.predicate.value === rq.predicate.value &&
              tq.object.value === rq.object.value,
      );
      expect(found, `Missing: ${rq.subject.value} ${rq.predicate.value} ${rq.object.value}`).toBe(true);
    }
  });

  it("excludes inferred and explanation graphs", () => {
    const store = new Store();
    store.addQuad(quad(namedNode("ex:A"), namedNode("ex:B"), namedNode("ex:C")));
    store.addQuad(quad(namedNode("ex:X"), namedNode("ex:Y"), namedNode("ex:Z"), namedNode(INFERRED_GRAPH_IRI)));
    store.addQuad(quad(namedNode("ex:J"), namedNode("ex:K"), namedNode("ex:L"), namedNode(EXPLANATION_GRAPH_IRI)));

    const testBufs = encodeStoreToBuffers(store);
    const testDecoded = decodeBuffers(combineBufs(testBufs));

    expect((testDecoded as any[]).length).toBe(1);
    expect((testDecoded as any[])[0].subject.value).toBe("ex:A");
  });

  it("handles named graphs (non-excluded)", () => {
    const store = new Store();
    const g = namedNode("urn:my:graph");
    store.addQuad(quad(namedNode("ex:A"), namedNode("ex:B"), namedNode("ex:C"), g));
    store.addQuad(quad(namedNode("ex:D"), namedNode("ex:E"), namedNode("ex:F")));

    const allQuads = store.getQuads(null, null, null, null);
    const refBufs = encodeToBuffers(allQuads);
    const testBufs = encodeStoreToBuffers(store);

    const refDecoded = decodeBuffers(combineBufs(refBufs));
    const testDecoded = decodeBuffers(combineBufs(testBufs));

    expect(testDecoded.length).toBe(refDecoded.length);
  });

  it("handles empty store", () => {
    const store = new Store();
    const testBufs = encodeStoreToBuffers(store);
    const testDecoded = decodeBuffers(combineBufs(testBufs));
    expect((testDecoded as any[]).length).toBe(0);
  });

  it("handles literals with special characters", () => {
    const store = new Store();
    store.addQuad(quad(
      namedNode("ex:A"),
      namedNode("ex:desc"),
      literal('line1\nline2\r"quoted"\\slash'),
    ));

    const allQuads = store.getQuads(null, null, null, null);
    const refBufs = encodeToBuffers(allQuads);
    const testBufs = encodeStoreToBuffers(store);

    const refDecoded = decodeBuffers(combineBufs(refBufs));
    const testDecoded = decodeBuffers(combineBufs(testBufs));

    expect((testDecoded as any[])[0].object.value).toBe((refDecoded as any[])[0].object.value);
  });
});

describe("computeStoreFingerprintDirect", () => {
  it("produces identical hash to computeStoreFingerprint", () => {
    const store = new Store();
    store.addQuad(quad(namedNode("ex:Alice"), namedNode("ex:knows"), namedNode("ex:Bob")));
    store.addQuad(quad(namedNode("ex:Bob"), namedNode("ex:age"), literal("30", namedNode("http://www.w3.org/2001/XMLSchema#integer"))));
    store.addQuad(quad(blankNode("b0"), namedNode("ex:label"), literal("hello", "en")));

    const allQuads = store.getQuads(null, null, null, null);
    const refHash = computeStoreFingerprint(allQuads);
    const testHash = computeStoreFingerprintDirect(store);

    expect(testHash).toBe(refHash);
  });

  it("excludes inferred/hypothetical/explanation graphs (same as computeStoreFingerprint)", () => {
    const store = new Store();
    store.addQuad(quad(namedNode("ex:A"), namedNode("ex:B"), namedNode("ex:C")));
    store.addQuad(quad(namedNode("ex:X"), namedNode("ex:Y"), namedNode("ex:Z"), namedNode(INFERRED_GRAPH_IRI)));
    store.addQuad(quad(namedNode("ex:J"), namedNode("ex:K"), namedNode("ex:L"), namedNode(EXPLANATION_GRAPH_IRI)));

    const allQuads = store.getQuads(null, null, null, null);
    const refHash = computeStoreFingerprint(allQuads);
    const testHash = computeStoreFingerprintDirect(store);

    expect(testHash).toBe(refHash);
  });

  it("empty store", () => {
    const store = new Store();
    const allQuads = store.getQuads(null, null, null, null);
    expect(computeStoreFingerprintDirect(store)).toBe(computeStoreFingerprint(allQuads));
  });

  it("handles literals with special characters in fingerprint", () => {
    const store = new Store();
    store.addQuad(quad(
      namedNode("ex:A"),
      namedNode("ex:desc"),
      literal('line1\nline2\r"quoted"\\slash'),
    ));

    const allQuads = store.getQuads(null, null, null, null);
    expect(computeStoreFingerprintDirect(store)).toBe(computeStoreFingerprint(allQuads));
  });
});

function combineBufs(bufs: { tripleBuffer: ArrayBuffer; strTableBuffer: ArrayBuffer }): ArrayBuffer {
  const strLen = bufs.strTableBuffer.byteLength;
  const combined = new ArrayBuffer(4 + strLen + bufs.tripleBuffer.byteLength);
  const dv = new DataView(combined);
  dv.setUint32(0, strLen, true);
  new Uint8Array(combined, 4, strLen).set(new Uint8Array(bufs.strTableBuffer));
  new Uint8Array(combined, 4 + strLen).set(new Uint8Array(bufs.tripleBuffer));
  return combined;
}
