/**
 * Repair orchestration (C1 of the repair plan): lazy candidate / verify / refine loop over a reasoner oracle.
 *
 *   1. explain the inconsistency (a few justifications),
 *   2. minimal hitting sets of the justifications are the repair candidates (no reasoner calls),
 *   3. verify each candidate on an edited copy; a candidate that still fails reveals undiscovered
 *      justifications: explain the edited copy, add them, recompute the candidates, repeat.
 *
 * A verified candidate is inclusion-minimal by monotonicity: it is a minimal hitting set of the known
 * justifications, so removing any proper subset leaves some known justification (still inconsistent) intact.
 */
import type { Quad } from "@rdfjs/types";
import type { Store } from "n3";
import { groupJustification, axiomKey, quadKey } from "./axiomGrouping.js";
import { minimalHittingSets } from "./hittingSets.js";
import { ReasonerStalledError } from "./types.js";
import type { Axiom, AxiomJustification, Repair, RepairOptions, RepairResult } from "./types.js";

export interface RepairOracle {
  /** True when the quad set is inconsistent; "aborted" when the deadline cut the check short. */
  inconsistent(quads: Quad[]): Promise<boolean | "aborted">;
  /** Minimal inconsistent subsets (flat triples) of an inconsistent quad set; [] when none were found. */
  explain(quads: Quad[], maxJustifications: number): Promise<Quad[][]>;
}

export const REPAIR_DEFAULT_TIMEOUT_MS = 300_000;

export async function computeRepairs(args: {
  store: Store;
  base: Quad[];
  graphsToIgnore: ReadonlySet<string>;
  oracle: RepairOracle;
  opts?: RepairOptions;
  deadline: number;
}): Promise<RepairResult> {
  const { store, base, graphsToIgnore, oracle, deadline } = args;
  const maxJustifications = args.opts?.maxJustifications ?? 3;
  const maxRepairs = args.opts?.maxRepairs ?? 10;
  const maxRounds = args.opts?.maxRounds ?? 10;
  const verify = args.opts?.verify ?? true;
  const cost = args.opts?.cost;
  const expired = () => Date.now() >= deadline;

  const result: RepairResult = { consistent: false, justifications: [], repairs: [], incomplete: false };
  const stop = (reason: NonNullable<RepairResult["reason"]>): RepairResult => {
    result.incomplete = true;
    result.reason ??= reason;
    finish();
    return result;
  };

  const axiomByKey = new Map<string, Axiom>();
  const justKeys: string[][] = [];
  const justSeen = new Set<string>();
  const repairKeys: string[][] = [];

  const addJustifications = (flat: Quad[][]): number => {
    let added = 0;
    for (const j of flat) {
      const grouped: AxiomJustification = groupJustification(j, store, graphsToIgnore);
      const keys = grouped.axioms.map(axiomKey);
      if (keys.length === 0) continue;
      const id = [...keys].sort().join("\n");
      if (justSeen.has(id)) continue;
      justSeen.add(id);
      grouped.axioms.forEach((a, i) => {
        if (!axiomByKey.has(keys[i])) axiomByKey.set(keys[i], a);
      });
      result.justifications.push(grouped);
      justKeys.push(keys);
      added++;
    }
    return added;
  };

  const editedWithout = (keys: string[]): Quad[] => {
    const removed = new Set(keys.flatMap(k => axiomByKey.get(k)!.quads.map(quadKey)));
    return base.filter(q => !removed.has(quadKey(q)));
  };

  // Fill `covers` last: justifications keep growing while the loop runs.
  const finish = (): void => {
    result.repairs.forEach((r, i) => {
      const set = new Set(repairKeys[i]);
      r.covers = justKeys.flatMap((keys, idx) => (keys.some(k => set.has(k)) ? [idx] : []));
    });
  };

  const totalCost = (keys: string[]): number => (cost ? keys.reduce((sum, k) => sum + cost(axiomByKey.get(k)!), 0) : 0);

  const inc0 = await oracle.inconsistent(base);
  if (inc0 === "aborted") return stop("deadline");
  if (!inc0) {
    result.consistent = true;
    return result;
  }

  try {
    if (addJustifications(await oracle.explain(base, maxJustifications)) === 0) {
      return stop(expired() ? "deadline" : "explain-failed");
    }
  } catch (e) {
    if (e instanceof ReasonerStalledError) throw e;
    return stop("explain-failed");
  }

  const tried = new Set<string>();
  for (let round = 0; ; round++) {
    const candidates = minimalHittingSets(justKeys).sort((a, b) => totalCost(a) - totalCost(b) || a.length - b.length);
    let grew = false;
    for (const cand of candidates) {
      const id = [...cand].sort().join("\n");
      if (tried.has(id)) continue;
      if (result.repairs.length >= maxRepairs) return stop("solution-cap");
      if (expired()) return stop("deadline");
      tried.add(id);

      let verified: boolean | null = null;
      if (verify) {
        const edited = editedWithout(cand);
        let inc: boolean | "aborted";
        try {
          inc = await oracle.inconsistent(edited);
        } catch (e) {
          if (e instanceof ReasonerStalledError) throw e;
          result.incomplete = true;
          result.reason ??= "verify-failed";
          inc = "aborted";
        }
        if (inc === "aborted") {
          if (result.reason === "verify-failed") continue; // this candidate stays unverified and is not reported
          return stop("deadline");
        }
        if (inc) {
          if (round >= maxRounds) return stop("round-cap");
          let added = 0;
          try {
            added = addJustifications(await oracle.explain(edited, maxJustifications));
          } catch (e) {
            if (e instanceof ReasonerStalledError) throw e;
            return stop("explain-failed");
          }
          if (added > 0) {
            grew = true;
            break; // recompute the candidates from the grown justification family
          }
          continue; // no new justification found (deadline cut the search): candidate cannot be confirmed
        }
        verified = true;
      }
      result.repairs.push({
        remove: cand.map(k => axiomByKey.get(k)!),
        covers: [],
        verifiedConsistent: verified,
        minimal: verified === true ? true : null,
      } satisfies Repair);
      repairKeys.push(cand);
    }
    if (!grew) break;
  }
  finish();
  return result;
}
