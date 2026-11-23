/**
 * Integration test: rdf:XMLLiteral values (W3C miscellaneous-202/-203/-204). The kernel has no XML parser, so the lexical forms are
 * canonicalized in TypeScript (ts/xmlLiteral.ts) and the kernel compares the strings (whitespace is kept: it is significant in XML).
 * A functional property with two XML literals is consistent iff they denote the same XML value. One shared reasoner for the file.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { Store, DataFactory } from "n3";

import { RdfReasoner } from "../../ts/index.js";

const wasmExists = existsSync(new URL("../../dist/konclude.wasm", import.meta.url).pathname);
const { namedNode, literal, quad, blankNode } = DataFactory;
const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#", OWL = "http://www.w3.org/2002/07/owl#";
const XL = namedNode(RDF + "XMLLiteral");

/** One individual with a functional datatype property and the given XML literals as values. */
const withValues = (functional: boolean, ...values: string[]) => {
  const fp = namedNode("http://ex.org/fp"), x = blankNode("t");
  const qs = [quad(fp, namedNode(RDF + "type"), namedNode(OWL + "DatatypeProperty")), quad(x, namedNode(RDF + "type"), namedNode(OWL + "Thing"))];
  if (functional) qs.push(quad(fp, namedNode(RDF + "type"), namedNode(OWL + "FunctionalProperty")));
  for (const v of values) qs.push(quad(x, fp, literal(v, XL)));
  return new Store(qs);
};

describe.skipIf(!wasmExists)("rdf:XMLLiteral", () => {
  let reasoner: RdfReasoner;
  beforeAll(async () => {
    reasoner = new RdfReasoner();
    await reasoner.ready;
  }, 60_000);
  afterAll(() => reasoner?.terminate());

  it("miscellaneous-202: the same XML value in two spellings is one value (consistent)", async () => {
    const a = `<br />\n<img src="vn.png" alt="Venn diagram" longdesc="vn.html" title="Venn"></img>`;
    const b = `<br \n></br>\n<img \nsrc="vn.png" title=\n"Venn" alt\n="Venn diagram" longdesc=\n"vn.html" />`;
    expect(await reasoner.checkConsistency(withValues(true, a, b))).toBe(true);
  }, 60_000);

  it("miscellaneous-203: a leading newline is a different value (inconsistent)", async () => {
    const a = `\n<br />\n<img src="vn.png" alt="Venn diagram" longdesc="vn.html" title="Venn"></img>\n`;
    const b = `<br \n></br>\n<img \nsrc="vn.png" title=\n"Venn" alt\n="Venn diagram" longdesc=\n"vn.html" />\n`;
    expect(await reasoner.checkConsistency(withValues(true, a, b))).toBe(false);
  }, 60_000);

  it("miscellaneous-204: different content (inconsistent)", async () => {
    expect(await reasoner.checkConsistency(withValues(true, `<span xml:lang='en'>\n<b>Good!</b></span>`, `<span xml:lang='en'>\n<b>Bad!</b></span>`))).toBe(false);
  }, 60_000);

  it("two different XML values on a non-functional property stay consistent", async () => {
    expect(await reasoner.checkConsistency(withValues(false, "<a>1</a>", "<a>2</a>"))).toBe(true);
  }, 60_000);

  it("a literal that is not well-formed XML is left as it is and does not break reasoning", async () => {
    expect(await reasoner.checkConsistency(withValues(false, "<a>", "text"))).toBe(true);
  }, 60_000);
});
