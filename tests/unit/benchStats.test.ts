import { describe, it, expect } from "vitest";
// @ts-expect-error plain ESM module without types
import { median, summarize, fmtStat } from "../bench/stats.mjs";

describe("bench stats", () => {
  it("summarises [100, 110, 120] and flags spread above 10%", () => {
    const s = summarize([100, 110, 120]);
    expect(s).toMatchObject({ n: 3, min: 100, median: 110, max: 120, spreadPct: 18, noisy: true, indicative: true });
  });
  it("does not flag spread at or below 10%", () => {
    expect(summarize([100, 100, 100, 100, 105])).toMatchObject({ noisy: false, indicative: false });
  });
  it("handles empty and single-sample lists without NaN", () => {
    expect(summarize([])).toBeNull();
    expect(summarize([null, undefined])).toBeNull();
    expect(summarize([42])).toMatchObject({ n: 1, min: 42, median: 42, max: 42, spreadPct: 0, iqr: 0 });
  });
  it("uses the mean of the middle pair for even counts, rounded", () => {
    expect(median([1, 2, 3, 4])).toBe(3);
    expect(median([10, 11])).toBe(11);
  });
  it("formats with markers", () => {
    expect(fmtStat(summarize([100, 110, 120]))).toBe("110 ms [100–120]†‡");
    expect(fmtStat(summarize([7]))).toBe("7 ms‡");
    expect(fmtStat(null)).toBe("—");
  });
});
