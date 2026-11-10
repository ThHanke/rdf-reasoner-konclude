# Release Notes — v0.9.1

## Summary

v0.9.1 is a bug-fix release on v0.9.0. The public API is unchanged; upgrade is drop-in. v0.9.0 is deprecated on npm.

## Fixed

### Inferred blank nodes returned with a stray colon

On v0.9.0, a blank node asserted as `_:b1` came back in inferred triples as `_::b1` (a `BlankNode` with value `:b1`). Konclude names blank individuals `_:` + ontology name + `:` + label; the ontology name is empty here, so the internal name `_::b1` leaked into the output. Inferred triples therefore landed on a different node than the asserted one, and consumers such as SHACL validation saw the original node as untyped.

The output encoder now emits such individuals as blank nodes carrying the original label, so inferred triples attach to the asserted node. Regression test: `tests/integration/inferred-blank-node-label.test.ts`.

## Tests

`tests/integration/explanation-persistence.test.ts` now uses the single shared reasoner instead of spawning an extra Worker per test. The extra Worker triggered the second-worker slow run named in the v0.9.0 known limits and made the 120 s timeouts flaky.
