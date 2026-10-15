#!/usr/bin/env python3
"""Diff two jemalloc heap profiles (REPRO_PROF dumps) by allocation stack and symbolize the growth.

usage: heap-diff.py OLD.prof NEW.prof BINARY [TOP=20] [FRAMES=7]
Profiles must come from the same binary with ASLR off (setarch -R) so addresses are comparable.
Run: REPRO_MEM=1 REPRO_FLUSH=1 REPRO_PROF=DIR LD_PRELOAD=libjemalloc.so.2 MALLOC_CONF=prof:true,lg_prof_sample:17 \
     setarch -R build-native/konclude_repro --seq "m:F,m:F,..."
Reports in-use bytes per stack in NEW minus OLD (sampled estimate), grouped by the first N non-allocator frames.
"""
import collections, math, os, re, subprocess, sys


def parse(path):
    stacks, maps = {}, []
    cur, rate = None, 131072.0
    for line in open(path, errors="replace"):
        if line.startswith("heap_v2/"):
            rate = float(line.strip().split("/")[1])
        elif line.startswith("@"):
            cur = tuple(int(x, 16) for x in line.split()[1:])
        elif cur is not None and line.lstrip().startswith("t*:"):
            m = re.match(r"\s*t\*:\s*(\d+):\s*(\d+)", line)
            n, b = int(m.group(1)), int(m.group(2))
            # jeprof scaling: a sample of size s was taken with probability 1 - exp(-s/rate)
            scale = 1.0 / (1.0 - math.exp(-(b / n) / rate)) if n else 0.0
            stacks[cur] = stacks.get(cur, 0) + b * scale
            cur = None
        else:
            m = re.match(r"([0-9a-f]+)-([0-9a-f]+)\s+(\S+)\s+([0-9a-f]+)\s+\S+\s+\d+\s+(\S+)", line)
            if m:
                maps.append((int(m.group(1), 16), int(m.group(2), 16), m.group(3), int(m.group(4), 16), m.group(5)))
    return stacks, maps


def main():
    old, new, binary = sys.argv[1], sys.argv[2], sys.argv[3]
    top = int(sys.argv[4]) if len(sys.argv) > 4 else 20
    nfr = int(sys.argv[5]) if len(sys.argv) > 5 else 7
    so, _ = parse(old)
    sn, maps = parse(new)
    grow = {k: v - so.get(k, 0) for k, v in sn.items()}
    total = sum(grow.values())
    print(f"in-use now {sum(sn.values())/1e6:.0f} MB, before {sum(so.values())/1e6:.0f} MB, growth {total/1e6:.0f} MB")
    addrs = sorted({a for k, v in grow.items() if v > 0 for a in k})
    exe = [m for m in maps if m[4].endswith(binary.split("/")[-1]) and "x" in m[2]]
    cache, todo = {}, []
    for a in addrs:
        for s_, e, _, off, path in exe:
            if s_ <= a < e:
                todo.append((a, a - s_ + off - 1))
                break
        else:
            cache[a] = f"[lib {hex(a)}]"
    if todo:   # one addr2line call for all addresses (function + file:line per address)
        out = subprocess.run(["addr2line", "-C", "-f", "-e", binary] + [hex(o) for _, o in todo], capture_output=True, text=True).stdout.split("\n")
        for i, (a, _) in enumerate(todo):
            cache[a] = re.sub(r"\(.*", "", out[2 * i])[:90] + " " + out[2 * i + 1].split("/")[-1][:40]

    def sym(a):
        return cache[a]

    # HEAPDIFF_RAW=1: keep every frame (allocation sites inside containers/allocators included)
    skip = re.compile(r"(?!)" if os.environ.get("HEAPDIFF_RAW") else r"operator new|malloc|CMemoryPool|allocat|std::|\[lib|QtCompat|emplace|_M_|robin_hood", re.I)
    groups = collections.Counter()
    for k, v in grow.items():
        if v <= 0:
            continue
        frames = [sym(a) for a in k]
        keep = [f for f in frames if not skip.search(f.split(" ")[0])][:nfr]
        groups[" <- ".join(f.split(" ")[0] for f in keep[:nfr])] += v
    for s, v in groups.most_common(top):
        print(f"{v/1e6:8.1f} MB  {s}")


main()
