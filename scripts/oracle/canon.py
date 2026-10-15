"""Shared canonicalization for realization comparison (oracle vs. port).

Collapses equivalent / inverse object-property representatives so only real
inference differences remain. Pure functions; no I/O except load_axioms().
"""
import hashlib
import re

OWL = "http://www.w3.org/2002/07/owl#"
RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type"
NT_LINE = re.compile(r'^<([^>]+)>\s+<([^>]+)>\s+(<([^>]+)>|_:\S+|".*")\s*\.\s*$')


def parse_nt(path):
    """Yield (s, p, o_iri_or_None) for IRI-object triples; skips literals/bnodes."""
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            m = NT_LINE.match(line)
            if m and m.group(4) is not None:
                yield m.group(1), m.group(2), m.group(4)


def load_axioms(tbox_nt):
    """Return (object_properties, eq_rep, inv) from an NTriples ontology file."""
    props, eq_pairs, inv_pairs = set(), [], []
    for s, p, o in parse_nt(tbox_nt):
        if p == RDF_TYPE and o == OWL + "ObjectProperty":
            props.add(s)
        elif p == OWL + "equivalentProperty":
            eq_pairs.append((s, o))
        elif p == OWL + "inverseOf":
            inv_pairs.append((s, o))
    parent = {}

    def find(x):
        parent.setdefault(x, x)
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for a, b in eq_pairs:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[max(ra, rb)] = min(ra, rb)  # smallest IRI is the representative
    eq_rep = {p: find(p) for p in list(parent)}
    inv = {}
    for a, b in inv_pairs:
        a, b = eq_rep.get(a, a), eq_rep.get(b, b)
        inv[a] = b
        inv[b] = a
    return props, eq_rep, inv


def canon_triple(s, p, o, eq_rep, inv):
    p = eq_rep.get(p, p)
    q = inv.get(p)
    if q is not None and q < p:
        return q, o, s
    return p, s, o


def bucket(triples, props, eq_rep, inv):
    """Group canonical triples. Returns {bucket: set((s,o))}; buckets are canonical
    object-property IRIs, '__types__' for rdf:type, '__other__' for the rest."""
    out = {}
    for s, p, o in triples:
        if p == RDF_TYPE:
            key, pair = "__types__", (s, o)
        elif p in props or eq_rep.get(p, p) in props:
            cp, cs, co = canon_triple(s, p, o, eq_rep, inv)
            key, pair = cp, (cs, co)
        else:
            key, pair = "__other__", (s, p + " " + o)
        out.setdefault(key, set()).add(pair)
    return out


def fingerprint(buckets):
    fp = {}
    for k, pairs in buckets.items():
        h = hashlib.sha256("\n".join(sorted("\t".join(x) for x in pairs)).encode()).hexdigest()
        fp[k] = {"count": len(pairs), "sha256": h}
    return fp
