/**
 * Integration test: RdfReasoner.illTypedLiterals. The kernel drops ill-typed numeric literals silently; the default
 * "report" lists them in lastLiteralIssues, "error" rejects with InvalidLiteralError, "ignore" does not scan.
 * One shared reasoner for the file (the mode is changed between calls).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { Parser, Store } from "n3";

import { RdfReasoner, InvalidLiteralError } from "../../ts/index.js";

const wasmExists = existsSync(new URL("../../dist/konclude.wasm", import.meta.url).pathname);
const store = (lex: string, dt: string) =>
  new Store(
    new Parser().parse(`@prefix : <http://ex.org/> . @prefix owl: <http://www.w3.org/2002/07/owl#> . @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
:p a owl:DatatypeProperty . :a a owl:NamedIndividual ; :p "${lex}"^^xsd:${dt} .`),
  );

describe.skipIf(!wasmExists)("ill-typed literals", () => {
  let reasoner: RdfReasoner;
  beforeAll(async () => {
    reasoner = new RdfReasoner();
    await reasoner.ready;
  }, 60_000);
  afterAll(() => reasoner?.terminate());

  it("report (default): the issue is listed and reasoning continues with the kernel's verdict", async () => {
    expect(reasoner.illTypedLiterals).toBe("report");
    expect(await reasoner.checkConsistency(store("5abc", "integer"))).toBe(true);
    expect(reasoner.lastLiteralIssues.total).toBe(1);
    expect(reasoner.lastLiteralIssues.issues[0]).toMatchObject({ lexical: "5abc", reason: "ill-typed", predicate: "http://ex.org/p" });
  }, 60_000);

  it("report: a clean store resets the list", async () => {
    await reasoner.checkConsistency(store("5", "integer"));
    expect(reasoner.lastLiteralIssues.total).toBe(0);
  }, 60_000);

  it("error: the call rejects with InvalidLiteralError naming the literal", async () => {
    reasoner.illTypedLiterals = "error";
    try {
      await expect(reasoner.checkConsistency(store("300", "byte"))).rejects.toBeInstanceOf(InvalidLiteralError);
      await expect(reasoner.checkConsistency(store("300", "byte"))).rejects.toThrow(/"300"/);
      expect(await reasoner.checkConsistency(store("127", "byte"))).toBe(true); // a valid literal is fine in error mode
    } finally {
      reasoner.illTypedLiterals = "report";
    }
  }, 60_000);

  it("ignore: no scan, the list stays empty", async () => {
    reasoner.illTypedLiterals = "ignore";
    try {
      await reasoner.checkConsistency(store("5abc", "integer"));
      expect(reasoner.lastLiteralIssues.total).toBe(0);
    } finally {
      reasoner.illTypedLiterals = "report";
    }
  }, 60_000);
});
