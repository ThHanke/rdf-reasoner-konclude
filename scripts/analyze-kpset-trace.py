#!/usr/bin/env python3
"""
Analyze KPSet trace output from multiple PMDco runs to identify where
nondeterminism enters the classification process.

Usage:
  Run the hierarchy-determinism test 3x with stderr captured:
    KPSET_TRACE=ON npx vitest run tests/integration/hierarchy-determinism.test.ts \
      2>/tmp/kpset-trace-run1.log
  (repeat for run2, run3)

  Then analyze:
    python3 scripts/analyze-kpset-trace.py /tmp/kpset-trace-run1.log /tmp/kpset-trace-run2.log /tmp/kpset-trace-run3.log

The {kpset} trace lines in stderr come from patch-025-kpset-trace-logging.patch:
  {kpset} item=<tag> cnt=<N> subsumers=<t1,t2,...>   -- finishOntologyClassification state dump
  {kpset} confirm subsumed=<t> subsumer=<t> cnt=<N>   -- interpreteSubsumptionResult
  {kpset} told subsumed=<t> subsumer=<t> cnt=<N>       -- processToldClassificationMessage
  {kpset} cb t=<ok|null> gen=<match|drop>              -- doCallback generation guard
"""

import sys
import re
from collections import defaultdict


def parse_run(filepath):
    """Parse one trace log, return list of classification runs within it."""
    # A single vitest run contains N materialize() calls.
    # Each materialize produces one finishOntologyClassification dump.
    # We detect run boundaries by the 'item=' lines being emitted in one burst.

    items_dumps = []   # list of dicts: {tag: sorted_subsumer_set}
    confirms = []      # list of (subsumed, subsumer) tuples in order
    tolds = []         # list of (subsumed, subsumer) tuples in order
    cb_match = 0
    cb_drop = 0
    current_dump = {}

    in_dump = False

    with open(filepath, 'r', errors='replace') as f:
        lines = f.readlines()

    i = 0
    # We collect sequential item= lines as one "dump block"
    dump_blocks = []
    current_block = {}

    for line in lines:
        if '{kpset}' not in line:
            continue
        m = re.search(r'\{kpset\} (.+)', line)
        if not m:
            continue
        payload = m.group(1).strip()

        if payload.startswith('item='):
            # item=<tag> cnt=<N> subsumers=<...>
            parts = {}
            for kv in payload.split(' '):
                if '=' in kv:
                    k, v = kv.split('=', 1)
                    parts[k] = v
            tag = int(parts['item'])
            cnt = int(parts['cnt'])
            subs_str = parts.get('subsumers', '')
            subsumers = set(int(x) for x in subs_str.split(',') if x) if subs_str else set()
            current_block[tag] = (cnt, subsumers)

        elif payload.startswith('confirm '):
            # Flush current item block if we switch to confirms
            if current_block:
                dump_blocks.append(dict(current_block))
                current_block = {}
            parts = {}
            for kv in payload.split(' ')[1:]:
                if '=' in kv:
                    k, v = kv.split('=', 1)
                    parts[k] = v
            confirms.append((int(parts['subsumed']), int(parts['subsumer'])))

        elif payload.startswith('told '):
            if current_block:
                dump_blocks.append(dict(current_block))
                current_block = {}
            parts = {}
            for kv in payload.split(' ')[1:]:
                if '=' in kv:
                    k, v = kv.split('=', 1)
                    parts[k] = v
            tolds.append((int(parts['subsumed']), int(parts['subsumer'])))

        elif payload.startswith('cb '):
            parts = {}
            for kv in payload.split(' ')[1:]:
                if '=' in kv:
                    k, v = kv.split('=', 1)
                    parts[k] = v
            if parts.get('gen') == 'match':
                cb_match += 1
            else:
                cb_drop += 1

    if current_block:
        dump_blocks.append(dict(current_block))

    return {
        'dump_blocks': dump_blocks,
        'confirms': confirms,
        'tolds': tolds,
        'cb_match': cb_match,
        'cb_drop': cb_drop,
    }


def compare_dumps(runs):
    """Compare item state dumps across runs."""
    print("\n" + "="*70)
    print("FINISHONTOLOGYCLASSIFICATION STATE DUMP COMPARISON")
    print("="*70)

    # Each run may have N dump blocks (N = number of materialize() calls)
    for run_idx, run in enumerate(runs):
        print(f"\nRun {run_idx+1}: {len(run['dump_blocks'])} classification dump(s), "
              f"cb match={run['cb_match']} drop={run['cb_drop']}")

    # Check if same number of dump blocks
    block_counts = [len(r['dump_blocks']) for r in runs]
    if len(set(block_counts)) > 1:
        print(f"\nWARNING: Different number of dump blocks across runs: {block_counts}")
        return

    n_blocks = block_counts[0]
    print(f"\nComparing {n_blocks} classification dump(s) across {len(runs)} runs:")

    for block_idx in range(n_blocks):
        print(f"\n  --- Classification call {block_idx + 1} ---")
        dumps = [r['dump_blocks'][block_idx] for r in runs]

        # Find all concept tags across all runs
        all_tags = set()
        for d in dumps:
            all_tags.update(d.keys())

        varying_items = []
        for tag in sorted(all_tags):
            entries = [d.get(tag) for d in dumps]
            # Check if all entries are the same
            counts = [e[0] if e else None for e in entries]
            subsumer_sets = [e[1] if e else None for e in entries]

            if len(set(counts)) > 1 or len(set(frozenset(s) if s else None for s in subsumer_sets)) > 1:
                varying_items.append(tag)
                print(f"    VARIES tag={tag}:")
                for run_idx, e in enumerate(entries):
                    if e:
                        print(f"      run{run_idx+1}: cnt={e[0]} subsumers={sorted(e[1])}")
                    else:
                        print(f"      run{run_idx+1}: MISSING")

        if not varying_items:
            print(f"    OK: All {len(all_tags)} items have identical subsumer sets across runs")
            print(f"    => Subsumer sets are STABLE. Bug is in Hasse reduction (sort order).")
        else:
            print(f"\n    RESULT: {len(varying_items)}/{len(all_tags)} items have varying subsumer sets!")
            print(f"    => Subsumer sets are UNSTABLE. Bug is in subsumer COLLECTION phase.")
            print(f"    => Initialization message ordering (COntologyTellClassificationMessageEvent)")
            print(f"       or test scheduling is nondeterministic.")


def compare_ordering(runs):
    """Compare confirm/told event sequences across runs."""
    print("\n" + "="*70)
    print("EVENT SEQUENCE COMPARISON (first 20 events)")
    print("="*70)

    for run_idx, run in enumerate(runs):
        print(f"\nRun {run_idx+1}: {len(run['confirms'])} confirms, {len(run['tolds'])} tolds")
        print(f"  First confirms: {run['confirms'][:5]}")
        print(f"  First tolds:    {run['tolds'][:5]}")

    # Check if confirm sequences differ
    confirm_seqs = [tuple(r['confirms']) for r in runs]
    if len(set(confirm_seqs)) == 1:
        print("\nConfirm sequences: IDENTICAL across all runs")
    else:
        print("\nConfirm sequences: DIFFER across runs")
        # Find first divergence
        min_len = min(len(r['confirms']) for r in runs)
        for i in range(min_len):
            vals = [r['confirms'][i] for r in runs]
            if len(set(vals)) > 1:
                print(f"  First divergence at confirm #{i}: {vals}")
                break

    told_seqs = [tuple(r['tolds']) for r in runs]
    if len(set(told_seqs)) == 1:
        print("Told sequences: IDENTICAL across all runs")
    else:
        print("Told sequences: DIFFER across runs")


def main():
    if len(sys.argv) < 3:
        print("Usage: analyze-kpset-trace.py <run1.log> <run2.log> [run3.log ...]")
        print("\nCapture trace from a single vitest run:")
        print("  npx vitest run tests/integration/hierarchy-determinism.test.ts 2>/tmp/trace1.log")
        sys.exit(1)

    log_files = sys.argv[1:]
    print(f"Analyzing {len(log_files)} trace files...")

    runs = []
    for f in log_files:
        print(f"  Parsing {f}...")
        run = parse_run(f)
        runs.append(run)
        print(f"    dumps={len(run['dump_blocks'])}, confirms={len(run['confirms'])}, "
              f"tolds={len(run['tolds'])}, cb_match={run['cb_match']}, cb_drop={run['cb_drop']}")

    compare_dumps(runs)
    compare_ordering(runs)

    print("\n" + "="*70)
    print("DIAGNOSIS SUMMARY")
    print("="*70)
    all_dumps_present = all(len(r['dump_blocks']) > 0 for r in runs)
    if not all_dumps_present:
        print("WARNING: No dump blocks found. Was KPSET_TRACE enabled in the build?")
        print("Check: grep '{kpset}' /tmp/your-trace.log | head -5")
    else:
        print("Trace data found. See above for analysis.")


if __name__ == '__main__':
    main()
