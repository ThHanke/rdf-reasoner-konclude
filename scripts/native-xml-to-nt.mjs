#!/usr/bin/env node
/**
 * native-xml-to-nt.mjs
 *
 * Converts Konclude OWL/XML classification or realization output to sorted
 * NTriples. Extracts SubClassOf and EquivalentClasses axioms (TBox mode) or
 * ClassAssertion axioms (ABox mode) and writes them as canonical NTriples
 * golden-reference fixtures.
 *
 * Usage:
 *   node scripts/native-xml-to-nt.mjs <input.xml> <output.nt>
 *   node scripts/native-xml-to-nt.mjs --mode abox <input.xml> <output.nt>
 *   node scripts/native-xml-to-nt.mjs --mode tbox <input.xml> <output.nt>
 *
 * Default mode (no flag): tbox
 */

import { readFileSync, writeFileSync } from "fs";

const RDFS_SUBCLASSOF =
  "http://www.w3.org/2000/01/rdf-schema#subClassOf";
const OWL_EQUIVALENT_CLASS =
  "http://www.w3.org/2002/07/owl#equivalentClass";
const RDF_TYPE =
  "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

/**
 * Formats a single NTriples line from three IRI strings.
 */
function triple(subject, predicate, object) {
  return `<${subject}> <${predicate}> <${object}> .`;
}

/**
 * Parses OWL/XML content and returns an array of NTriples lines.
 *
 * Handles:
 *  - <SubClassOf> with two <Class IRI="..."/> children
 *  - <EquivalentClasses> with N <Class IRI="..."/> children
 *    (emits all N*(N-1) ordered pairs)
 *
 * SubClassOf subjects and objects are normalized to the lexicographically
 * smallest IRI in their equivalence class, matching the WASM nodeRep rule.
 * EquivalentClasses pairs are emitted as-is (all N*(N-1) pairs, no normalization).
 *
 * Elements where any child uses abbreviatedIRI (e.g. owl:Thing via
 * abbreviated form) are skipped. Full IRI="..." form is always used
 * in Konclude output so this is defensive only.
 */
function parseXmlToTriples(xml) {
  const triples = [];

  // Pass 1: build equivalence map — each IRI → lex-min IRI in its group
  const equivMap = new Map();
  const equivPattern =
    /<EquivalentClasses>([\s\S]*?)<\/EquivalentClasses>/g;
  let m;
  while ((m = equivPattern.exec(xml)) !== null) {
    const block = m[1];
    const memberPattern = /<Class IRI="([^"]+)"\/>/g;
    const members = [];
    let mm;
    while ((mm = memberPattern.exec(block)) !== null) {
      members.push(mm[1]);
    }
    if (members.length < 2) continue;
    const canon = members.reduce((a, b) => (b < a ? b : a));
    for (const iri of members) {
      equivMap.set(iri, canon);
    }
  }

  const norm = (iri) => equivMap.get(iri) ?? iri;

  // Pass 2: SubClassOf — normalize subject and object through equivMap
  const subClassPattern =
    /<SubClassOf>\s*<Class IRI="([^"]+)"\/>\s*<Class IRI="([^"]+)"\/>\s*<\/SubClassOf>/g;
  while ((m = subClassPattern.exec(xml)) !== null) {
    triples.push(triple(norm(m[1]), RDFS_SUBCLASSOF, norm(m[2])));
  }

  // Pass 3: EquivalentClasses pairs (emit all N*(N-1), no normalization)
  equivPattern.lastIndex = 0;
  while ((m = equivPattern.exec(xml)) !== null) {
    const block = m[1];
    const memberPattern = /<Class IRI="([^"]+)"\/>/g;
    const members = [];
    let mm;
    while ((mm = memberPattern.exec(block)) !== null) {
      members.push(mm[1]);
    }
    for (let i = 0; i < members.length; i++) {
      for (let j = 0; j < members.length; j++) {
        if (i !== j) {
          triples.push(triple(members[i], OWL_EQUIVALENT_CLASS, members[j]));
        }
      }
    }
  }

  return triples;
}

/**
 * Parses OWL/XML realization output and returns an array of NTriples lines.
 *
 * Handles:
 *  - <ClassAssertion> with <Class IRI="..."/> and <NamedIndividual IRI="..."/>
 *
 * Emits:  <individual> rdf:type <class> .
 */
function parseXmlToABoxTriples(xml) {
  const triples = [];

  // Match <ClassAssertion> blocks (including whitespace between tags)
  const classAssertionPattern =
    /<ClassAssertion>\s*<Class IRI="([^"]+)"\/>\s*<NamedIndividual IRI="([^"]+)"\/>\s*<\/ClassAssertion>/g;
  let m;
  while ((m = classAssertionPattern.exec(xml)) !== null) {
    triples.push(triple(m[2], RDF_TYPE, m[1]));
  }

  return triples;
}

function main() {
  const rawArgs = process.argv.slice(2);

  // Parse optional --mode flag
  let mode = "tbox";
  const args = [];
  for (let i = 0; i < rawArgs.length; i++) {
    if (rawArgs[i] === "--mode" && i + 1 < rawArgs.length) {
      mode = rawArgs[++i];
    } else {
      args.push(rawArgs[i]);
    }
  }

  if (args.length !== 2) {
    console.error(
      "Usage: node scripts/native-xml-to-nt.mjs [--mode tbox|abox] <input.xml> <output.nt>"
    );
    process.exit(1);
  }
  const [inputPath, outputPath] = args;

  const xml = readFileSync(inputPath, "utf8");
  let triples;

  if (mode === "abox") {
    triples = parseXmlToABoxTriples(xml);
  } else {
    triples = parseXmlToTriples(xml);
  }

  // Lexicographic sort for deterministic canonical output
  triples.sort();

  const content = triples.join("\n") + "\n";
  writeFileSync(outputPath, content, "utf8");

  if (mode === "abox") {
    console.log(
      `Wrote ${triples.length} triples to ${outputPath}` +
        ` (rdf:type assertions)`
    );
  } else {
    // Count by predicate for reporting
    const subCount = triples.filter((t) => t.includes(RDFS_SUBCLASSOF)).length;
    const equivCount = triples.filter((t) =>
      t.includes(OWL_EQUIVALENT_CLASS)
    ).length;
    console.log(
      `Wrote ${triples.length} triples to ${outputPath}` +
        ` (subClassOf: ${subCount}, equivalentClass: ${equivCount})`
    );
  }
}

main();
