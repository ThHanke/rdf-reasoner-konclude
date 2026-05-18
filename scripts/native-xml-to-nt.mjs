#!/usr/bin/env node
/**
 * native-xml-to-nt.mjs
 *
 * Converts Konclude OWL/XML classification output to sorted NTriples.
 * Extracts SubClassOf and EquivalentClasses axioms and writes them as
 * canonical NTriples golden-reference fixtures.
 *
 * Usage:
 *   node scripts/native-xml-to-nt.mjs <input.xml> <output.nt>
 */

import { readFileSync, writeFileSync } from "fs";

const RDFS_SUBCLASSOF =
  "http://www.w3.org/2000/01/rdf-schema#subClassOf";
const OWL_EQUIVALENT_CLASS =
  "http://www.w3.org/2002/07/owl#equivalentClass";

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
 * Elements where any child uses abbreviatedIRI (e.g. owl:Thing via
 * abbreviated form) are skipped. Full IRI="..." form is always used
 * in Konclude output so this is defensive only.
 */
function parseXmlToTriples(xml) {
  const triples = [];

  // Match <SubClassOf> blocks (including whitespace between tags)
  const subClassPattern =
    /<SubClassOf>\s*<Class IRI="([^"]+)"\/>\s*<Class IRI="([^"]+)"\/>\s*<\/SubClassOf>/g;
  let m;
  while ((m = subClassPattern.exec(xml)) !== null) {
    triples.push(triple(m[1], RDFS_SUBCLASSOF, m[2]));
  }

  // Match <EquivalentClasses> blocks
  const equivPattern =
    /<EquivalentClasses>([\s\S]*?)<\/EquivalentClasses>/g;
  while ((m = equivPattern.exec(xml)) !== null) {
    const block = m[1];
    const memberPattern = /<Class IRI="([^"]+)"\/>/g;
    const members = [];
    let mm;
    while ((mm = memberPattern.exec(block)) !== null) {
      members.push(mm[1]);
    }
    // Emit all ordered pairs i≠j
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

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2) {
    console.error("Usage: node scripts/native-xml-to-nt.mjs <input.xml> <output.nt>");
    process.exit(1);
  }
  const [inputPath, outputPath] = args;

  const xml = readFileSync(inputPath, "utf8");
  const triples = parseXmlToTriples(xml);

  // Lexicographic sort for deterministic canonical output
  triples.sort();

  const content = triples.join("\n") + "\n";
  writeFileSync(outputPath, content, "utf8");

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

main();
