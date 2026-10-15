#!/usr/bin/env python3
"""Generate an oracle fingerprint from PRISTINE upstream Konclude.

usage: gen-oracle.py FIXTURE.nt OUT.json [--konclude PATH] [--repeats K] [--threads N]
Per canonical object property: SPARQL `SELECT ?s ?o WHERE {?s <p> ?o}` via
`Konclude sparqlfile`; types via `Konclude realization` (ClassAssertions).
Repeats K times; buckets that disagree across repeats are recorded under
'unstable' (the known upstream flake set) and excluded from gating.
Full dumps stay in a temp dir (deleted); only fingerprints are written.
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(__file__))
import canon  # noqa: E402

RESULT = re.compile(r"<result>(.*?)</result>", re.S)
URI = re.compile(r'<binding name="(\w+)"><uri>([^<]+)</uri>')
CA = re.compile(r'<ClassAssertion>\s*<Class IRI="([^"]+)"\s*/>\s*<NamedIndividual IRI="([^"]+)"\s*/>')


def free_gb(path):
    st = os.statvfs(path)
    return st.f_bavail * st.f_frsize / 2**30


def run_sparql(konclude, fixture, prop, threads, tmp):
    q, out = os.path.join(tmp, "q.sparql"), os.path.join(tmp, "out.xml")
    open(q, "w").write(f"SELECT ?s ?o WHERE {{ ?s <{prop}> ?o }}\n")
    subprocess.run([konclude, "sparqlfile", "-w", str(threads), "-i", fixture, "-s", q, "-o", out],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=1800)
    pairs = set()
    for block in RESULT.findall(open(out, encoding="utf-8").read()):
        b = dict(URI.findall(block))
        if "s" in b and "o" in b:
            pairs.add((b["s"], b["o"]))
    os.remove(out)
    return pairs


def run_types(konclude, fixture, threads, tmp):
    out = os.path.join(tmp, "types.xml")
    subprocess.run([konclude, "realization", "-w", str(threads), "-i", fixture, "-o", out],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=1800)
    pairs = {(i, c) for c, i in CA.findall(open(out, encoding="utf-8").read())}
    os.remove(out)
    return pairs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("fixture")
    ap.add_argument("out")
    ap.add_argument("--konclude", default=os.path.expanduser("~/konclude-orig/b/Debug/Konclude"))
    ap.add_argument("--repeats", type=int, default=3)
    ap.add_argument("--threads", type=int, default=8)
    a = ap.parse_args()
    if not os.access(a.konclude, os.X_OK):
        sys.exit(f"upstream binary missing: {a.konclude} (build it: scripts/oracle/build-upstream.sh)")
    tmp = tempfile.mkdtemp(prefix="oracle-")
    if free_gb(tmp) < 1.0:
        sys.exit(f"refusing: only {free_gb(tmp):.1f} GB free in {tmp}")
    props, eq_rep, inv = canon.load_axioms(a.fixture)
    keys = sorted({canon.canon_triple("s", p, "o", eq_rep, inv)[0] for p in props})
    runs = []
    try:
        for r in range(a.repeats):
            t0, fps = time.time(), {}
            for k in keys:
                pairs = run_sparql(a.konclude, a.fixture, k, a.threads, tmp)
                fps[k] = canon.fingerprint({k: pairs})[k]  # empty set -> count 0, sha of ""
                print(f"[{r + 1}/{a.repeats}] {k.split('#')[-1]}: {fps[k]['count']}", file=sys.stderr, flush=True)
            types = run_types(a.konclude, a.fixture, a.threads, tmp)
            fps["__types__"] = canon.fingerprint({"__types__": types})["__types__"]
            runs.append(fps)
            print(f"run {r + 1} done in {time.time() - t0:.0f}s", file=sys.stderr, flush=True)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    buckets, unstable = {}, {}
    for k in runs[0]:
        shas = {run[k]["sha256"] for run in runs}
        if len(shas) == 1:
            buckets[k] = runs[0][k]
        else:
            unstable[k] = [run[k]["count"] for run in runs]
    json.dump({"fixture": os.path.basename(a.fixture), "repeats": a.repeats,
               "upstream": a.konclude, "buckets": buckets, "unstable": unstable},
              open(a.out, "w"), indent=1, sort_keys=True)
    print(f"wrote {a.out}: {len(buckets)} stable buckets, {len(unstable)} unstable", file=sys.stderr)


if __name__ == "__main__":
    main()
