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
}

/**
 * Named graph IRI used to hold hypothetical (what-if) triples.
 * Quads in this graph are excluded from store fingerprints.
 */
export const HYPOTHETICAL_IRI = "urn:konclude:hypothetical";

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

  /**
   * When `true`, the returned Promise resolves to `{ delta: InferenceDelta }`
   * containing the quads added and removed from the inferred graph compared
   * to the previous inferred state.
   *
   * When absent or `false`, the Promise resolves to `void` (backward compatible).
   */
  returnDelta?: boolean;
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
  /** Maximum inconsistency justifications to return. Defaults to 1. */
  maxJustificationsPerError?: number;
  /** Maximum justifications per unsatisfiable class. Defaults to 1.
   *  Pass 0 to skip BlackBox for warnings (returns IRI list only). */
  maxJustificationsPerWarning?: number;
  /** Optional filter applied to both error and warning candidate axiom sets. */
  axiomFilter?: (q: Quad) => boolean;
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
  /** Human-readable explanation of a special case (inconsistent / vacuous). */
  reason?: string;
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
}
