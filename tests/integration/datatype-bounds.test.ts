/**
 * Integration test: value-space bounds of the XSD integer datatypes and double/float lexical forms.
 *
 * `checkConsistency` of  `:p rdfs:range <dt> . :a :p "<lexical>"^^<dt>`.
 *  - "bounds": every datatype minimum and maximum is accepted, one beyond is rejected. Upstream Konclude defined the
 *    minimum of byte, short and int one too high (-127, -32767, -2147483647); patch 006 fixes it.
 *  - "known gaps": ill-typed literals ("5abc", "1.5" as xsd:integer, hex floats, ...) and integers beyond 64 bits are
 *    silently dropped by the kernel's literal parsers instead of making the ontology inconsistent. The test pins the
 *    current (wrong) verdict so a fix, expected in ts/inputNormalize.ts before the kernel sees the literal, flips it.
 * One shared reasoner for the file.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { Parser, Store } from "n3";

import { RdfReasoner } from "../../ts/index.js";

const wasmExists = existsSync(new URL("../../dist/konclude.wasm", import.meta.url).pathname);
const XSD = "http://www.w3.org/2001/XMLSchema#";
const ontology = (dt: string, lexical: string) =>
  new Store(
    new Parser().parse(`@prefix : <http://ex.org/> . @prefix owl: <http://www.w3.org/2002/07/owl#> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
:p a owl:DatatypeProperty ; rdfs:range <${XSD}${dt}> . :a a owl:NamedIndividual ; :p "${lexical}"^^<${XSD}${dt}> .`),
  );

const bounds: [string, string, boolean][] = [
  ["byte", "-128", true], ["byte", "-129", false], ["byte", "127", true], ["byte", "128", false],
  ["short", "-32768", true], ["short", "-32769", false], ["short", "32767", true], ["short", "32768", false],
  ["int", "-2147483648", true], ["int", "-2147483649", false], ["int", "2147483647", true], ["int", "2147483648", false],
  ["long", "-9223372036854775808", true], ["long", "-9223372036854775809", false],
  ["long", "9223372036854775807", true], ["long", "9223372036854775808", false],
  ["unsignedByte", "0", true], ["unsignedByte", "-1", false], ["unsignedByte", "255", true], ["unsignedByte", "256", false],
  ["unsignedInt", "4294967295", true], ["unsignedInt", "4294967296", false],
  ["unsignedLong", "18446744073709551615", true],
  ["negativeInteger", "-1", true], ["negativeInteger", "0", false],
  ["nonPositiveInteger", "0", true], ["nonPositiveInteger", "1", false],
  ["integer", "+5", true], ["integer", " 5", true],
  ["double", "INF", true], ["double", "-INF", true], ["double", "NaN", true], ["float", "1e39", true],
];

// current verdicts of the kernel for literals that should be rejected (see header)
const knownGaps: [string, string, string][] = [
  ["integer", "5abc", "ill-typed: trailing garbage"],
  ["integer", "1.5", "ill-typed: decimal point"],
  ["integer", "0x10", "ill-typed: hex"],
  ["integer", "", "ill-typed: empty"],
  ["unsignedLong", "18446744073709551616", "beyond 64 bits"],
  ["double", "1.5abc", "ill-typed: trailing garbage"],
  ["double", "0x1p3", "ill-typed: hex float"],
  ["double", "infinity", "ill-typed: word"],
  ["float", "abc", "ill-typed"],
];

describe.skipIf(!wasmExists)("XSD datatype bounds and lexical forms", () => {
  let reasoner: RdfReasoner;
  beforeAll(async () => {
    reasoner = new RdfReasoner();
    await reasoner.ready;
  }, 60_000);
  afterAll(() => reasoner?.terminate());

  describe("bounds", () => {
    for (const [dt, lex, ok] of bounds) {
      it(`xsd:${dt} "${lex}" is ${ok ? "inside" : "outside"} the value space`, async () => {
        expect(await reasoner.checkConsistency(ontology(dt, lex))).toBe(ok);
      }, 60_000);
    }
  });

  describe("known gaps (kernel drops the literal: wrong 'consistent')", () => {
    for (const [dt, lex, why] of knownGaps) {
      it(`KNOWN GAP xsd:${dt} ${JSON.stringify(lex)} (${why}) should be inconsistent, is consistent`, async () => {
        expect(await reasoner.checkConsistency(ontology(dt, lex))).toBe(true);
      }, 60_000);
    }
  });
});
