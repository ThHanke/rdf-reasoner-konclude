import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { expect } from "vitest";
import type { Quad } from "@rdfjs/types";

const __dirname = dirname(fileURLToPath(import.meta.url));

function quadToNTriple(q: Quad): string | null {
  if (
    q.subject.termType !== "NamedNode" ||
    q.predicate.termType !== "NamedNode" ||
    q.object.termType !== "NamedNode"
  ) {
    return null;
  }
  return `<${q.subject.value}> <${q.predicate.value}> <${q.object.value}> .`;
}

function loadNativeFixture(fixtureFile: string): string[] {
  const raw = readFileSync(join(__dirname, "../fixtures", fixtureFile), "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function filterWasmQuads(wasm: Quad[], predicates: string[]): string[] {
  const predSet = new Set(predicates);
  const result: string[] = [];
  for (const q of wasm) {
    if (!predSet.has(q.predicate.value)) continue;
    const nt = quadToNTriple(q);
    if (nt !== null) result.push(nt);
  }
  return result;
}

function buildMismatchMessage(
  onlyInNative: string[],
  onlyInWasm: string[],
): string {
  return (
    `Mismatch:\n` +
    `Only in native (${onlyInNative.length} missing from WASM): ${JSON.stringify(onlyInNative)}\n` +
    `Only in WASM (${onlyInWasm.length} extra in WASM): ${JSON.stringify(onlyInWasm)}`
  );
}

function computeDiff(
  sortedWasm: string[],
  sortedNative: string[],
): { onlyInNative: string[]; onlyInWasm: string[] } {
  const wasmSet = new Set(sortedWasm);
  const nativeSet = new Set(sortedNative);
  const onlyInNative = sortedNative.filter((t) => !wasmSet.has(t));
  const onlyInWasm = sortedWasm.filter((t) => !nativeSet.has(t));
  return { onlyInNative, onlyInWasm };
}

/**
 * Asserts WASM output exactly matches native fixture for the given predicates.
 * On mismatch, reports "only in native: [...]" and "only in WASM: [...]".
 */
export function assertExactMatch(
  wasm: Quad[],
  fixtureFile: string,
  predicates: string[],
): void {
  const wasmTriples = filterWasmQuads(wasm, predicates).sort();
  const nativeTriples = loadNativeFixture(fixtureFile).sort();

  if (wasmTriples.join("\n") !== nativeTriples.join("\n")) {
    const { onlyInNative, onlyInWasm } = computeDiff(wasmTriples, nativeTriples);
    throw new Error(buildMismatchMessage(onlyInNative, onlyInWasm));
  }

  expect(wasmTriples).toEqual(nativeTriples);
}

/**
 * Asserts WASM output is a superset of the native fixture for the given predicates.
 * Fails only when WASM is MISSING triples that native has. Extra WASM triples are
 * allowed — valid OWL2-DL inferences may exceed native Konclude's output.
 */
export function assertNativeIsSubset(
  wasm: Quad[],
  fixtureFile: string,
  predicates: string[],
): void {
  const wasmTriples = new Set(filterWasmQuads(wasm, predicates));
  const nativeTriples = loadNativeFixture(fixtureFile);

  const onlyInNative = nativeTriples.filter((t) => !wasmTriples.has(t));
  if (onlyInNative.length > 0) {
    throw new Error(
      `WASM missing ${onlyInNative.length} triples that native Konclude produced:\n` +
        JSON.stringify(onlyInNative),
    );
  }

  expect(onlyInNative).toHaveLength(0);
}

/**
 * Same as assertExactMatch but excludes specific NTriples strings from BOTH sets
 * before comparing.
 */
export function assertMatchExcluding(
  wasm: Quad[],
  fixtureFile: string,
  predicates: string[],
  exclude: string[],
): void {
  const excludeSet = new Set(exclude);

  const wasmTriples = filterWasmQuads(wasm, predicates)
    .filter((t) => !excludeSet.has(t))
    .sort();

  const nativeTriples = loadNativeFixture(fixtureFile)
    .filter((t) => !excludeSet.has(t))
    .sort();

  if (wasmTriples.join("\n") !== nativeTriples.join("\n")) {
    const { onlyInNative, onlyInWasm } = computeDiff(wasmTriples, nativeTriples);
    throw new Error(buildMismatchMessage(onlyInNative, onlyInWasm));
  }

  expect(wasmTriples).toEqual(nativeTriples);
}
