import { describe, expect, it } from "vitest";
import { literalIssue, findLiteralIssues } from "../../ts/literalValidation.js";
import { DataFactory } from "n3";

const X = "http://www.w3.org/2001/XMLSchema#";
const ok = (lex: string, dt: string) => expect(literalIssue(lex, X + dt), `${lex}^^${dt}`).toBeNull();
const bad = (lex: string, dt: string, reason: string) => expect(literalIssue(lex, X + dt)?.reason, `${lex}^^${dt}`).toBe(reason);

describe("literalIssue", () => {
  it("accepts valid lexical forms and the datatype bounds", () => {
    for (const [l, d] of [
      ["5", "integer"], ["+5", "integer"], [" 5 ", "integer"], ["-128", "byte"], ["127", "byte"], ["-32768", "short"], ["-2147483648", "int"],
      ["9223372036854775807", "long"], ["-9223372036854775808", "long"], ["18446744073709551615", "unsignedLong"], ["0", "unsignedByte"], ["255", "unsignedByte"],
      ["1", "positiveInteger"], ["0", "nonNegativeInteger"], ["-1", "negativeInteger"], ["0", "nonPositiveInteger"], ["1.5", "decimal"], [".5", "decimal"], ["5.", "decimal"],
      ["1.5", "double"], ["1e10", "double"], ["-1.5E-3", "float"], ["INF", "double"], ["-INF", "float"], ["NaN", "double"], ["true", "boolean"], ["0", "boolean"],
    ] as const) ok(l, d);
  });

  it("flags ill-typed lexical forms", () => {
    for (const [l, d] of [
      ["5abc", "integer"], ["1.5", "integer"], ["0x10", "integer"], ["", "integer"], ["1.5abc", "double"], ["0x1p3", "double"], ["infinity", "double"], ["inf", "double"],
      ["abc", "float"], ["1,5", "decimal"], ["yes", "boolean"],
    ] as const) bad(l, d, "ill-typed");
  });

  it("flags values outside the datatype (one beyond the minimum or maximum)", () => {
    for (const [l, d] of [
      ["128", "byte"], ["-129", "byte"], ["32768", "short"], ["2147483648", "int"], ["9223372036854775808", "long"], ["256", "unsignedByte"], ["-1", "unsignedByte"],
      ["0", "positiveInteger"], ["0", "negativeInteger"], ["1", "nonPositiveInteger"], ["-1", "nonNegativeInteger"], ["18446744073709551616", "unsignedLong"],
    ] as const) bad(l, d, "out-of-range");
  });

  it("flags valid xsd:integer values beyond the kernel's 64 bits", () => {
    bad("18446744073709551616", "integer", "beyond-kernel-integers");
    bad("-9223372036854775809", "integer", "beyond-kernel-integers");
  });

  it("ignores other datatypes", () => {
    expect(literalIssue("anything", X + "string")).toBeNull();
    expect(literalIssue("2020-01-01", X + "date")).toBeNull();
    expect(literalIssue("x", "http://example.org/own")).toBeNull();
  });
});

describe("findLiteralIssues", () => {
  const q = (lex: string, dt: string) =>
    DataFactory.quad(DataFactory.namedNode("http://ex.org/a"), DataFactory.namedNode("http://ex.org/p"), DataFactory.literal(lex, DataFactory.namedNode(X + dt)));

  it("collects issues, counts all, and caps the list", () => {
    const quads = [q("5", "integer"), q("5abc", "integer"), ...Array.from({ length: 5 }, () => q("x", "float"))];
    const r = findLiteralIssues(quads, 3);
    expect(r.total).toBe(6);
    expect(r.issues).toHaveLength(3);
    expect(r.issues[0]).toMatchObject({ lexical: "5abc", reason: "ill-typed" });
  });
});
