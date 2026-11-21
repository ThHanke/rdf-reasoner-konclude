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
const OWL_RESTRICTION = "http://www.w3.org/2002/07/owl#Restriction";
const OWL_ON_PROPERTY = "http://www.w3.org/2002/07/owl#onProperty";
const OWL_HAS_VALUE = "http://www.w3.org/2002/07/owl#hasValue";
const XSD_STRING = "http://www.w3.org/2001/XMLSchema#string";

export type ProbeKind =
  | "subClassOf"
  | "type"
  | "sameAs"
  | "equivalentProperty"
  | "disjointWith"
  | "equivalentClass"
  | "subPropertyOf"
  | "dataProperty"
  | "objectPropertyAssertion"
  | "dataPropertyAssertion"
  | "unsupported";

/** Declared kind of the predicate of a property assertion `a P o` (the caller looks up the declaration). */
export type AssertionPropertyType = "object" | "data";

export interface ProbeOptions {
  /** Predicate is a declared object / data property: `a P o` is a property assertion with an exact probe. */
  propertyType?: AssertionPropertyType;
  /** Literal of a data-property assertion (default xsd:string, or rdf:langString with `objectLanguage`). */
  objectDatatype?: string;
  objectLanguage?: string;
}

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
  propertyType?: AssertionPropertyType,
): ProbeKind {
  if (predicateIri === OWL_SAME_AS) return "sameAs";
  if (predicateIri === OWL_EQUIVALENT_PROPERTY) return "equivalentProperty";

  if (!objectIsClassLike) return propertyType === "data" ? "dataPropertyAssertion" : "dataProperty";

  if (predicateIri === RDFS_SUBCLASSOF) return "subClassOf";
  if (predicateIri === RDF_TYPE) return "type";
  if (predicateIri === OWL_DISJOINT_WITH) return "disjointWith";
  if (predicateIri === OWL_EQUIVALENT_CLASS) return "equivalentClass";
  if (predicateIri === RDFS_SUB_PROPERTY_OF) return "subPropertyOf";
  if (propertyType === "object") return "objectPropertyAssertion";
  return "unsupported";
}

export function buildEntailmentProbe(
  subjectIri: string,
  predicateIri: string,
  objectIri: string,
  objectIsClassLike: boolean,
  probeId = "p0",
  opts: ProbeOptions = {},
): ProbePlan {
  const kind = classifyAxiom(predicateIri, objectIsClassLike, opts.propertyType);
  if (kind === "unsupported") {
    return {
      kind,
      probeQuads: [],
      probeKeys: new Set(),
      reason: `predicate ${predicateIri} is not a supported entailment shape`,
    };
  }

  if (kind === "objectPropertyAssertion" || kind === "dataPropertyAssertion") {
    return propertyAssertionProbe(kind, subjectIri, predicateIri, objectIri, probeId, opts);
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
    const witnessKey = `urn:vg:witness:${probeId}`;
    const witness = namedNode(witnessKey);
    // Fresh witness in A and in ¬B; NO global A ⊑ ¬B axiom (it would clash with any record individual that is both A and B).
    push(witness, witnessKey, RDF_TYPE, subjNode, subjectIri);
    push(witness, witnessKey, RDF_TYPE, negClass, negClassKey);
  } else {
    const subjNode = namedNode(subjectIri);
    push(subjNode, subjectIri, RDF_TYPE, negClass, negClassKey);
  }

  return { kind, probeQuads: quads, probeKeys: keys };
}

/**
 * `R(a, b)` is entailed iff O plus `a : not (R value b)` is inconsistent; the same for a data property `P(a, v)` with
 * the literal v. `not (R value b)` is the class `forall R. not {b}` (OWL 2 DL, nominals); the hasValue form needs no
 * owl:oneOf list and no owl:datatypeComplementOf, so object and data properties share one encoding.
 */
function propertyAssertionProbe(
  kind: ProbeKind, subjectIri: string, predicateIri: string, objectValue: string, probeId: string, opts: ProbeOptions,
): ProbePlan {
  const { namedNode, blankNode, literal, quad, defaultGraph } = DataFactory;
  const g = defaultGraph();
  const negKey = `vg_neg_${probeId}`;
  const resKey = `vg_res_${probeId}`;
  const neg = blankNode(negKey);
  const res = blankNode(resKey);
  const value = kind === "dataPropertyAssertion"
    ? literal(objectValue, opts.objectLanguage ? opts.objectLanguage : namedNode(opts.objectDatatype ?? XSD_STRING))
    : namedNode(objectValue);
  const triples: Array<[any, string, any]> = [
    [neg, RDF_TYPE, namedNode(OWL_CLASS)],
    [neg, OWL_COMPLEMENT_OF, res],
    [res, RDF_TYPE, namedNode(OWL_RESTRICTION)],
    [res, OWL_ON_PROPERTY, namedNode(predicateIri)],
    [res, OWL_HAS_VALUE, value],
    [namedNode(subjectIri), RDF_TYPE, neg],
  ];
  const probeQuads = triples.map(([s, p, o]) => quad(s, namedNode(p), o, g) as Quad);
  const probeKeys = new Set(probeQuads.map(q => tripleKey(q.subject.value, q.predicate.value, q.object.value)));
  return { kind, probeQuads, probeKeys };
}

// ---------------------------------------------------------------------------
// Property characteristics and declarations (round 66)
// ---------------------------------------------------------------------------

const OWL_NS = "http://www.w3.org/2002/07/owl#";
const SAME_AS_DIFFERENT = OWL_NS + "differentFrom";
/** Characteristic classes `P rdf:type C` that are decided by a probe with fresh individuals. */
export type CharacteristicKind = "transitive" | "symmetric" | "asymmetric" | "reflexive" | "irreflexive" | "functional" | "inverseFunctional";
export const CHARACTERISTIC_CLASSES: Readonly<Record<string, CharacteristicKind>> = {
  [OWL_NS + "TransitiveProperty"]: "transitive",
  [OWL_NS + "SymmetricProperty"]: "symmetric",
  [OWL_NS + "AsymmetricProperty"]: "asymmetric",
  [OWL_NS + "ReflexiveProperty"]: "reflexive",
  [OWL_NS + "IrreflexiveProperty"]: "irreflexive",
  [OWL_NS + "FunctionalProperty"]: "functional",
  [OWL_NS + "InverseFunctionalProperty"]: "inverseFunctional",
};
/** `X rdf:type C` for these C is a declaration: it has no semantics and every ontology entails it (OWL 2 direct semantics). */
export const DECLARATION_CLASSES: ReadonlySet<string> = new Set([
  OWL_NS + "Class", OWL_NS + "ObjectProperty", OWL_NS + "DatatypeProperty", OWL_NS + "AnnotationProperty", OWL_NS + "NamedIndividual",
  "http://www.w3.org/2000/01/rdf-schema#Datatype",
]);

/**
 * `P` has the characteristic iff O plus the probe is inconsistent. The probe uses fresh individuals: e.g. transitivity of P
 * is refuted by `x P y`, `y P z`, `x : not (P value z)`; reflexivity by `x : not Self(P)`; functionality by `x P y`, `x P z`, `y differentFrom z`.
 */
export function buildCharacteristicProbe(kind: CharacteristicKind, propertyIri: string, probeId: string): Quad[] {
  const { namedNode, blankNode, quad, defaultGraph } = DataFactory;
  const g = defaultGraph();
  const ind = (n: string) => namedNode(`urn:vg:probe:${n}_${probeId}`);
  const P = namedNode(propertyIri);
  const out: Quad[] = [];
  const add = (s: any, p: string, o: any) => out.push(quad(s, namedNode(p), o, g) as Quad);
  const notHasValue = (n: string, subject: any, value: any) => {
    const res = blankNode(`vg_res_${n}_${probeId}`), neg = blankNode(`vg_neg_${n}_${probeId}`);
    add(res, RDF_TYPE, namedNode(OWL_RESTRICTION)); add(res, OWL_ON_PROPERTY, P); add(res, OWL_HAS_VALUE, value);
    add(neg, RDF_TYPE, namedNode(OWL_CLASS)); add(neg, OWL_COMPLEMENT_OF, res); add(subject, RDF_TYPE, neg);
  };
  const selfClass = (n: string, subject: any, negated: boolean) => {
    const res = blankNode(`vg_self_${n}_${probeId}`);
    add(res, RDF_TYPE, namedNode(OWL_RESTRICTION)); add(res, OWL_ON_PROPERTY, P);
    add(res, OWL_NS + "hasSelf", DataFactory.literal("true", namedNode("http://www.w3.org/2001/XMLSchema#boolean")));
    if (!negated) { add(subject, RDF_TYPE, res); return; }
    const neg = blankNode(`vg_negself_${n}_${probeId}`);
    add(neg, RDF_TYPE, namedNode(OWL_CLASS)); add(neg, OWL_COMPLEMENT_OF, res); add(subject, RDF_TYPE, neg);
  };
  const x = ind("x"), y = ind("y"), z = ind("z");
  switch (kind) {
    case "transitive": add(x, propertyIri, y); add(y, propertyIri, z); notHasValue("t", x, z); break;
    case "symmetric": add(x, propertyIri, y); notHasValue("s", y, x); break;
    case "asymmetric": add(x, propertyIri, y); add(y, propertyIri, x); break;
    case "reflexive": selfClass("r", x, true); break;
    case "irreflexive": selfClass("i", x, false); break;
    case "functional": add(x, propertyIri, y); add(x, propertyIri, z); add(y, SAME_AS_DIFFERENT, z); break;
    case "inverseFunctional": add(y, propertyIri, x); add(z, propertyIri, x); add(y, SAME_AS_DIFFERENT, z); break;
  }
  return out;
}
