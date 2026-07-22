import type { Quad } from "@rdfjs/types";
import { Store, DataFactory } from "n3";
import type { JustificationData } from "./intern.js";
import {
  KJ_JUSTIFICATION,
  KJ_JUSTIFIES,
  KJ_AXIOM,
} from "./types.js";

const { namedNode, quad } = DataFactory;
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

const kjJustificationType = namedNode(KJ_JUSTIFICATION);
const kjJustifiesPred = namedNode(KJ_JUSTIFIES);
const kjAxiomPred = namedNode(KJ_AXIOM);
const rdfTypePred = namedNode(RDF_TYPE);

export function serializeExplanations(
  store: Store,
  justData: JustificationData,
  inferredQuads: Quad[],
  explanationGraph: string,
): void {
  const explGraphNode = namedNode(explanationGraph);

  store.removeQuads(store.getQuads(null, null, null, explGraphNode));

  if (!justData || justData.entries.length === 0) return;

  const { axioms, entries, mappings } = justData;

  const jNodes = entries.map((entry) => {
    const jNode = namedNode(entry.iri);

    store.addQuad(quad(jNode, rdfTypePred, kjJustificationType, explGraphNode));

    for (const axiomIdx of entry.axiomIndices) {
      if (axiomIdx < axioms.length) {
        const aq = axioms[axiomIdx];
        const quotedAxiom = quad(aq.subject as any, aq.predicate, aq.object);
        store.addQuad(quad(jNode, kjAxiomPred, quotedAxiom as any, explGraphNode));
      }
    }

    return jNode;
  });

  for (const { tripleIdx, justIdx } of mappings) {
    if (justIdx < jNodes.length && tripleIdx < inferredQuads.length) {
      const iq = inferredQuads[tripleIdx];
      const quotedTriple = quad(iq.subject as any, iq.predicate, iq.object);
      store.addQuad(quad(jNodes[justIdx], kjJustifiesPred, quotedTriple as any, explGraphNode));
    }
  }
}
