import { describe, it, expect } from "vitest";
import { DataFactory } from "n3";
// @ts-expect-error plain ESM module without types
import { compareRoleAssertions } from "../bench/equivalence.mjs";

const { namedNode: n, quad: q } = DataFactory;
const NS = "http://ex/";
const OWL = "http://www.w3.org/2002/07/owl#";
const role = (s: string, p: string, o: string) => q(n(NS + s), n(NS + p), n(NS + o));

describe("role-assertion equivalence", () => {
  const input = [q(n(NS + "hasChild"), n(OWL + "equivalentProperty"), n(NS + "isParentOf")), q(n(NS + "hasParent"), n(OWL + "inverseOf"), n(NS + "isParentOf"))];

  it("treats hasChild(x,y) and isParentOf(x,y) as equal for equivalent roles", () => {
    const r = compareRoleAssertions([role("x", "hasChild", "y")], [role("x", "isParentOf", "y")], input);
    expect(r.rawDiff).toBe(2);
    expect(r.normalisedDiff).toBe(0);
  });
  it("treats an inverse assertion hasParent(y,x) as equal to isParentOf(x,y)", () => {
    const r = compareRoleAssertions([role("x", "isParentOf", "y")], [role("y", "hasParent", "x")], input);
    expect(r.normalisedDiff).toBe(0);
  });
  it("reports a genuinely missing assertion", () => {
    const r = compareRoleAssertions([role("x", "hasChild", "y"), role("x", "hasChild", "z")], [role("x", "isParentOf", "y")], input);
    expect(r.normalisedDiff).toBe(1);
    expect(r.onlyA).toBe(1);
  });
  it("falls back to raw comparison without equivalence axioms", () => {
    const r = compareRoleAssertions([role("x", "hasChild", "y")], [role("x", "isParentOf", "y")], []);
    expect(r.normalisedDiff).toBe(2);
  });
});
