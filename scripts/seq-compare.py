#!/usr/bin/env python3
"""Canonical equality of repeated steps of a konclude_repro --seq run.

usage: seq-compare.py "SEQ" OUTDIR     (OUTDIR holds seq<N>.nt written by the harness)
Raw outputs may differ only in the orientation of equivalent/inverse object properties
(representative choice depends on addresses); scripts/oracle/canon.py normalises that.
Exit 0: every repeated (op, spec) step has the same canonical fingerprint as its first occurrence.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "oracle"))
import canon  # noqa: E402


def main(argv):
    spec, outdir = argv[1], argv[2]
    first, bad = {}, 0
    cache = {}
    for n, step in enumerate(spec.split(","), 1):
        path = step[2:].split("~drop")[0]
        if path == "empty":
            continue
        if path not in cache:
            cache[path] = canon.load_axioms(path)
        props, eq, inv = cache[path]
        dump = os.path.join(outdir, f"seq{n}.nt")
        fp = canon.fingerprint(canon.bucket(canon.parse_nt(dump), props, eq, inv))
        key = {k: (v["count"], v["sha256"]) for k, v in fp.items()}
        if step not in first:
            first[step] = (n, key)
        elif first[step][1] != key:
            diff = [k.split("#")[-1] for k in set(key) | set(first[step][1]) if key.get(k) != first[step][1].get(k)]
            print(f"step {n} differs canonically from step {first[step][0]} ({step}): {sorted(diff)[:6]}")
            bad = 1
    print("canonical comparison:", "FAIL" if bad else "ok")
    return bad


if __name__ == "__main__":
    sys.exit(main(sys.argv))
