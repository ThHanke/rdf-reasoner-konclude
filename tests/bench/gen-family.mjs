// Generate a scaled family ontology in NTriples format.
// Usage: node gen-family.mjs [generations] [children-per-couple] > family-N.nt
//
// Produces the same TBox as mini-family.nt but with a larger ABox.
// Each generation doubles married couples to create exponential growth.

const GENS = parseInt(process.argv[2] || '4', 10);
const KIDS = parseInt(process.argv[3] || '3', 10);

const NS = 'http://example.org/family#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const OWL = 'http://www.w3.org/2002/07/owl#';

const triples = [];
function t(s, p, o) { triples.push(`<${s}> <${p}> <${o}> .`); }
function tbo(s, p, o) { triples.push(`<${s}> <${p}> ${o} .`); }
function tb(s, p, o) { triples.push(`${s} <${p}> <${o}> .`); }
function tbb(s, p, o) { triples.push(`${s} <${p}> ${o} .`); }

// ── TBox (identical to mini-family.nt) ──────────────────────────────────────
t(NS.slice(0,-1), RDF+'type', OWL+'Ontology');
t(NS+'Person', RDF+'type', OWL+'Class');
t(NS+'Man', RDF+'type', OWL+'Class');
t(NS+'Man', RDFS+'subClassOf', NS+'Person');
t(NS+'Woman', RDF+'type', OWL+'Class');
t(NS+'Woman', RDFS+'subClassOf', NS+'Person');
t(NS+'Man', OWL+'disjointWith', NS+'Woman');

function declProp(name, ...chars) {
  t(NS+name, RDF+'type', OWL+'ObjectProperty');
  for (const c of chars) t(NS+name, RDF+'type', OWL+c);
}
function subProp(sub, sup) { t(NS+sub, RDFS+'subPropertyOf', NS+sup); }
function inverseProp(a, b) { t(NS+a, OWL+'inverseOf', NS+b); }
function domain(p, c) { t(NS+p, RDFS+'domain', NS+c); }
function range(p, c) { t(NS+p, RDFS+'range', NS+c); }

declProp('isRelationOf', 'SymmetricProperty', 'TransitiveProperty');
domain('isRelationOf', 'Person'); range('isRelationOf', 'Person');

declProp('isBloodRelationOf', 'SymmetricProperty', 'TransitiveProperty');
subProp('isBloodRelationOf', 'isRelationOf');

declProp('isInLawOf', 'SymmetricProperty');
subProp('isInLawOf', 'isRelationOf');

declProp('isSpouseOf', 'SymmetricProperty');
subProp('isSpouseOf', 'isInLawOf');

declProp('hasParent'); inverseProp('hasParent', 'isParentOf');
subProp('hasParent', 'hasAncestor');
declProp('isParentOf');

declProp('hasFather', 'FunctionalProperty');
subProp('hasFather', 'hasParent'); subProp('hasFather', 'hasForeFather');
inverseProp('hasFather', 'isFatherOf');
domain('hasFather', 'Person'); range('hasFather', 'Man');
declProp('isFatherOf');

declProp('hasMother', 'FunctionalProperty');
subProp('hasMother', 'hasParent'); subProp('hasMother', 'hasForeMother');
inverseProp('hasMother', 'isMotherOf');
domain('hasMother', 'Person'); range('hasMother', 'Woman');
declProp('isMotherOf');

declProp('hasChild'); inverseProp('hasChild', 'isChildOf');
declProp('isChildOf');

declProp('hasAncestor'); subProp('hasAncestor', 'isBloodRelationOf');
inverseProp('hasAncestor', 'isAncestorOf');
declProp('isAncestorOf');

declProp('hasForeFather', 'TransitiveProperty');
subProp('hasForeFather', 'hasAncestor');
inverseProp('hasForeFather', 'isForefatherOf');
declProp('isForefatherOf');

declProp('hasForeMother', 'TransitiveProperty');
subProp('hasForeMother', 'hasAncestor');
inverseProp('hasForeMother', 'isForemotherOf');
declProp('isForemotherOf');

declProp('isSiblingOf', 'SymmetricProperty');
subProp('isSiblingOf', 'isBloodRelationOf');

declProp('directSiblingOf', 'SymmetricProperty');
subProp('directSiblingOf', 'isSiblingOf');

declProp('brotherOf'); subProp('brotherOf', 'directSiblingOf');
inverseProp('brotherOf', 'hasBrother'); domain('brotherOf', 'Man');
declProp('hasBrother');

declProp('sisterOf'); subProp('sisterOf', 'directSiblingOf');
inverseProp('sisterOf', 'hasSister'); domain('sisterOf', 'Woman');
declProp('hasSister');

declProp('hasWife'); subProp('hasWife', 'isSpouseOf');
inverseProp('hasWife', 'isWifeOf');
domain('hasWife', 'Man'); range('hasWife', 'Woman');
declProp('isWifeOf');

declProp('hasHusband'); subProp('hasHusband', 'isSpouseOf');
inverseProp('hasHusband', 'isHusbandOf');
domain('hasHusband', 'Woman'); range('hasHusband', 'Man');
declProp('isHusbandOf');

declProp('isFirstCousinOf', 'SymmetricProperty');
subProp('isFirstCousinOf', 'isBloodRelationOf');

// Property chain: isFirstCousinOf = hasParent o isSiblingOf o isParentOf
tbo(NS+'isFirstCousinOf', OWL+'propertyChainAxiom', '_:cl1');
tb('_:cl1', RDF+'first', NS+'hasParent');
tbb('_:cl1', RDF+'rest', '_:cl2');
tb('_:cl2', RDF+'first', NS+'isSiblingOf');
tbb('_:cl2', RDF+'rest', '_:cl3');
tb('_:cl3', RDF+'first', NS+'isParentOf');
tb('_:cl3', RDF+'rest', RDF+'nil');

declProp('isParentInLawOf');
subProp('isParentInLawOf', 'isInLawOf');

// Property chain: isParentInLawOf = isParentOf o isSpouseOf
tbo(NS+'isParentInLawOf', OWL+'propertyChainAxiom', '_:pl1');
tb('_:pl1', RDF+'first', NS+'isParentOf');
tbb('_:pl1', RDF+'rest', '_:pl2');
tb('_:pl2', RDF+'first', NS+'isSpouseOf');
tb('_:pl2', RDF+'rest', RDF+'nil');

// ── ABox generation ─────────────────────────────────────────────────────────

let nextId = 0;
function makePerson(gender, tag) {
  const id = `${tag}_${nextId++}`;
  t(NS+id, RDF+'type', OWL+'NamedIndividual');
  t(NS+id, RDF+'type', NS+(gender === 'M' ? 'Man' : 'Woman'));
  return { id, gender };
}

function assertFather(child, father) {
  t(NS+father.id, NS+'isFatherOf', NS+child.id);
}
function assertMother(child, mother) {
  t(NS+mother.id, NS+'isMotherOf', NS+child.id);
}
function assertSiblings(siblings) {
  for (let i = 0; i < siblings.length; i++) {
    for (let j = 0; j < siblings.length; j++) {
      if (i === j) continue;
      const prop = siblings[j].gender === 'M' ? 'hasBrother' : 'hasSister';
      t(NS+siblings[i].id, NS+prop, NS+siblings[j].id);
    }
  }
}
function assertMarriage(husband, wife) {
  t(NS+husband.id, NS+'hasWife', NS+wife.id);
}

// Build family tree generation by generation.
// Each generation: list of couples. Each couple produces KIDS children.
// First child of opposite gender marries an outsider spouse (new individual).
let couples = [];

// Gen 0: founding couple
const gf = makePerson('M', 'g0');
const gm = makePerson('F', 'g0');
assertMarriage(gf, gm);
couples.push({ father: gf, mother: gm });

for (let gen = 1; gen < GENS; gen++) {
  const nextCouples = [];
  for (const couple of couples) {
    const children = [];
    for (let k = 0; k < KIDS; k++) {
      const gender = k % 2 === 0 ? 'M' : 'F';
      const child = makePerson(gender, `g${gen}`);
      assertFather(child, couple.father);
      assertMother(child, couple.mother);
      children.push(child);
    }
    assertSiblings(children);

    // Marry some children to outsider spouses to create next generation
    for (const child of children) {
      const spouseGender = child.gender === 'M' ? 'F' : 'M';
      const spouse = makePerson(spouseGender, `g${gen}s`);
      if (child.gender === 'M') {
        assertMarriage(child, spouse);
        nextCouples.push({ father: child, mother: spouse });
      } else {
        assertMarriage(spouse, child);
        nextCouples.push({ father: spouse, mother: child });
      }
    }
  }
  couples = nextCouples;
}

process.stdout.write(triples.join('\n') + '\n');
process.stderr.write(`Generated ${nextId} individuals, ${triples.length} triples, ${GENS} generations, ${KIDS} children/couple\n`);
