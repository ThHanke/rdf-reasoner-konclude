# Release Notes — v0.9.6

## Summary

Hotfix for `explainEntailment()` on `rdfs:subClassOf` targets. TypeScript-only; the WASM binary is unchanged. No API change.

## Fixed

- **Record individuals clashed with the entailment probe.** To test `A ⊑ B` the reasoner added the global axiom `A ⊑ ¬B` plus a witness typed `A`. Any individual in the store that was both `A` and `B` clashed with that axiom on its own. Effects: a non-entailed `A ⊑ B` was reported as entailed, and record assertions (`r a A`, `r a B`) appeared in justifications.
  - The probe now asserts a fresh named witness (`urn:vg:witness:<probe id>`) in `A` and in `¬B`, with no global axiom. The witness is inconsistent exactly when `A ⊑ B` is entailed or `A` is unsatisfiable (the existing vacuous-truth check still covers the latter).
  - The witness must be a named IRI: a blank-node witness is not treated as an ABox individual by the kernel and the probe never became inconsistent.

## Tests

- `tests/integration/explain-entailment-record-individual.test.ts`: non-entailed `A ⊑ C` with a record individual that is both `A` and `C` returns `isEntailed: false`; entailed `A ⊑ B` returns only the two axioms. Both fail on 0.9.5.
- `tests/unit/entailmentProbe.test.ts`: probe has no `rdfs:subClassOf` quad; witness typed `A` and `¬B`.
