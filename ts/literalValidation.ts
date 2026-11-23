/**
 * Lexical and value-range checks for typed literals, run before the ontology reaches the kernel.
 *
 * The kernel's literal parsers return null on a failed parse and the literal is dropped, so an ill-typed literal
 * ("5abc"^^xsd:integer, "1.5"^^xsd:integer, "abc"^^xsd:float) or an integer beyond 64 bits silently makes no difference to the
 * result. This module finds them so the caller can report or reject them (RdfReasonerOptions.illTypedLiterals).
 * Covers the numeric and boolean XSD datatypes; other datatypes are not checked.
 */
import type { Quad } from "@rdfjs/types";

const XSD = "http://www.w3.org/2001/XMLSchema#";

export interface LiteralIssue {
  subject: string;
  predicate: string;
  lexical: string;
  datatype: string;
  reason: "ill-typed" | "out-of-range" | "beyond-kernel-integers";
  detail: string;
}

const I64_MIN = -(2n ** 63n), U64_MAX = 2n ** 64n - 1n;
/** Value bounds of the integer-derived datatypes (inclusive); undefined = unbounded. */
const BOUNDS: Record<string, [bigint | undefined, bigint | undefined]> = {
  byte: [-128n, 127n], short: [-32768n, 32767n], int: [-(2n ** 31n), 2n ** 31n - 1n], long: [I64_MIN, 2n ** 63n - 1n],
  unsignedByte: [0n, 255n], unsignedShort: [0n, 65535n], unsignedInt: [0n, 2n ** 32n - 1n], unsignedLong: [0n, U64_MAX],
  nonNegativeInteger: [0n, undefined], positiveInteger: [1n, undefined], nonPositiveInteger: [undefined, 0n], negativeInteger: [undefined, -1n],
  integer: [undefined, undefined],
};
const DECIMAL = /^[+-]?(\d+(\.\d*)?|\.\d+)$/;
const FLOATING = /^([+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?|[+-]?INF|NaN)$/;

/** The issue of a typed literal, or null when it is fine (or its datatype is not checked). */
export function literalIssue(lexical: string, datatype: string): Pick<LiteralIssue, "reason" | "detail"> | null {
  if (!datatype.startsWith(XSD)) return null;
  const name = datatype.slice(XSD.length);
  const v = lexical.trim(); // whiteSpace=collapse for these datatypes
  if (name in BOUNDS) {
    if (!/^[+-]?\d+$/.test(v)) return { reason: "ill-typed", detail: "not an integer lexical form" };
    const n = BigInt(v);
    const [lo, hi] = BOUNDS[name]!;
    if ((lo !== undefined && n < lo) || (hi !== undefined && n > hi)) return { reason: "out-of-range", detail: `outside the value space of xsd:${name}` };
    if (n < I64_MIN || n > U64_MAX) return { reason: "beyond-kernel-integers", detail: "beyond the 64-bit integers the kernel represents; the literal is ignored" };
    return null;
  }
  if (name === "decimal") return DECIMAL.test(v) ? null : { reason: "ill-typed", detail: "not a decimal lexical form" };
  if (name === "float" || name === "double") return FLOATING.test(v) ? null : { reason: "ill-typed", detail: `not a ${name} lexical form` };
  if (name === "boolean") return /^(true|false|1|0)$/.test(v) ? null : { reason: "ill-typed", detail: "not a boolean lexical form" };
  return null;
}

/** All issues in `quads` (at most `limit` are returned; `total` counts every one). */
export function findLiteralIssues(quads: Iterable<Quad>, limit = 100): { issues: LiteralIssue[]; total: number } {
  const issues: LiteralIssue[] = [];
  let total = 0;
  for (const q of quads) {
    if (q.object.termType !== "Literal") continue;
    const dt = (q.object as { datatype?: { value: string } }).datatype?.value;
    if (!dt || !dt.startsWith(XSD)) continue;
    const issue = literalIssue(q.object.value, dt);
    if (!issue) continue;
    total++;
    if (issues.length < limit) issues.push({ subject: q.subject.value, predicate: q.predicate.value, lexical: q.object.value, datatype: dt, ...issue });
  }
  return { issues, total };
}
