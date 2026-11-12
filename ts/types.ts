import type { Quad } from "@rdfjs/types";

export const INFERRED_GRAPH_IRI = "urn:konclude:inferred";

/**
 * Options controlling how `explain()` and `explainInconsistency()` operate.
 */
export interface ExplainOptions {
  /** Maximum number of justifications to return. Defaults to 1. */
  maxJustifications?: number;
  /** Optional filter to restrict the candidate axiom set. Applied AFTER the
   *  built-in declaration filter. */
  axiomFilter?: (q: Quad) => boolean;
  /**
   * Named graph IRI that holds inferred triples in the store.
   *
   * Defaults to `INFERRED_GRAPH_IRI` (`"urn:konclude:inferred"`).
   * Set this when the caller writes inferred quads to a different graph
   * (e.g. `"urn:vg:inferred"` via `materialize({inferredGraph})`) so that
   * base-axiom filtering reads the right graph.
   */
  inferredGraph?: string;
  /**
   * Wall-clock timeout in milliseconds for the justification search.
   *
   * When the deadline is reached the call returns whatever justifications have
   * been found so far (possibly zero).  The inconsistency detection itself is
   * unaffected; only the minimisation search is cut short.
   *
   * Defaults to 180 000 ms (3 minutes).  Set to 0 to disable the timeout.
   */
  timeout?: number;
}

/** One OWL axiom as it is stored: all triples that make it up. A restriction axiom is several triples. */
export interface Axiom {
  /** The triple that names the axiom (for a subclass-of-restriction axiom: `C rdfs:subClassOf _:b`). Exact instance from the store. */
  principal: Quad;
  /** All triples of the axiom including `principal`, every graph copy of each; remove them together. */
  quads: Quad[];
}

export interface AxiomJustification {
  /** Logical axioms that together cause the clash. Declarations are never in this list. */
  axioms: Axiom[];
  /** Declaration triples (`C a owl:Class`, `p a owl:ObjectProperty`, ...) the justification needs but that are not candidates for removal. */
  context: Quad[];
}

export interface RepairOptions {
  /**
   * Justifications the caller already holds for this store (for example from `explainInconsistencyAxioms`), used instead of the
   * first explanation round. Each one is checked against the store: it is dropped when a quad (or declaration) is no longer
   * present, or when its axioms plus `context` are not inconsistent on their own. If none survives, repair explains as usual.
   * Repair sets are still verified and refined afterwards, so an incomplete seed list costs extra rounds, not correctness.
   * Surviving seeds appear first in `RepairResult.justifications`.
   */
  justifications?: AxiomJustification[];
  /** Justifications to collect per explanation round. Default 3. */
  maxJustifications?: number;
  /** Stop after this many repair sets (`reason: 'solution-cap'`). Default 10. */
  maxRepairs?: number;
  /** Safety net on refine rounds (an extra explanation call each); refinement normally ends when a candidate verifies, the deadline hits, or a round finds no new justification. Default 10. */
  maxRounds?: number;
  /** Lower cost = preferred to remove. When given, repair sets are ordered by total cost, then size. Default: ordered by size. */
  cost?: (axiom: Axiom) => number;
  /** Check each repair set by removing it from a copy and testing consistency. Default true. */
  verify?: boolean;
  /** Wall-clock budget in ms for the whole call, 0 = none. Default 300000. */
  timeout?: number;
  /** Named graph IRI that holds inferred triples in the store (excluded from the ontology). Default `INFERRED_GRAPH_IRI`. */
  inferredGraph?: string;
}

export interface Repair {
  /** Axioms to remove together (every graph copy of every triple, see `Axiom.quads`). */
  remove: Axiom[];
  /** Indices into `RepairResult.justifications` that this set hits. */
  covers: number[];
  /** Removing exactly `remove` leaves a consistent ontology. `null`: not checked (`verify: false`, deadline or failed check). */
  verifiedConsistent: boolean | null;
  /** Inclusion-minimal: no proper subset restores consistency. True whenever the set is a verified minimal hitting set of the known justifications (removing any member leaves a known justification intact). `null` when not verified. */
  minimal: boolean | null;
}

export interface RepairResult {
  /** True when the input was already consistent; then `repairs` is empty. */
  consistent: boolean;
  /** The justifications the repairs were built from. */
  justifications: AxiomJustification[];
  repairs: Repair[];
  incomplete: boolean;
  reason?: 'deadline' | 'round-cap' | 'solution-cap' | 'explain-failed' | 'verify-failed';
}

export interface Edit {
  /** Quads to remove, by exact identity (graph included). Quads that are not in the store are reported in `unmatchedRemovals`. */
  remove?: Quad[];
  /** Quads to add. */
  add?: Quad[];
}

/** Two named classes, `a < b` lexicographically. */
export interface DisjointPair {
  a: string;
  b: string;
}

export interface AssessEditOptions {
  /** Class pairs to protect. Default: the asserted disjointness pairs of the unedited store (`owl:disjointWith`, `owl:AllDisjointClasses`, `owl:disjointUnionOf`, expanded, named classes only), read syntactically so an inconsistent store works. */
  pairs?: DisjointPair[];
  /** Also protect the pairs formed by descendants of the asserted endpoints (entailed by monotonicity; needs a consistent unedited store, otherwise ignored). Default false. */
  deriveFromHierarchy?: boolean;
  /** Wall-clock budget in ms for the whole call, 0 = none. Default 180000. */
  timeout?: number;
  /** Named graph IRI that holds inferred triples in the store (excluded from the ontology). Default `INFERRED_GRAPH_IRI`. */
  inferredGraph?: string;
}

export interface EditAssessment {
  /** The ontology after the edit is consistent. */
  consistent: boolean;
  /** Pairs that were asserted (or derived) disjoint before the edit and are no longer entailed disjoint after it. A pair whose endpoint became unsatisfiable still counts as disjoint. `null` when the edited ontology is inconsistent or the check was cut short. */
  lostDisjointPairs: DisjointPair[] | null;
  /** The pairs that were tested. */
  pairsChecked: DisjointPair[];
  /** Requested removals that matched no quad of the store (the edit did nothing for them). */
  unmatchedRemovals: Quad[];
  /** The call stopped early (`reason` says why); what is set is still valid. */
  incomplete: boolean;
  /** `deadline` and `pair-cap` (more than 5000 pairs) set `incomplete`; `edited-inconsistent` is informational (the edit does not restore consistency, so disjointness cannot be judged). */
  reason?: 'deadline' | 'pair-cap' | 'edited-inconsistent';
}

export interface WeakenOptions {
  /** Wall-clock budget in ms for the whole call, 0 = none. Default 180000. */
  timeout?: number;
  /** Named graph IRI that holds inferred triples in the store (excluded from the ontology). Default `INFERRED_GRAPH_IRI`. */
  inferredGraph?: string;
}

export interface Weakening {
  strategy: 'generalize' | 'dropConjunct' | 'delete';
  /** Triples to remove: every triple of the culprit axiom (all graph copies). */
  remove: Quad[];
  /** Triples of the weaker replacement axiom (empty for 'delete'); fresh blank nodes for an intersection. */
  add: Quad[];
  /** Removing `remove` and adding `add` leaves a consistent ontology in which the target class is satisfiable. Every returned weakening was verified. */
  verifiedConsistent: boolean | null;
  /** What changed: a conjunct generalized to a named superclass (`to`), or dropped (`to: null`). Absent for 'delete'. */
  change?: { from: string; to: string | null };
}

export interface WeakenResult {
  /** The most specific working generalizations first, then dropped conjuncts, ending with 'delete' (the order within a group is unspecified). Empty when `reason` explains why no weakening is offered. */
  weakenings: Weakening[];
  incomplete: boolean;
  /** `deadline` sets `incomplete` (what was found is still valid, 'delete' is included when verified). The others mean no weakening is offered. */
  reason?: 'deadline' | 'culprit-not-in-store' | 'removal-does-not-restore-consistency' | 'unsupported-axiom';
}

/**
 * Named graph IRI used to hold hypothetical (what-if) triples.
 * Quads in this graph are excluded from store fingerprints.
 */
export const HYPOTHETICAL_IRI = "urn:konclude:hypothetical";

export const EXPLANATION_GRAPH_IRI = "urn:konclude:explanations";

export const KJ_NS = "urn:konclude:justification#";
export const KJ_JUSTIFICATION = `${KJ_NS}Justification`;
export const KJ_JUSTIFIES = `${KJ_NS}justifies`;
export const KJ_AXIOM = `${KJ_NS}axiom`;

/**
 * The set of quads added or removed from the inferred graph between two
 * consecutive materialize() calls on the same store.
 */
export interface InferenceDelta {
  /** Quads newly inferred that were not present before. */
  added: Quad[];
  /** Quads that were inferred before but are no longer inferred. */
  removed: Quad[];
}

/**
 * Options controlling how the reasoning operation is performed.
 *
 * @remarks This interface is used by the deprecated `reason()` API. Prefer
 * `classify()`, `materialize()`, or `checkConsistency()` instead, which do not
 * require a `mode` parameter.
 */
export interface ReasoningOptions {
  /**
   * The reasoning mode to apply.
   *
   * - `"classify"` — compute the class hierarchy (rdfs:subClassOf inferences)
   * - `"consistency"` — check whether the ontology is consistent
   * - `"full"` — perform classification and consistency checking
   *
   * Defaults to `"classify"`.
   */
  mode?: "classify" | "consistency" | "full";
}

/**
 * Options for Store-based reasoning operations.
 *
 * Extends `ReasoningOptions` with a named-graph IRI for inferred triples.
 */
export interface StoreReasoningOptions extends ReasoningOptions {
  /**
   * Named graph IRI where inferred triples are written.
   *
   * Defaults to `INFERRED_GRAPH_IRI` (`"urn:konclude:inferred"`).
   * The graph is cleared before each call; do not store ontology triples here.
   */
  inferredGraph?: string;

  /** Reject with `InconsistentOntologyError` when the ontology is inconsistent (default false: an empty result, no signal). Costs one consistency check per changed content; for `materialize` one extra rebuild (the realization variant differs from the consistency one). */
  failOnInconsistent?: boolean;

  /**
   * When `true`, justifications are serialized as RDF-star triples into the
   * `urn:konclude:explanations` named graph. Query via `store.getQuads()`.
   */
  explanations?: boolean;
}

/**
 * Options controlling how the materialize operation is performed.
 */
export interface MaterializeOptions {
  /**
   * When `true`, the returned quads include the class hierarchy
   * (rdfs:subClassOf and owl:equivalentClass assertions) in addition to
   * rdf:type assertions.
   *
   * Defaults to `false` — only rdf:type entailments are returned.
   */
  includeClassHierarchy?: boolean;
}

/**
 * Options for Store-based materialize operations.
 *
 * Extends `MaterializeOptions` with a named-graph IRI for inferred triples.
 */
export interface MaterializeStoreOptions extends MaterializeOptions {
  /**
   * Named graph IRI where inferred triples are written.
   *
   * Defaults to `INFERRED_GRAPH_IRI` (`"urn:konclude:inferred"`).
   * The graph is cleared before each call; do not store ontology triples here.
   */
  inferredGraph?: string;

  /** Reject with `InconsistentOntologyError` when the ontology is inconsistent (default false: an empty result, no signal). Costs one consistency check per changed content; for `materialize` one extra rebuild (the realization variant differs from the consistency one). */
  failOnInconsistent?: boolean;

  /**
   * When `true`, the returned Promise resolves to `{ delta: InferenceDelta }`
   * containing the quads added and removed from the inferred graph compared
   * to the previous inferred state.
   *
   * When absent or `false`, the Promise resolves to `void` (backward compatible).
   */
  returnDelta?: boolean;

  /**
   * When `true`, justifications are serialized as RDF-star triples into the
   * `urn:konclude:explanations` named graph. Query via `store.getQuads()`.
   */
  explanations?: boolean;
}

/**
 * Options for Store-based classifyProperties operations.
 */
export interface ClassifyPropertiesStoreOptions {
  /**
   * Named graph IRI where inferred property triples are written.
   *
   * Defaults to `INFERRED_GRAPH_IRI` (`"urn:konclude:inferred"`).
   * The graph is cleared before each call; do not store ontology triples here.
   */
  inferredGraph?: string;

  /** Reject with `InconsistentOntologyError` when the ontology is inconsistent (default false: an empty result, no signal). Costs one consistency check per changed content; for `materialize` one extra rebuild (the realization variant differs from the consistency one). */
  failOnInconsistent?: boolean;

  /**
   * When `true`, justifications are serialized as RDF-star triples into the
   * `urn:konclude:explanations` named graph. Query via `store.getQuads()`.
   */
  explanations?: boolean;
}

/**
 * Options for `whatIf` hypothetical reasoning.
 */
export interface WhatIfOptions {
  /** Quads to remove from the base ontology before reasoning. */
  removals?: Quad[];
  /** Named graph IRI where hypothetical inferences are written in the store.
   *  Must not equal INFERRED_GRAPH_IRI or HYPOTHETICAL_IRI (throws if equal). */
  outputGraph?: string;

  /** Reject with `InconsistentOntologyError` when the ontology is inconsistent (default false: an empty result, no signal; the check applies to the hypothetical ontology). Costs one consistency check per changed content; for `materialize` one extra rebuild (the realization variant differs from the consistency one). */
  failOnInconsistent?: boolean;
}

/**
 * A single unsatisfiable-class warning produced by `validate()`.
 */
export interface ClassWarning {
  /** IRI of the unsatisfiable class. */
  classIRI: string;
  /** Minimal justifications (each is a set of axioms that together imply unsatisfiability).
   *  Empty when `maxJustificationsPerWarning` is 0. */
  justifications: Quad[][];
}

/**
 * Result returned by `validate()`.
 */
export interface ValidationResult {
  /** `true` if the ontology has at least one model. */
  consistent: boolean;
  /** Minimal inconsistent sub-ontologies (MIPS). Non-empty only when `consistent` is `false`. */
  errors: Quad[][];
  /** One entry per unsatisfiable class (excluding owl:Nothing). */
  warnings: ClassWarning[];
}

/**
 * Options for `validate()`.
 */
export interface ValidateOptions {
  /** Named graph IRI that holds inferred triples in the store.
   *  Defaults to `INFERRED_GRAPH_IRI` (`"urn:konclude:inferred"`). */
  inferredGraph?: string;
  /** Maximum inconsistency justifications to return. Defaults to 1. */
  maxJustificationsPerError?: number;
  /** Maximum justifications per unsatisfiable class. Defaults to 1.
   *  Pass 0 to skip the justification search for warnings (returns IRI list only). */
  maxJustificationsPerWarning?: number;
  /** Optional filter applied to both error and warning candidate axiom sets. */
  axiomFilter?: (q: Quad) => boolean;
  /** Wall-clock timeout in milliseconds for the justification search (errors and warnings together). When it is reached
   *  the justifications found so far are returned. Defaults to 180 000 ms; 0 disables the timeout. */
  timeout?: number;
}

/**
 * The result returned by a reasoning operation.
 *
 * @remarks Reserved for future use. When `mode:'full'` is fully implemented
 * this interface will be returned by a dedicated API surface that exposes both
 * inferred quads and the consistency flag together. No public method currently
 * returns `ReasoningResult`; use `reason()` for quads and `checkConsistency()`
 * for the boolean flag.
 */
export interface ReasoningResult {
  /**
   * The inferred quads produced by the reasoner.
   *
   * For mode `"classify"`: rdfs:subClassOf triples in the default graph.
   * For mode `"consistency"`: empty array (see `consistent` flag).
   * For mode `"full"`: all inferred triples.
   *
   * Named graph information from the input is not preserved (NTriples
   * wire format is triple-only). All returned quads are in the default graph.
   */
  quads: Quad[];

  /**
   * Whether the input ontology is consistent.
   *
   * Always present for mode `"consistency"` and `"full"`.
   * Undefined for mode `"classify"`.
   */
  consistent?: boolean;
}

/**
 * Constructor options for RdfReasoner.
 */
export interface RdfReasonerOptions {
  /** Optional URL to the worker script. When absent, uses import.meta.url resolution. */
  workerUrl?: string | URL;
  /** Pre-constructed Worker instance. When provided, workerUrl is ignored and no
   *  new Worker is created. Use this when your bundler (e.g. Vite) cannot
   *  statically analyze `new Worker(url)` in library code. */
  worker?: Worker;
  /** Optional callback for trace/log messages from the WASM worker.
   *  Receives Emscripten main-thread stdout/stderr output. pthread output
   *  goes directly to terminal stderr and does not reach this callback. */
  onTrace?: (msg: string) => void;
  /** Creates a fresh Worker. Used for the initial Worker and for restarts after a stall.
   *  Takes precedence over `worker` / `workerUrl`. */
  workerFactory?: () => Worker;
  /** A blocking reasoning call (load, classification, realization, consistency) that shows
   *  no sign of life (no response and no trace message) for this long is treated as stalled:
   *  the Worker is restarted, the state of the current store is replayed, and the call is
   *  retried once. Default 600000 (10 min); 0 disables the watchdog. */
  stallTimeoutMs?: number;
  /** WASM linear memory never shrinks and is capped at 4 GiB; two large ontologies in one heap
   *  make an allocator thread trap (observed as a stall). When the heap has grown past this many
   *  bytes after a call, the Worker is recycled before the next load. Default 2 GiB; 0 disables. */
  recycleHeapBytes?: number;
  /** Named graphs that are not ontology content (for example SHACL shapes, provenance or workflow state).
   *  Their quads are never sent to the reasoner, never count as store content for change detection, are
   *  ignored when extracting axioms for explanations and repairs, and never make an inferred triple look
   *  "already asserted". The reasoner's own inferred, hypothetical and explanation graphs are always excluded
   *  and need not be listed. Applies to every call on this instance. Default none. */
  excludeGraphs?: Iterable<string>;
}

/** Thrown (after one automatic recovery attempt) when a reasoning call stalls. */
export class ReasonerStalledError extends Error {
  constructor(method: string, idleMs: number) {
    super(idleMs > 0 ? `Reasoner call "${method}" made no progress for ${Math.round(idleMs / 1000)} s` : `Reasoner "${method}" stalled (no task or event activity)`);
    this.name = "ReasonerStalledError";
  }
}

/**
 * Thrown by the reasoning methods that accept `failOnInconsistent: true` when the ontology (or, for `whatIf`, the
 * hypothetical ontology) is inconsistent. Without the option those methods return empty results for an inconsistent
 * ontology without any signal: check `checkConsistency` first, or pass the option.
 */
export class InconsistentOntologyError extends Error {
  constructor(message = "The ontology is inconsistent; results of this call would be empty or meaningless.") {
    super(message);
    this.name = "InconsistentOntologyError";
  }
}

/** Options shared by the methods that can signal an inconsistent ontology. */
export interface InconsistencyGuardOptions {
  /** Named graph IRI that holds inferred triples in the store (excluded from the ontology). Default `INFERRED_GRAPH_IRI`. */
  inferredGraph?: string;
  /** Reject with `InconsistentOntologyError` when the ontology is inconsistent (default false: an empty result, no signal). Costs one consistency check per changed content; for `materialize` and `whatIf` one extra rebuild (the realization variant differs from the consistency one). */
  failOnInconsistent?: boolean;
}

/**
 * Result returned by `explainEntailment()`.
 */
export interface EntailmentResult {
  /**
   * Whether the triple is entailed by the ontology.
   * `null` when the ontology is already inconsistent (vacuous entailment).
   */
  isEntailed: boolean | null;
  /**
   * Minimal justifications — each is a subset of the ontology's base axioms
   * that alone entails the target triple. Empty when `isEntailed` is false,
   * null, or when the entailment is vacuously true.
   */
  justifications: Quad[][];
  /** Set to `true` when the ontology is already inconsistent. */
  ontologyInconsistent?: boolean;
  /** Set to `true` when entailment holds but only vacuously (subject class unsatisfiable). */
  vacuous?: boolean;
  /**
   * `true` when `isEntailed` is `true` but no justification was produced (fast mode could not derive a sound one;
   * every returned justification is verified: asserted triples only, and it alone entails the target). An empty
   * `justifications` list never means "directly asserted" - an asserted triple is returned as its own justification.
   * Use `justificationMode: "exact"` to obtain the axioms.
   */
  justificationUnavailable?: boolean;
  /** Human-readable explanation of a special case (inconsistent / vacuous / justification unavailable). */
  reason?: string;
}

/**
 * A single part of a laconic justification.
 */
export interface LaconicPart {
  /** The laconic part's principal triple. */
  quad: Quad;
  /** The original axiom's principal triple that this part was derived from. */
  sourceQuad: Quad;
  /** True when this part is strictly smaller than its source axiom. */
  isPartOf: boolean;
}

/**
 * A laconic justification for an inconsistency.
 */
export interface LaconicJustification {
  /** The laconic parts — minimal sub-axioms that together drive the clash. */
  parts: LaconicPart[];
  /** True when at least one part is a strict sub-axiom of its source. */
  sharpened: boolean;
  /** True when the cost cap was exceeded and laconic post-processing was skipped. */
  skipped: boolean;
}

/**
 * Options controlling how `explainInconsistencyLaconic()` operates.
 */
export interface LaconicExplainOptions extends ExplainOptions {
  /** Maximum number of axioms in a justification before skipping laconic post-processing. Defaults to 20. */
  laconicMaxAxioms?: number;
  /** Maximum number of total parts before skipping laconic post-processing. Defaults to 40. */
  laconicMaxParts?: number;
}

/**
 * Options controlling how `explainEntailment()` operates.
 */
export interface ExplainEntailmentOptions extends ExplainOptions {
  /**
   * Treat the object IRI as class-like (owl:Class / named class).
   * When `false`, the method falls back to "unsupported" for non-type predicates.
   * Defaults to `true`.
   */
  objectIsClassLike?: boolean;
  /**
   * @deprecated Use `justificationMode: "fast"` instead. When both are set,
   * `justificationMode` takes precedence.
   */
  nativeOnly?: boolean;
  /**
   * Controls how justifications are computed.
   *
   * - `"fast"` (default): uses the native dep-chain cache and TS synthesis, about 1 ms when a candidate exists.
   *   Every candidate is verified before it is returned (asserted triples only, and it alone entails the target);
   *   a failing candidate is dropped, never returned. It returns at most one justification, which is not guaranteed
   *   minimal. If no candidate survives it returns `isEntailed: true`, empty justifications and
   *   `justificationUnavailable: true`.
   * - `"exact"`: finds guaranteed-minimal axiom sets (QuickXplain over axiom units plus a hitting-set tree, the
   *   engine shared with `explainInconsistency`, with the negated entailment as part of the input). One reasoner call
   *   per probe, about 2*k*log2(n/k) probes for a justification of k axioms; bounded by `timeout` (seconds on large
   *   ontologies). Returns every justification up to `maxJustifications`. Never takes a shortcut.
   * - `"causal"` / `"minimal"`: deprecated names of `"fast"` / `"exact"`.
   */
  justificationMode?: "fast" | "exact" | "causal" | "minimal";
}
