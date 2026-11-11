# Release Notes — v0.9.3

## Summary

v0.9.3 fixes a leak in v0.9.2. The public API is unchanged and the WASM binary is unchanged; upgrade is drop-in. v0.9.2 is deprecated on npm.

## Fixed

### Skolem IRI labels leaked into inferred triples (v0.9.2)

v0.9.2 sends skolem IRIs (`urn:vg:bnode:*`, RFC 7511 `/.well-known/genid/`) to the kernel as blank nodes with a reversible wire label (`sk_` plus the hex of the IRI) and restores the original IRI on the way back. The restore only ran for blank-node terms. The kernel also names anonymous class expressions in its output, for example `i rdf:type <class expression node>`, and it emits those names as plain IRIs. For a class expression written with a skolem IRI (for example the `intersectionOf` node of `A equivalentClass [intersectionOf (B C)]`), the inferred graph therefore contained the wire label (`sk_75726e3a76673a626e6f64653a65`) instead of the original IRI.

The decoder now restores the original IRI for named-node terms as well, on both decode paths (the quad path in `ts/intern.ts` and the N3 injection path in `ts/n3Inject.ts`). The inferred triple is `i rdf:type <urn:vg:bnode:e>`.

Regression test: `tests/integration/skolem-retag.test.ts` now asserts, for every construct in blank, skolem and genid form, that no inferred term starts with the wire label (two of its tests fail without the fix).

## Verification

Full inferred graphs of the nine constructs (someValuesFrom, hasValue, allValuesFrom, minCardinality, intersectionOf, unionOf, oneOf, complementOf, a nested combination) compared between real blank nodes, `urn:vg:bnode:` IRIs and genid IRIs: identical after the fix, apart from the known blank-node quirk below. Full vitest suite on the unchanged WASM: 751 passed, 9 skipped, 0 failed.

## Known

- With real blank nodes, the kernel's name for an anonymous class expression comes back as a scheme-less IRI such as `b0_e` (the parser's label), for example `i rdf:type <b0_e>`. This predates v0.9.2 and is not changed here.
- Skolem IRIs from a scheme other than `urn:vg:bnode:` or `/.well-known/genid/` are not recognized as blank nodes; for those, cardinality, `complementOf` and list-based class expressions are still silently missed. Use real blank nodes or one of the two recognized schemes.
