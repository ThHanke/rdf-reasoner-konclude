import type { Quad } from "@rdfjs/types";
import { DataFactory } from "n3";

const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const RDFS_SUBCLASSOF = "http://www.w3.org/2000/01/rdf-schema#subClassOf";
const OWL_CLASS = "http://www.w3.org/2002/07/owl#Class";
const OWL_COMPLEMENT_OF = "http://www.w3.org/2002/07/owl#complementOf";
const OWL_SAME_AS = "http://www.w3.org/2002/07/owl#sameAs";
const OWL_EQUIVALENT_PROPERTY = "http://www.w3.org/2002/07/owl#equivalentProperty";
const OWL_DISJOINT_WITH = "http://www.w3.org/2002/07/owl#disjointWith";
const OWL_EQUIVALENT_CLASS = "http://www.w3.org/2002/07/owl#equivalentClass";
const RDFS_SUB_PROPERTY_OF = "http://www.w3.org/2000/01/rdf-schema#subPropertyOf";

export type ProbeKind =
  | "subClassOf"
  | "type"
  | "sameAs"
  | "equivalentProperty"
  | "disjointWith"
  | "equivalentClass"
  | "subPropertyOf"
  | "dataProperty"
  | "unsupported";

export interface ProbePlan {
  kind: ProbeKind;
  probeQuads: Quad[];
  probeKeys: Set<string>;
  reason?: string;
}

export function tripleKey(s: string, p: string, o: string): string {
  return `${s}\0${p}\0${o}`;
}

export function classifyAxiom(
  predicateIri: string,
  objectIsClassLike: boolean,
): ProbeKind {
  if (predicateIri === OWL_SAME_AS) return "sameAs";
  if (predicateIri === OWL_EQUIVALENT_PROPERTY) return "equivalentProperty";

  if (!objectIsClassLike) return "dataProperty";

  if (predicateIri === RDFS_SUBCLASSOF) return "subClassOf";
  if (predicateIri === RDF_TYPE) return "type";
  if (predicateIri === OWL_DISJOINT_WITH) return "disjointWith";
  if (predicateIri === OWL_EQUIVALENT_CLASS) return "equivalentClass";
  if (predicateIri === RDFS_SUB_PROPERTY_OF) return "subPropertyOf";
  return "unsupported";
}

export function buildEntailmentProbe(
  subjectIri: string,
  predicateIri: string,
  objectIri: string,
  objectIsClassLike: boolean,
  probeId = "p0",
): ProbePlan {
  const kind = classifyAxiom(predicateIri, objectIsClassLike);
  if (kind === "unsupported") {
    return {
      kind,
      probeQuads: [],
      probeKeys: new Set(),
      reason: `predicate ${predicateIri} is not a supported entailment shape`,
    };
  }

  if (kind !== "subClassOf" && kind !== "type") {
    return {
      kind,
      probeQuads: [],
      probeKeys: new Set(),
      reason: `${kind} entailments use TS synthesis, not the BlackBox probe path`,
    };
  }

  const { namedNode, blankNode, quad, defaultGraph } = DataFactory;
  const g = defaultGraph();
  const owlClass = namedNode(OWL_CLASS);
  const negClass = blankNode(`vg_neg_${probeId}`);
  const objNode = namedNode(objectIri);

  const quads: Quad[] = [];
  const keys = new Set<string>();
  const push = (
    s: ReturnType<typeof namedNode> | ReturnType<typeof blankNode>,
    sKey: string,
    p: string,
    o: ReturnType<typeof namedNode> | ReturnType<typeof blankNode>,
    oKey: string,
  ): void => {
    quads.push(quad(s as any, namedNode(p) as any, o as any, g) as Quad);
    keys.add(tripleKey(sKey, p, oKey));
  };

  const negClassKey = `vg_neg_${probeId}`;
  push(negClass, negClassKey, RDF_TYPE, owlClass, OWL_CLASS);
  push(negClass, negClassKey, OWL_COMPLEMENT_OF, objNode, objectIri);

  if (kind === "subClassOf") {
    const subjNode = namedNode(subjectIri);
    const witness = blankNode(`vg_wit_${probeId}`);
    const witnessKey = `vg_wit_${probeId}`;
    push(subjNode, subjectIri, RDFS_SUBCLASSOF, negClass, negClassKey);
    push(witness, witnessKey, RDF_TYPE, subjNode, subjectIri);
  } else {
    const subjNode = namedNode(subjectIri);
    push(subjNode, subjectIri, RDF_TYPE, negClass, negClassKey);
  }

  return { kind, probeQuads: quads, probeKeys: keys };
}
