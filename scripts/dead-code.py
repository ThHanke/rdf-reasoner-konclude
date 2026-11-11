#!/usr/bin/env python3
"""Dead-code suspect report for this repo (TypeScript layer, our C++ glue, vendored Konclude sources).

Static only: reference counting, #include scan and an identifier index. It reports SUSPECTS; a suspect can be
live through a dynamic path (reflection, event dispatch, bindings by string name), so read before deleting.
Code that no test executes needs a coverage run and is not covered here.

usage: scripts/dead-code.py [--out FILE] [--json] [--check [--check-vendor]] [--graph GRAPH.json] [--lib LIB.a]
  --out FILE    write the markdown report to FILE (default: stdout)
  --json        machine-readable output instead of markdown
  --check       exit 1 when a finding is not in scripts/dead-code-allowlist.txt (CI gate), also lists stale
                allowlist entries. Vendor sections (V1, V2) are upstream code we must not edit, so they are
                informational unless --check-vendor is given
  --graph PATH  graphify graph.json of Source/Reasoner (default vendor/konclude/Source/Reasoner/graphify-out/graph.json
                when present): marks vendor classes the graph also sees as having no inbound call/reference/inherit
  --lib PATH    static library whose object list says which vendor .cpp files are compiled
                (default build-native/libkonclude_kernel_native.a when present)

Sections
  TS1  declared in ts/, not public API, referenced nowhere else (own file, other ts, tests, scripts)
  TS2  class methods (underscore API included) never referenced outside their own definition
  TS3  ts/ modules imported by nothing (entry points from package.json bin/exports/worker are exempt)
  CPP1 src/ (our glue) functions and classes named in no other file
  V1   vendor headers under Source/Reasoner that no other file #includes
  V2   vendor classes/structs whose name appears in no other file (vendor, src, patches)

Allowlist: scripts/dead-code-allowlist.txt, one `SECTION name  # reason` per line (name as printed).
"""
import argparse, collections, glob, json, os, re, subprocess, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
TOKEN = re.compile(r"[A-Za-z_$][A-Za-z0-9_$]*")


def read(path):
    with open(path, encoding="utf8", errors="ignore") as f:
        return f.read()


def rel(path):
    return os.path.relpath(path, ROOT)


def files(patterns):
    out = []
    for p in patterns:
        out += glob.glob(os.path.join(ROOT, p), recursive=True)
    return sorted(set(out))


def word_count(name, text):
    return len(re.findall(r"(?<![A-Za-z0-9_$])" + re.escape(name) + r"(?![A-Za-z0-9_$])", text))


# --------------------------------------------------------------------------- TypeScript layer
def ts_findings():
    ts = files(["ts/*.ts"])
    others = files(["tests/**/*.ts", "tests/**/*.mjs", "scripts/**/*.mjs", "scripts/**/*.ts", "scripts/*.sh",
                    "vite.browser-test.config.ts", "package.json"])
    src = {f: read(f) for f in ts + others}
    count_in = lambda name, fs: sum(word_count(name, src[f]) for f in fs)

    public = set()
    entry = os.path.join(ROOT, "ts/index.ts")
    for m in re.finditer(r"export\s*(?:type\s*)?\{([^}]*)\}", src[entry]):
        for n in m.group(1).split(","):
            n = n.strip().split(" as ")[-1].strip()
            if n:
                public.add(n)

    decl = re.compile(r"^(?:export\s+)?(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|class|abstract class|enum)\s+"
                      r"([A-Za-z_$][\w$]*)", re.M)  # interfaces and type aliases are erased: not runtime code
    ts1 = []
    for f in ts:
        t = src[f]
        for m in decl.finditer(t):
            name = m.group(1)
            if name in public:
                continue
            own = count_in(name, [f]) - 1
            if own > 0:
                continue
            if count_in(name, [g for g in ts if g != f]) or count_in(name, others):
                continue
            ts1.append((rel(f), name))

    ts2 = []
    for f in ts:
        t = src[f]
        for m in re.finditer(r"^\s{2}(?:(?:private|protected|public)\s+)?(?:(?:static|readonly|async|override)\s+)*"
                             r"([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\(", t, re.M):
            name = m.group(1)
            if name in ("constructor", "if", "for", "while", "switch", "return", "catch", "function"):
                continue
            if count_in(name, [f]) - 1 > 0:
                continue
            if count_in(name, [g for g in ts if g != f]) or count_in(name, others):
                continue
            ts2.append((rel(f), name))

    pkg = json.loads(src[os.path.join(ROOT, "package.json")])
    exempt = {"index", "cli", "worker", "inlineWorker"}  # bin / worker entry / loaded by URL
    for v in json.dumps(pkg.get("exports", {})).split('"'):
        b = os.path.basename(v).split(".")[0]
        if b:
            exempt.add(b)
    ts3 = []
    for f in ts:
        b = os.path.basename(f)[:-3]
        if b in exempt:
            continue
        spec = re.compile(r"""['"][^'"\n]*/%s(?:\.js|\.ts)?['"]""" % re.escape(b))
        if not any(spec.search(src[g]) for g in src if g != f):
            ts3.append((rel(f), b))
    return {"TS1": sorted(set(ts1)), "TS2": sorted(set(ts2)), "TS3": sorted(set(ts3))}


# --------------------------------------------------------------------------- our C++ glue (src/)
def cpp_findings():
    ours = files(["src/*.cpp", "src/*.h"])
    everything = ours + files(["vendor/konclude/Source/**/*.h", "vendor/konclude/Source/**/*.cpp", "patches/*.patch",
                               "ts/*.ts", "CMakeLists.txt", "src/CMakeLists.txt"])
    idx = collections.defaultdict(set)
    for f in everything:
        for w in set(TOKEN.findall(read(f))):
            idx[w].add(f)
    out = []
    pat = re.compile(r"^(?:[\w:<>,*&\s]+?)\b(\w+)\s*\([^;{}]*\)\s*(?:const\s*)?\{", re.M)
    for f in ours:
        if os.path.basename(f) in ("native_repro.cpp", "debug_harness.cpp"):
            continue  # separate executables
        for m in pat.finditer(read(f)):
            name = m.group(1)
            if name in ("if", "for", "while", "switch", "catch", "main", "operator") or name.startswith("~"):
                continue
            used = idx.get(name, set()) - {f}
            if not used and word_count(name, read(f)) <= 1:
                out.append((rel(f), name))
    return {"CPP1": sorted(set(out))}


# --------------------------------------------------------------------------- vendored Konclude
def vendor_findings(graph_path, lib_path):
    base = os.path.join(ROOT, "vendor/konclude/Source")
    reasoner = os.path.join(base, "Reasoner")
    if not os.path.isdir(reasoner):
        return {"V1": [], "V2": []}, {}
    vfiles = files(["vendor/konclude/Source/**/*.h", "vendor/konclude/Source/**/*.cpp"])
    ours = files(["src/*.cpp", "src/*.h", "patches/*.patch"])
    compiled = None
    if lib_path and os.path.exists(lib_path):
        names = subprocess.run(["ar", "t", lib_path], capture_output=True, text=True).stdout.split()
        compiled = {os.path.splitext(os.path.splitext(n)[0])[0] for n in names}

    include = re.compile(r'#\s*include\s*[<"]([^>"]+)[>"]')
    included = collections.defaultdict(set)
    idx = collections.defaultdict(set)
    for f in vfiles + ours:
        t = read(f)
        for m in include.finditer(t):
            included[os.path.basename(m.group(1))].add(f)
        for w in set(TOKEN.findall(t)):
            idx[w].add(f)

    stem = lambda p: os.path.splitext(os.path.basename(p))[0]
    v1 = []
    for f in vfiles:
        if not f.startswith(reasoner + os.sep) or not f.endswith(".h"):
            continue
        users = {u for u in included.get(os.path.basename(f), set()) if stem(u) != stem(f)}
        if not users:
            cpp = f[:-2] + ".cpp"
            tag = "header-only" if not os.path.exists(cpp) else ("cpp compiled" if compiled is None or stem(f) in compiled else "cpp not compiled")
            v1.append((os.path.relpath(f, reasoner), tag))

    graph_zero = None
    if graph_path and os.path.exists(graph_path):
        g = json.load(open(graph_path))
        nodes = {n["id"]: n for n in g["nodes"]}
        st = lambda n: os.path.splitext(n.get("source_file") or "")[0]
        inbound = collections.Counter()
        for l in g["links"]:
            if l["relation"] in ("contains", "defines"):
                continue
            s, t = nodes.get(l["source"]), nodes.get(l["target"])
            if s and t and st(s) != st(t):
                inbound[l["target"]] += 1
        graph_zero = {n["label"] for n in nodes.values() if n.get("_callable_class") and not inbound[n["id"]]}

    cls = re.compile(r"^\s*(?:class|struct)\s+(?:\w+\s+)?([A-Z]\w+)\s*(?::|\{|$)", re.M)
    v2 = []
    for f in vfiles:
        if not f.startswith(reasoner + os.sep) or not f.endswith(".h"):
            continue
        for m in cls.finditer(read(f)):
            name = m.group(1)
            if name in ("CCompilerMarker",):
                continue
            owners = {g for g in idx.get(name, set()) if stem(g) != stem(f)}
            if not owners:
                tag = "" if graph_zero is None else (" [graph agrees]" if name in graph_zero else " [graph sees a reference]")
                v2.append((os.path.relpath(f, reasoner), name + tag))
    return {"V1": sorted(v1), "V2": sorted(set(v2))}, {"graph": graph_zero is not None, "lib": compiled is not None}


# --------------------------------------------------------------------------- allowlist and output
def load_allowlist():
    path = os.path.join(ROOT, "scripts/dead-code-allowlist.txt")
    entries = set()
    if os.path.exists(path):
        for line in read(path).splitlines():
            line = line.split("#", 1)[0].strip()
            if line:
                sec, _, name = line.partition(" ")
                entries.add((sec, name.strip()))
    return entries


def key(sec, row):
    return (sec, row[1].split(" [")[0] if sec == "V2" else row[1] if sec != "V1" else row[0])


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--check-vendor", action="store_true")
    ap.add_argument("--graph", default=os.path.join(ROOT, "vendor/konclude/Source/Reasoner/graphify-out/graph.json"))
    ap.add_argument("--lib", default=os.path.join(ROOT, "build-native/libkonclude_kernel_native.a"))
    a = ap.parse_args()

    res = {}
    res.update(ts_findings())
    res.update(cpp_findings())
    vres, meta = vendor_findings(a.graph, a.lib)
    res.update(vres)

    allow = load_allowlist()
    seen = set()
    new = {}
    for sec, rows in res.items():
        for row in rows:
            k = key(sec, row)
            seen.add(k)
            if k not in allow:
                new.setdefault(sec, []).append(row)
    stale = sorted(allow - seen)

    if a.json:
        text = json.dumps({"findings": res, "new": new, "stale_allowlist": stale, "meta": meta}, indent=1)
    else:
        titles = {
            "TS1": "TS1 declared in ts/, referenced nowhere else (not public API)",
            "TS2": "TS2 class methods never referenced outside their definition",
            "TS3": "TS3 ts/ modules imported by nothing",
            "CPP1": "CPP1 src/ functions named in no other file",
            "V1": "V1 vendor headers included by no other file",
            "V2": "V2 vendor classes named in no other file",
        }
        lines = ["# Dead-code suspects", "",
                 "Static suspects only (see scripts/dead-code.py). `*` marks findings not in the allowlist.", ""]
        if meta:
            lines += ["Inputs: graphify graph %s, compiled-object list %s." % ("used" if meta["graph"] else "absent", "used" if meta["lib"] else "absent"), ""]
        for sec in ("TS1", "TS2", "TS3", "CPP1", "V1", "V2"):
            rows = res.get(sec, [])
            lines.append("## %s (%d)" % (titles[sec], len(rows)))
            lines.append("")
            for row in rows:
                star = "*" if key(sec, row) not in allow else " "
                lines.append("- %s %s :: %s" % (star, row[0], row[1]))
            lines.append("")
        if stale:
            lines += ["## Stale allowlist entries (no longer a finding)", ""] + ["- %s %s" % s for s in stale] + [""]
        text = "\n".join(lines)
    if a.out:
        open(a.out, "w").write(text + "\n")
    else:
        print(text)
    if a.check:
        gated = [k for k in new if a.check_vendor or not k.startswith("V")]
        n = sum(len(new[k]) for k in gated)
        stale = [s for s in stale if a.check_vendor or not s[0].startswith("V")]
        if n or stale:
            sys.stderr.write("dead-code: %d new finding(s), %d stale allowlist entr(ies)\n" % (n, len(stale)))
            sys.exit(1)


if __name__ == "__main__":
    main()
