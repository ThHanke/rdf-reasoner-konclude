#!/usr/bin/env python3
"""Reduce roberts-family.nt to ~N connected individuals (full TBox kept).
usage: reduce-roberts.py IN.nt OUT.nt N [SEED_INDEX=0]
Individuals = IRIs typed owl:NamedIndividual. Edges = non-rdf:first triples between two individuals.
BFS from the SEED_INDEX-th individual (sorted); triples mentioning an excluded individual are dropped
(except rdf:first list cells of the TBox, which are kept)."""
import re, sys, collections
src, dst, n = sys.argv[1], sys.argv[2], int(sys.argv[3])
seed = int(sys.argv[4]) if len(sys.argv) > 4 else 0
T = re.compile(r'^(\S+) (\S+) (.*) \.$')
lines = [l.rstrip("\n") for l in open(src) if l.strip()]
tr = [T.match(l).groups() for l in lines]
NI = "<http://www.w3.org/2002/07/owl#NamedIndividual>"
TY = "<http://www.w3.org/1999/02/22-rdf-syntax-ns#type>"
FIRST = "<http://www.w3.org/1999/02/22-rdf-syntax-ns#first>"
indi = sorted({s for s, p, o in tr if p == TY and o == NI})
iset = set(indi)
adj = collections.defaultdict(set)
for s, p, o in tr:
    if s in iset and o in iset and p != FIRST:
        adj[s].add(o); adj[o].add(s)
keep, queue = [], collections.deque([indi[seed]])
seen = {indi[seed]}
while queue and len(keep) < n:
    x = queue.popleft(); keep.append(x)
    for y in sorted(adj[x]):
        if y not in seen: seen.add(y); queue.append(y)
    if not queue:  # component exhausted: continue with next unseen individual
        for y in indi:
            if y not in seen: seen.add(y); queue.append(y); break
ks = set(keep)
out = []
for (s, p, o), l in zip(tr, lines):
    if s in iset and s not in ks: continue
    if o in iset and o not in ks and p != FIRST: continue
    out.append(l)
open(dst, "w").write("\n".join(out) + "\n")
print(f"{len(keep)} individuals, {len(out)} of {len(lines)} triples", file=sys.stderr)
