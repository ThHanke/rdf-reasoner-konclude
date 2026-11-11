# Release Notes — v0.9.2

## Summary

v0.9.2 is a drop-in release on v0.9.1. It adds one option (`excludeGraphs`), fixes silently missed entailments for anonymous class expressions written with skolem IRIs, and makes the inferred graph self-healing when a caller edits it between calls. The WASM binary is unchanged; only the TypeScript layer differs. Callers that handed the reasoner a rewritten copy of their store (blank nodes restored, non-ontology graphs removed) can now pass the store itself.

## Added

### `new RdfReasoner({ excludeGraphs })`

`excludeGraphs?: Iterable<string>` names graphs that are not ontology content, for example SHACL shapes, provenance or workflow state. For every call on that instance:

- their quads are never sent to the reasoner and never count as store content (editing them does not bump the generation or rebuild the ontology);
- explanations, repairs, `whatIf`, entailment and consistency-guard calls ignore them when they extract axioms;
- a triple that exists only in an excluded graph is still written to the inferred graph (it does not count as "already asserted").

The reasoner's own inferred, hypothetical and explanation graphs are always excluded and need not be listed. Default: none.

## Fixed

### Skolem IRIs now reason like blank nodes

A skolem IRI (`urn:vg:bnode:*`, or an RFC 7511 `/.well-known/genid/` IRI) stands for a blank node. The kernel builds anonymous class expressions only from blank-node terms, so on v0.9.1 a store that kept blank nodes as skolem IRIs lost entailments without any error. Measured on v0.9.1 with one small ontology per construct:

| Construct | blank nodes | skolem IRIs on v0.9.1 |
|---|---|---|
| `someValuesFrom`, `hasValue`, `allValuesFrom` | found | found |
| `minCardinality` | found | missed |
| `intersectionOf`, `unionOf`, `oneOf` | found | missed |
| `complementOf` | found | missed |
| `intersectionOf` with a nested `someValuesFrom` over a `unionOf` | found | missed |

The encoder now sends such IRIs as blank nodes (reversible label), and the decoder restores the original IRI in the output, so asserted and inferred triples attach to the same term. A real blank node in the input stays a blank node in the output. The retag runs once per distinct term, on both encode paths (the direct N3 store path and the quad path); there is no store copy.

Regression test: `tests/integration/skolem-retag.test.ts` (9 constructs x blank node, `urn:vg:bnode:` and genid, plus the round trip).

### Edits to the inferred graph are detected

The inferred graph lives inside the caller's `Store`. On v0.9.1 a repeated `classify` / `materialize` / `classifyProperties` call on unchanged content was a cache hit that left the graph as it was, so quads a caller had added, deleted or swapped in the inferred graph survived, and a call naming a different `inferredGraph` for content already written to the default one wrote nothing. A cache hit now also requires the same inferred graph name and an unchanged signature of that graph (count plus two order-independent 32-bit mixes of the term ids, read from the N3 index without allocating quads; one pass over the graph per call). Otherwise the graph is cleared and refilled, and with `returnDelta` the delta is computed against the graph's actual state. An edit in any other non-excluded graph already changed the content digest.

Regression test: `tests/integration/inferred-graph-validity.test.ts` (4 of its 7 tests fail without the signature check).

## Verification

Full vitest suite on the unchanged WASM: 751 passed, 9 skipped, 0 failed.

## Notes

- Behaviour change: an IRI that contains `/.well-known/genid/` or starts with `urn:vg:bnode:` is now treated as anonymous. Such an IRI used as a deliberately named class or individual would be reasoned about as a blank node and returned unchanged in the output.
- Not changed: the kernel itself (patches 000-004) and the WASM binary.
- Open (not in this release): LUBM-1 with data is bimodal (about 30 s and 80 s) only through the Ontosphere browser integration; the reasoner alone takes about 7 s every time (see the plan `2026-11-10-001` follow-up). It is not a regression: 0.8.0 shows the same.
