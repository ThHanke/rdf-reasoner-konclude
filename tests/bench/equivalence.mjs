// tests/bench/equivalence.mjs — compare role assertions modulo equivalent/inverse roles declared in the input.
// Konclude picks one representative per equivalent-role class (e.g. hasChild vs isParentOf); which one is not stable across builds.
const OWL_EQ = 'http://www.w3.org/2002/07/owl#equivalentProperty';
const OWL_INV = 'http://www.w3.org/2002/07/owl#inverseOf';

/** Union-find over roles with orientation: find(r) -> { rep, flipped }. Built from equivalentProperty (same) and inverseOf (flipped). */
export function buildRoleClasses(inputQuads) {
  const parent = new Map(); // role -> { to, flip }
  const find = (r) => {
    if (!parent.has(r)) return { rep: r, flip: false };
    const p = parent.get(r);
    const up = find(p.to);
    return { rep: up.rep, flip: p.flip !== up.flip };
  };
  const union = (a, b, flip) => {
    const fa = find(a), fb = find(b);
    if (fa.rep === fb.rep) return;
    // attach the lexicographically larger representative below the smaller one (stable canonical choice)
    const [child, root, cf, rf] = fa.rep > fb.rep ? [fa.rep, fb.rep, fa.flip, fb.flip] : [fb.rep, fa.rep, fb.flip, fa.flip];
    parent.set(child, { to: root, flip: cf !== rf !== flip });
  };
  for (const q of inputQuads) {
    const p = q.predicate.value;
    if (q.subject.termType !== 'NamedNode' || q.object.termType !== 'NamedNode') continue;
    if (p === OWL_EQ) union(q.subject.value, q.object.value, false);
    else if (p === OWL_INV) union(q.subject.value, q.object.value, true);
  }
  return find;
}

/** Normalise a quad list to a Set of "s rep o" keys (orientation-flipped where the role is an inverse of its representative). */
export function normalisedRoleSet(quads, find) {
  const out = new Set();
  for (const q of quads) {
    const { rep, flip } = find(q.predicate.value);
    const [s, o] = flip ? [q.object, q.subject] : [q.subject, q.object];
    out.add(`${s.termType}:${s.value}\u0000${rep}\u0000${o.termType}:${o.value}`);
  }
  return out;
}

/** Compare two quad lists of role assertions. Returns raw and normalised difference counts. */
export function compareRoleAssertions(aQuads, bQuads, inputQuads) {
  const find = buildRoleClasses(inputQuads);
  const key = (q) => `${q.subject.value}\u0000${q.predicate.value}\u0000${q.object.value}`;
  const rawA = new Set(aQuads.map(key)), rawB = new Set(bQuads.map(key));
  const rawDiff = [...rawA].filter((k) => !rawB.has(k)).length + [...rawB].filter((k) => !rawA.has(k)).length;
  const nA = normalisedRoleSet(aQuads, find), nB = normalisedRoleSet(bQuads, find);
  const onlyA = [...nA].filter((k) => !nB.has(k)).length;
  const onlyB = [...nB].filter((k) => !nA.has(k)).length;
  return { rawDiff, normalisedDiff: onlyA + onlyB, onlyA, onlyB };
}
