# Release Notes — next version (draft, not yet versioned)

Collects the changes of the PR #18 adoption. Rename this file to `release-notes-vX.Y.Z.md` when the version is chosen.

## Added

- **DL-safe SWRL rules in `materialize()`.** Rules (`swrl:Imp`) found in the store are applied over the named individuals of the realized ABox until no rule adds a statement; the consequences are written to the inferred graph. Konclude has no SWRL support, so this runs on top of the kernel.
  - **Opt out:** `materialize(store, { swrl: false })`. `reasoner.lastSwrl` reports `{ rules, unsupported, rounds, derived, applied }`; with the option off it still lists the rules found, with `applied: false`.
  - **Cost.** No `swrl:Imp` in the store: no cost. Rules that never match: one matching pass (about 3% on the benchmark). Rules that derive many statements: the kernel realizes a larger ABox; on 300 materials with 4,863 derived triples `materialize` takes 2.5x as long as without rules (1.4 s against 0.56 s). Rule chains are closed in TypeScript, so the kernel runs once per alternation between rule and OWL inference and not once per rule step (7 kernel rounds became 2, 4.8 s became 1.4 s on that benchmark).
  - Supported atoms: named class atoms, individual and data property atoms, same/different individuals. Other rules are skipped and listed in `lastSwrl.unsupported`.
- `isEntailed` decides property assertions, property characteristics and declarations.
- Input rewrites before reasoning: negative property assertions, the bottom data property, OWL 1 boolean constructors, disjoint data properties, `owl:hasKey`.
- `weaken()` gets an `alsoRemove` option.

## Fixed (kernel)

- Datatype clashes between value spaces (a string where `xsd:integer` is required) are detected; datatype concepts get their datatype operator when created (patch 002).
- A negated derived datatype (`not xsd:positiveInteger`) no longer closes the whole value space (patch 002).
- One Redland world for all loads fixes a trap after consecutive loads in one reasoner (patch 004).
- Use-after-free and double free in `buildComplexABoxAxioms` for a blank-node class expression shared by several individuals (patch 004).
- Data values follow `rdfs:subPropertyOf` for data properties (`hasAge ⊑ hasNumber`: `Alice hasNumber 30` is materialized).

## Changed

- Vendor patches 006-009 of the PR are folded into 002 and 004; the vendor tree is byte-identical to the sequential application (`patches/README.md`).
- `materialize()` checks asserted individuals against the unsatisfiable classes after realization, because Konclude's consistency step misses some of them (W3C description-logic-008 and others).

## Known limits and open work

- Realization of two ROBOT-normalized W3C premises (`SymmetricProperty-002`, `TransitiveProperty-002`) deadlocks the kernel and is not fixed.
- Ten W3C consistency verdicts remain wrong (float/double value spaces, `owl:rational`, two kernel limitations); they are pinned in `tests/integration/w3c-conformance-pr18.test.ts` and listed in `docs/solutions/capability-gaps/pr18-known-conformance-gaps-2026-11-23.md`.
- Float and double value counting, and data cardinality over finite value spaces, are not implemented.
