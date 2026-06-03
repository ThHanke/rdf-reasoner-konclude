/**
 * Integration test: OWL 2 DL parity suite
 *
 * Verifies that the WASM reasoning kernel produces correct OWL 2 DL entailments
 * for a range of expressive constructs.  Fixture ontologies live in
 * `tests/fixtures/owl2dl/` as Turtle files.
 *
 * These tests require the built WASM binary (`dist/konclude.wasm`).  When the
 * binary is absent the entire suite is skipped so that `vitest run tests/unit/`
 * continues to pass cleanly.
 */

import { describe, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { Parser } from "n3";
import type { Quad } from "@rdfjs/types";

import { RdfReasoner } from "../../ts/index.js"; // used by subsequent test units

// ---------------------------------------------------------------------------
// WASM availability guard
// ---------------------------------------------------------------------------

const wasmPath = new URL("../../dist/konclude.wasm", import.meta.url).pathname;
const wasmExists = existsSync(wasmPath);

// ---------------------------------------------------------------------------
// Common IRI constants
// ---------------------------------------------------------------------------

const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const RDFS_SUB_CLASS_OF = "http://www.w3.org/2000/01/rdf-schema#subClassOf";
const RDFS_SUB_PROPERTY_OF = "http://www.w3.org/2000/01/rdf-schema#subPropertyOf";
const OWL_SAME_AS = "http://www.w3.org/2002/07/owl#sameAs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseTurtle(content: string): Quad[] {
  const parser = new Parser({ format: "Turtle" });
  const quads: Quad[] = [];
  parser.parse(content, (err, quad) => {
    if (err) throw err;
    if (quad) quads.push(quad as Quad);
  });
  return quads;
}

function hasTriple(quads: Quad[], s: string, p: string, o: string): boolean {
  return quads.some(
    (q) =>
      q.subject.value === s &&
      q.predicate.value === p &&
      q.object.value === o,
  );
}

const EX = (local: string) => `http://example.org/${local}`;

function loadTtl(name: string): Quad[] {
  const fixturePath = new URL(
    `../../tests/fixtures/owl2dl/${name}`,
    import.meta.url,
  ).pathname;
  const content = readFileSync(fixturePath, "utf-8");
  return parseTurtle(content);
}

// ---------------------------------------------------------------------------
// Suite (skipped when WASM is absent)
// ---------------------------------------------------------------------------

describe.skipIf(!wasmExists)("OWL 2 DL parity", () => {
  it.todo("test cases added in subsequent units");
});
