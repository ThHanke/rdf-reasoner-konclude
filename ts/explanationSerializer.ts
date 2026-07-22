import type { Quad } from "@rdfjs/types";
import { Store, DataFactory, Parser } from "n3";
import {
  KJ_JUSTIFICATION,
  KJ_JUSTIFIES,
  KJ_AXIOM,
} from "./types.js";

const { namedNode, blankNode, quad } = DataFactory;
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

const kjJustificationType = namedNode(KJ_JUSTIFICATION);
const kjJustifiesPred = namedNode(KJ_JUSTIFIES);
const kjAxiomPred = namedNode(KJ_AXIOM);
const rdfTypePred = namedNode(RDF_TYPE);

export function serializeExplanations(
  store: Store,
  bulkExport: string,
  explanationGraph: string,
): void {
  const explGraphNode = namedNode(explanationGraph);

  store.removeQuads(store.getQuads(null, null, null, explGraphNode));

  if (!bulkExport) return;

  const parser = new Parser({ format: "N-Triples" });
  let jCounter = 0;

  const entries = bulkExport.split("\0");
  for (const entry of entries) {
    if (!entry) continue;

    const newlineIdx = entry.indexOf("\n");
    if (newlineIdx < 0) continue;

    const keyLine = entry.slice(0, newlineIdx);
    const axiomBody = entry.slice(newlineIdx + 1);

    const parts = keyLine.split("\t");
    if (parts.length < 3) continue;

    const [sub, pred, obj] = parts;

    const jNode = blankNode(`j${jCounter++}`);

    const inferredTriple = buildQuotedTriple(sub, pred, obj);

    store.addQuad(quad(jNode, rdfTypePred, kjJustificationType, explGraphNode));
    store.addQuad(quad(jNode, kjJustifiesPred, inferredTriple, explGraphNode));

    if (axiomBody.trim()) {
      try {
        const axiomQuads = parser.parse(axiomBody);
        for (const aq of axiomQuads) {
          const quotedAxiom = quad(aq.subject, aq.predicate, aq.object);
          store.addQuad(quad(jNode, kjAxiomPred, quotedAxiom, explGraphNode));
        }
      } catch {
        // malformed NTriples — skip this entry's axioms
      }
    }
  }
}

function buildQuotedTriple(sub: string, pred: string, obj: string): Quad {
  const s = sub.startsWith("_:") ? blankNode(sub.slice(2)) : namedNode(sub);
  const p = namedNode(pred);
  const o = obj.startsWith("_:") ? blankNode(obj.slice(2)) : namedNode(obj);
  return quad(s as any, p, o);
}
