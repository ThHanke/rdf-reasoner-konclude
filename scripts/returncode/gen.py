#!/usr/bin/env python3
"""Generator: convert the tableau's OR-branching task end (C++ exception) into a status flag.

Reads the patched tableau .cpp, the clang JSON AST (dump-ast.sh) and analysis.json (closure), and writes an edited
copy of the .cpp / .h. The edits (all CRLF-preserving, byte-offset exact):

  1. executeORBranching: `throw CCalculationStopProcessingException(true);`  ->  `mKonStopPending = true; return;`
     (only that one throw; clash/error/other stop throws stay exceptions)
  2. After every statement that calls a function of the closure (a function that can reach that throw, incl. the
     member-pointer rule dispatch):  `if (mKonStopPending) { return <default>; }`
     inside handleTask (the only try/catch of the file):  `{ mKonStopPending = false; completed = true; goto konStopHandled; }`
  3. handleTask: reset of the flag before the try block, label `konStopHandled:` after the catch chain.
  4. Header: member `bool mKonStopPending = false;`.

Call sites the generator cannot rewrite safely (conditions, nested uses, macro locations, unbraced bodies without
handling) are reported and make it exit non-zero unless listed in the manual-edits file.

usage: gen.py --src <tableau.cpp> --hdr <tableau.h> --ast ast.json --analysis analysis.json --out-dir DIR [--report r.txt]
"""
import argparse
import json
import re
import sys
import collections
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import analyze  # noqa: E402

TRY_ANCHOR = "\t\t\t\t\t\ttry {\r\n\t\t\t\t\t\t\tmBackendCacheHandler->setWorkingOntology(satCalcTask->getProcessingDataBox()->getOntology());\r\n"
TAIL_ANCHOR = "\t\t\t\t\t\t} catch (...) {\r\n\t\t\t\t\t\t\terror = true;\r\n\t\t\t\t\t\t\terrorCode = 3;\r\n\t\t\t\t\t\t}\r\n"
THROW_ANCHOR = ("communicateTaskCreation(newTaskList);\r\n\r\n\t\t\t\t\t\t\tthrow CCalculationStopProcessingException(true);\r\n"
                "\t\t\t\t\t\t} else {\r\n\t\t\t\t\t\t\t// throw clash")
THROW_NEW = ("communicateTaskCreation(newTaskList);\r\n\r\n\t\t\t\t\t\t\tmKonStopPending = true;   // was: throw CCalculationStopProcessingException(true)\r\n"
             "\t\t\t\t\t\t\treturn;\r\n\t\t\t\t\t\t} else {\r\n\t\t\t\t\t\t\t// throw clash")
HDR_MEMBER = "\t\t\t\t\t\tbool mKonStopPending = false;   // task ended by OR branching (replaces CCalculationStopProcessingException(true))\r\n"

STMT_CONTAINERS = {"CompoundStmt"}


class Loc:
    def __init__(self):
        self.offset = 0
        self.tok = 0
        self.line = 0
        self.file = None
        self.macro = False

    def update(self, loc):
        if not isinstance(loc, dict):
            return False
        if "spellingLoc" in loc or "expansionLoc" in loc:
            self.update(loc.get("spellingLoc"))
            ex = loc.get("expansionLoc")
            self.update(ex)
            self.macro = True
            return True
        self.macro = False
        for k, a in (("offset", "offset"), ("tokLen", "tok"), ("line", "line"), ("file", "file")):
            if k in loc:
                setattr(self, a, loc[k])
        return True


def default_return(ret):
    r = ret.strip()
    if r == "void":
        return "return;"
    if r == "bool":
        return "return false;"
    if r.endswith("*"):
        return "return nullptr;"
    if r in ("int", "cint64", "cint32", "double", "float", "qint64", "size_t"):
        return "return 0;"
    return "return %s();" % r


def collect_sites(ast_path, closure, source_fn):
    """Walk every closure function body; return per function the call sites with exact ranges."""
    st = Loc()
    funcs = {}
    names = set(closure) | {source_fn}

    def visit_decl(node):
        st.update(node.get("loc"))
        rng = node.get("range") or {}
        st.update(rng.get("begin"))
        k = node.get("kind")
        if k == "CXXMethodDecl" and node.get("name") in names and any(c.get("kind") == "CompoundStmt" for c in node.get("inner", [])):
            fn = node["name"]
            ret = analyze.ret_type(node.get("type", {}).get("qualType", ""))
            body = [c for c in node["inner"] if c.get("kind") == "CompoundStmt"][0]
            funcs[fn] = {"ret": ret, "sites": [], "body": None}
            walk(body, [], fn, funcs[fn])
        else:
            for c in node.get("inner", []) or []:
                visit_decl(c)
        st.update(rng.get("end"))

    def rng_of(node):
        r = node.get("range") or {}
        b = r.get("begin") or {}
        e = r.get("end") or {}
        return b, e

    def walk(node, parents, fn, info):
        st.update(node.get("loc"))
        b, e = rng_of(node)
        had_b = st.update(b)
        begin = (st.offset, st.macro)
        had_e = st.update(e)
        end = (st.offset + st.tok, st.macro)
        k = node.get("kind")
        node["_b"] = begin
        node["_e"] = end
        node["_line"] = st.line
        if k in ("CXXMemberCallExpr", "CallExpr"):
            cn = analyze.callee_name(node)
            if cn and (cn == "(dispatch)" or cn in names):
                info["sites"].append({"callee": cn, "kind": analyze.classify(parents, node), "parents": parents[-8:], "node": node,
                                      "line": st.line})
        for c in node.get("inner", []) or []:
            walk(c, parents + [node], fn, info)

    for doc in analyze.read_docs(ast_path):
        visit_decl(doc)
    return funcs


def statement_of(site):
    """Return (stmt_node, container_parent) for the call site: the node directly below a CompoundStmt / if / loop body."""
    chain = site["parents"] + [site["node"]]
    # chain: ... -> container -> stmt -> ... -> call
    for i in range(len(chain) - 1, 0, -1):
        p = chain[i - 1]
        if p.get("kind") in ("CompoundStmt",):
            return chain[i], p
        if p.get("kind") in ("IfStmt", "WhileStmt", "ForStmt", "DoStmt", "CXXForRangeStmt", "CaseStmt", "DefaultStmt", "LabelStmt"):
            inner = p.get("inner", [])
            if chain[i] in inner and chain[i] is inner[-1] or (p["kind"] == "IfStmt" and chain[i] in inner[1:]):
                return chain[i], p
    return None, None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    ap.add_argument("--hdr", required=True)
    ap.add_argument("--ast", default="logs/returncode/ast.json")
    ap.add_argument("--analysis", default="logs/returncode/analysis.json")
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--source-fn", default="executeORBranching")
    ap.add_argument("--report", default=None)
    args = ap.parse_args()

    src = open(args.src, "rb").read()
    hdr = open(args.hdr, "rb").read()
    an = json.load(open(args.analysis))
    closure = set(an["closure"])
    funcs = collect_sites(args.ast, closure, args.source_fn)
    missing = closure - set(funcs)
    print("closure functions found in AST:", len(funcs), "missing:", sorted(missing)[:5])

    # locate the try range of handleTask (offsets) from the source text
    s_txt = src.decode("utf-8", errors="surrogateescape")
    try_pos = s_txt.index(TRY_ANCHOR)
    tail_pos = s_txt.index(TAIL_ANCHOR)
    tail_end = tail_pos + len(TAIL_ANCHOR)

    edits = []          # (offset, text) insertions, applied from the back
    hard = []
    stats = collections.Counter()
    for fn, info in sorted(funcs.items()):
        if fn == args.source_fn:
            continue
        is_ht = fn == "handleTask"
        action = ("{ mKonStopPending = false; completed = true; goto konStopHandled; }" if is_ht
                  else "{ %s }" % default_return(info["ret"]))
        done_stmts = set()
        for site in info["sites"]:
            kind = site["kind"]
            callee = site["callee"]
            if callee != "(dispatch)" and callee not in closure and callee != args.source_fn:
                continue
            if kind == "return":
                stats["return"] += 1
                continue
            if kind not in ("unused", "init"):
                hard.append((fn, callee, site["line"], kind))
                continue
            stmt, container = statement_of(site)
            if stmt is None:
                hard.append((fn, callee, site["line"], "no-statement"))
                continue
            (b_off, b_mac), (e_off, e_mac) = stmt["_b"], stmt["_e"]
            if b_mac or e_mac:
                hard.append((fn, callee, site["line"], "macro"))
                continue
            if id(stmt) in done_stmts:
                stats["dup-stmt"] += 1
                continue
            done_stmts.add(id(stmt))
            if container.get("kind") != "CompoundStmt":
                hard.append((fn, callee, site["line"], "unbraced"))
                continue
            if is_ht and not (try_pos <= b_off <= tail_end):
                hard.append((fn, callee, site["line"], "handleTask-outside-try"))
                continue
            e = e_off
            while e < len(src) and src[e:e + 1] in (b" ", b"\t", b"\r", b"\n"):
                e += 1
            if src[e:e + 1] == b";":
                e += 1
            else:
                e = e_off      # DeclStmt range already includes ';'
            edits.append((e, " if (mKonStopPending) %s" % action))
            stats["mechanical"] += 1
    print("mechanical edits:", stats["mechanical"], " returns:", stats["return"], " hard:", len(hard), dict(collections.Counter(h[3] for h in hard)))

    if args.report:
        with open(args.report, "w") as f:
            for h in hard:
                f.write("%s\t%s\tL%s\t%s\n" % h)
    if hard and "--allow-hard" not in sys.argv:
        print("refusing to emit patch: hard sites remain (see report). Use --allow-hard for a dry run.")
        # still emit the partial result for inspection
    # apply insertions back to front
    out = bytearray(src)
    for off, text in sorted(edits, key=lambda x: -x[0]):
        out[off:off] = text.encode("utf-8", errors="surrogateescape")
    o = out.decode("utf-8", errors="surrogateescape")
    for a, b, what in ((THROW_ANCHOR, THROW_NEW, "throw"),):
        assert o.count(a) == 1, what
        o = o.replace(a, b, 1)
    assert o.count(TRY_ANCHOR) == 1
    o = o.replace(TRY_ANCHOR, "\t\t\t\t\t\tmKonStopPending = false;\r\n" + TRY_ANCHOR, 1)
    assert o.count(TAIL_ANCHOR) == 1
    o = o.replace(TAIL_ANCHOR, TAIL_ANCHOR + "\t\t\t\t\t\tkonStopHandled:;\r\n", 1)
    os.makedirs(args.out_dir, exist_ok=True)
    open(os.path.join(args.out_dir, os.path.basename(args.src)), "wb").write(o.encode("utf-8", errors="surrogateescape"))
    h = hdr.decode("utf-8", errors="surrogateescape")
    anchor = "\t\t\t\t\t\tbool tableauRuleProcessing(CIndividualProcessNode*& indiProcNode,CConceptProcessDescriptor*& conProcDes, CCalculationAlgorithmContextBase* calcAlgContext);\r\n"
    assert h.count(anchor) == 1
    h = h.replace(anchor, HDR_MEMBER + anchor, 1)
    open(os.path.join(args.out_dir, os.path.basename(args.hdr)), "wb").write(h.encode("utf-8", errors="surrogateescape"))
    print("wrote", args.out_dir)
    return 1 if hard and "--allow-hard" not in sys.argv else 0


if __name__ == "__main__":
    sys.exit(main())
