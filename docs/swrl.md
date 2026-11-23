# SWRL rules

`materialize()` applies DL-safe SWRL rules found in the store. Konclude itself has no SWRL support and its RDF mapper drops the rule triples, so the library applies the rules on top of the kernel and feeds the consequences back to it.

- [What you get](#what-you-get)
- [How it works](#how-it-works)
- [Supported rules](#supported-rules)
- [What is not supported, and what happens](#what-is-not-supported-and-what-happens)
- [Semantics and the one caveat](#semantics-and-the-one-caveat)
- [Cost](#cost)
- [API](#api)
- [Interactions](#interactions)
- [Example](#example)
- [Tests and benchmark](#tests-and-benchmark)
- [Follow-ups](#follow-ups)

## What you get

Put `swrl:Imp` rules into the store next to the ontology and call `materialize(store)`. The head statements of every rule that fires are written to the inferred graph, together with everything the ontology then entails about them. Rules can feed each other (a head that is the body of another rule), and the OWL reasoning sees the rule consequences: a quality derived by a rule can place an individual in a defined class.

Rule processing is on by default. Pass `{ swrl: false }` to skip it. A store without `swrl:Imp` triples pays no cost.

## How it works

1. `materialize()` realizes the ontology as usual.
2. If the store holds `swrl:Imp` rules, they are parsed (`parseRules`, `ts/swrl.ts`).
3. The rules run over the facts (asserted triples + the kernel's inferred triples + derived triples) in TypeScript until nothing new is derived. Matching is semi-naive: after the first pass only matches that use a fact new since the previous pass are enumerated.
4. If the closure produced facts the kernel has not seen, the kernel is called once: the store plus the derived triples is synced, checked for consistency, realized, and the inferred triples are read back. Those can enable further rule firings, so the loop repeats until a pass derives nothing new.
5. The derived triples (graph `urn:konclude:swrl`) and the kernel output are written to the inferred graph.

The number of kernel rounds is the number of alternations between rule inference and OWL inference, not the number of rule steps. A rule chain that only feeds itself costs one kernel round.

## Supported rules

DL-safe rules (Motik, Sattler, Studer 2005): rule variables bind only to **named individuals** (IRIs, not blank nodes), which keeps the rules decidable and independent of the ontology's class expressions.

| Atom | Supported |
|---|---|
| Class atom `C(x)` with a **named** class | yes |
| Individual property atom `p(x, y)` | yes |
| Data property atom `d(x, v)` | yes |
| `sameIndividual(x, y)`, `differentIndividuals(x, y)` | yes |
| Constants (a named individual or a literal) as arguments | yes |

Every variable in a head atom must occur in the body (DL-safety). A rule that violates this is not accepted.

## What is not supported, and what happens

A rule with an atom outside the table is **skipped as a whole** and its IRI is listed in `reasoner.lastSwrl.unsupported`. It is never half-applied.

| Not supported | Typical example |
|---|---|
| Built-in atoms | `swrlb:greaterThan(?x, 3)` |
| Data range atoms | `DataRangeAtom` |
| A class expression as the class predicate | an anonymous restriction in `ClassAtom` |
| A head variable that does not occur in the body | not DL-safe |

Built-in atoms are the most likely reason a real rule set is skipped; see [Follow-ups](#follow-ups).

## Semantics and the one caveat

The fixpoint is **sound** and matches DL-safe semantics whenever each body atom is entailed on its own. One consequence to know: a rule body that holds in every model only by a case distinction does not fire. If an individual `d` is "a quality or a disposition" but neither is entailed, the body `Quality(d) ∧ ...` is not satisfied, even though it holds in each of the two cases. The rules are evaluated against what is entailed, not against all models.

Blank nodes never bind to rule variables. Facts about anonymous individuals do not take part.

## Cost

Measured on a generated part-of tree (300 materials, 900 qualities, two chained rules, 4,863 derived triples; `tests/bench/swrl-bench.mjs`, median of 3):

| Store | `materialize` time against no rules |
|---|---|
| No `swrl:Imp` triples | the same (detected before any work) |
| Rules whose bodies never match | 1.0x (567 ms against 551 ms) |
| Rules deriving 4,863 triples | 2.5x (1417 ms against 559 ms) |

The overhead of the last case is one kernel round (sync 49 ms, consistency 154 ms, realization 307 ms, decode 30 ms), because the derived edges enlarge the ABox the kernel has to realize. Before the TypeScript closure the same input took 7 kernel rounds and 4755 ms (7.8x). The design is described in [`docs/solutions/architecture-patterns/swrl-fixpoint-ts-closure-2026-11-23.md`](solutions/architecture-patterns/swrl-fixpoint-ts-closure-2026-11-23.md).

PMDco ships 4 `swrl:Imp` rules. On its Fe-Si record they parse, run one pass and derive nothing: no measurable cost.

## API

```typescript
await reasoner.materialize(store); // rules applied (default)
await reasoner.materialize(store, { swrl: false }); // rules ignored

reasoner.lastSwrl; // { rules, unsupported, rounds, derived, applied }
```

- `rules`: rules parsed and accepted. `unsupported`: IRIs of rules that were skipped. `rounds`: passes (closure, then a kernel round if something new was derived; the last pass is the empty confirming one). `derived`: derived triples. `applied`: `false` when `swrl: false` was passed (the rules found are still listed).
- The materialize result cache records the option: a call with the other setting on an unchanged store recomputes.

## Interactions

- **Explanations.** `explanations: true` returns the justifications of the first realization. They do not include rule consequences.
- **Inconsistency.** If the ontology together with the rule consequences is inconsistent, the call rejects with `InconsistentOntologyError`.
- **Worker state.** After rules fired the worker holds the augmented content; the next call on the same store re-syncs (no cache hit).
- **Other verbs.** `classify`, `checkConsistency` and `isEntailed` do not apply rules. Rules are a `materialize` feature.
- **Limit.** The fixpoint stops with an error after 10 kernel rounds (`SWRL_MAX_ROUNDS`).

## Example

```typescript
const rules = `
  ex:e a swrl:Variable . ex:d a swrl:Variable .
  [ a swrl:Imp ;
    swrl:body ( [ a swrl:ClassAtom ; swrl:classPredicate ex:Quality ; swrl:argument1 ex:d ]
                [ a swrl:IndividualPropertyAtom ; swrl:propertyPredicate ex:hasCharacteristic ; swrl:argument1 ex:e ; swrl:argument2 ex:d ] ) ;
    swrl:head ( [ a swrl:IndividualPropertyAtom ; swrl:propertyPredicate ex:hasQuality ; swrl:argument1 ex:e ; swrl:argument2 ex:d ] ) ] .`;
// store = ontology + data + rules (prefixes: swrl: <http://www.w3.org/2003/11/swrl#>, ex: your namespace)
await reasoner.materialize(store);
// every ex:e with an ex:hasCharacteristic to an ex:Quality now also has ex:hasQuality to it, in the inferred graph
```

This is the PMDco rule form (`Quality(d) ∧ hasCharacteristic(e, d) → hasQuality(e, d)`): it cannot be turned into an OWL axiom in general, because the role chain `hasCharacteristic ∘ R_Quality ⊑ hasQuality` is irregular when `hasQuality ⊑ hasCharacteristic`.

## Tests and benchmark

| What | Where |
|---|---|
| Rule parser, one pass, semi-naive = naive | `tests/unit/swrl.test.ts` |
| Fixpoint against an independent oracle, no-match rules, unsupported atom, inconsistency from derived facts, no-rule store, `swrl: false` and the cache | `tests/integration/swrl-fixpoint.test.ts` |
| Timing with and without rules (`--nofire` for rules that never match) | `tests/bench/swrl-bench.mjs` |

## Follow-ups

- **Built-in atoms** (`swrlb:*`): the most common reason a real rule set is skipped.
- **Explanations that include rule consequences.**
- **Incremental realization:** the remaining overhead is one kernel round that rebuilds the ontology; upstream Konclude has no incremental realization (a paused project topic).
- A kernel-native rule step is not planned: it would still realize the larger ABox and needs changes in the threading layer.
