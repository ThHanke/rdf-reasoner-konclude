import type { Quad } from "@rdfjs/types";

/**
 * Options controlling how the reasoning operation is performed.
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
