#!/usr/bin/env python3
"""Compare a port dump (sorted NTriples) against an oracle fingerprint JSON.

usage: compare-fingerprint.py FIXTURE.nt DUMP.nt ORACLE.json [--json]
Gates object-property buckets and '__types__' (when the oracle has it);
'__other__' (subPropertyOf, sameAs, ...) is informational only.
Exit 0 equal, 1 mismatch.
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "oracle"))
import canon  # noqa: E402


def main(argv):
    if len(argv) < 4:
        print(__doc__)
        return 64
    fixture, dump, oracle_path = argv[1:4]
    props, eq_rep, inv = canon.load_axioms(fixture)
    ours = canon.fingerprint(canon.bucket(canon.parse_nt(dump), props, eq_rep, inv))
    oracle = json.load(open(oracle_path))["buckets"]
    orc = json.load(open(oracle_path))
    known = orc.get("known_deltas", {}).get("counts", {})
    bad, total_missing = [], 0
    for k, o in oracle.items():
        if k in known and ours.get(k, {"count": 0})["count"] == o["count"] + known[k]:
            continue  # documented deterministic delta (count-only check)
        c = ours.get(k, {"count": 0, "sha256": ""})
        if not (c["count"] == 0 and o["count"] == 0) and c["sha256"] != o["sha256"]:
            bad.append((k, o["count"], c["count"]))
            total_missing += o["count"] - c["count"]
    extra = [k for k in ours if k not in oracle and not k.startswith("__")]
    res = {"equal": not bad, "mismatched_buckets": len(bad), "net_missing": total_missing,
           "details": [{"bucket": k, "oracle": a, "ours": b} for k, a, b in bad[:20]],
           "extra_buckets": extra[:10]}
    if "--json" in argv:
        print(json.dumps(res))
    else:
        print("EQUAL" if res["equal"] else f"MISMATCH: {len(bad)} buckets, net missing {total_missing}")
        for k, a, b in bad[:20]:
            print(f"  {k.split('#')[-1]}: oracle={a} ours={b} (delta {b - a:+d})")
    return 0 if res["equal"] else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
