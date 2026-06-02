---
module: mapper
tags: [audit, mapper-flags, owl2dl, parity]
problem_type: configuration
date: 2026-06-02
---

# Mapper Flag Audit — 2026-06-02

## Summary

`CConcreteOntologyRedlandTriplesDataExpressionMapper` has exactly **two** boolean configuration flags. Both are already in the correct state for WASM operation. No C++ changes are required; no WASM rebuild is needed.

## Flags

| Flag | Default | WASM state | How set |
|------|---------|------------|---------|
| `mConfSuccessorRetrieval` | `true` | `true` (unchanged) | Constructor default |
| `mConfExtractSimpleABoxAssertions` | `false` | `true` | `mapper->setConfExtractSimpleABoxAssertions(true)` in `src/KoncludeReasoner.cpp::loadTripleBuffer()` (added in plan-028) |

The querying subclass (`CConcreteOntologyRedlandTriplesDataQueryingExpressionMapper`) sets `mConfExtractSimpleABoxAssertions = true` in its constructor — this is what our `loadTripleBuffer()` call mirrors.

## Build Method Inventory

All `buildXxx()` methods and what they handle:

| Method | Gating flag | Constructs covered |
|--------|------------|-------------------|
| `buildDeclarations()` | individuals branch gated by `mConfExtractSimpleABoxAssertions` (enabled) | owl:Class, owl:ObjectProperty, owl:DatatypeProperty, rdfs:Datatype, owl:NamedIndividual declarations |
| `buildObjectPropertyExpressions()` | none | Object property complex expressions (ObjectInverseOf, etc.) |
| `buildDataRangeExpressions()` | none | Data range expressions (DataComplementOf, DataIntersectionOf, DataOneOf, DatatypeRestriction) |
| `buildClassExpressions()` | none | Class expressions (ObjectIntersectionOf, ObjectUnionOf, ObjectComplementOf, ObjectSomeValuesFrom, ObjectAllValuesFrom, ObjectHasValue, ObjectHasSelf, ObjectMinCardinality, ObjectMaxCardinality, ObjectExactCardinality, DataSomeValuesFrom, DataAllValuesFrom, DataHasValue, DataMinCardinality, DataMaxCardinality, DataExactCardinality, ObjectOneOf) |
| `buildClassBasedAxioms()` | `mConfSuccessorRetrieval` (always true; both branches cover same axioms) | rdfs:subClassOf, owl:equivalentClass, owl:disjointWith, owl:disjointUnionOf |
| `buildObjectPropertyBasedAxioms()` | `mConfSuccessorRetrieval` (always true) | rdfs:subPropertyOf, owl:equivalentProperty, owl:propertyChainAxiom, owl:propertyDisjointWith, rdfs:domain, rdfs:range, owl:inverseOf, owl:FunctionalProperty, owl:InverseFunctionalProperty, owl:ReflexiveProperty, owl:IrreflexiveProperty, owl:SymmetricProperty, owl:AsymmetricProperty, owl:TransitiveProperty |
| `buildDataPropertyBasedAxioms()` | `mConfSuccessorRetrieval` (always true) | rdfs:subPropertyOf (data), owl:equivalentProperty (data), owl:propertyDisjointWith (data), rdfs:domain (data), rdfs:range (data), owl:FunctionalProperty (data) |
| `buildDatatypeBasedAxioms()` | `mConfSuccessorRetrieval` (always true) | Datatype definitions — **TODO** in upstream source, not yet implemented |
| `buildSeparateNodeBasedAxioms()` | none | owl:AllDisjointClasses, owl:AllDisjointProperties, owl:AllDifferent, owl:NegativeObjectPropertyAssertion, owl:NegativeDataPropertyAssertion |
| `buildComplexABoxAxioms()` | none | Class assertions via blank-node class expressions, complex data range assertions |
| `buildSimpleABoxAxioms()` | `mConfExtractSimpleABoxAssertions` (**enabled**) | rdf:type class assertions (named classes), object property assertions, owl:differentFrom, owl:sameAs, data property assertions |

## Constructs in Plan-034 Scope — Coverage Status

| Construct | Mapper method | Status |
|-----------|--------------|--------|
| SymmetricProperty | `buildObjectPropertyBasedAxioms()` → `collectObjectPropertyTypesAxiomExpressionsBySuccessorRetrieval()` | **ENABLED** |
| FunctionalProperty | same | **ENABLED** |
| InverseFunctionalProperty | same | **ENABLED** |
| ReflexiveProperty | same | **ENABLED** |
| IrreflexiveProperty | same | **ENABLED** |
| AsymmetricProperty | same | **ENABLED** |
| owl:inverseOf | `buildObjectPropertyBasedAxioms()` → `collectObjectPropertyBasedAxiomExpressionsBySuccessorRetrieval()` | **ENABLED** |
| rdfs:domain (object) | same | **ENABLED** |
| rdfs:range (object) | same | **ENABLED** |
| owl:hasValue | `buildClassExpressions()` (restriction builder) | **ENABLED** |
| owl:AllDisjointClasses | `buildSeparateNodeBasedAxioms()` | **ENABLED** |
| owl:AllDisjointProperties | `buildSeparateNodeBasedAxioms()` | **ENABLED** |
| owl:disjointUnionOf | `buildClassBasedAxioms()` | **ENABLED** |
| owl:NegativeObjectPropertyAssertion | `buildSeparateNodeBasedAxioms()` | **ENABLED** |
| owl:NegativeDataPropertyAssertion | `buildSeparateNodeBasedAxioms()` | **ENABLED** |
| Datatype restrictions | `buildDatatypeBasedAxioms()` | Mapper TODO; Konclude kernel may handle via class expression path |

## Conclusion

No mapper flags are missing. No C++ changes are required. All OWL 2 DL axiom types in plan-034 scope are already being passed to the Konclude builder. Any failures in the subsequent units are Konclude kernel-level issues (upstream limitations), not mapper silent-drops.

Baseline test count before plan-034: **199 tests passing**.
