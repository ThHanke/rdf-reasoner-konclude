#!/usr/bin/env python3
"""Analyse the tableau class AST (clang -ast-dump=json, filtered) for exception -> status-flag conversion.

Reads logs/returncode/ast.json (a stream of JSON documents, one per matched declaration) and reports:
  * every member function with a body, its return type,
  * the call graph between member functions, including the member-function-pointer dispatch ((this->*func)(...)),
    which is wired to every function whose address is taken as `&Class::fn`,
  * the closure of functions that can reach the throw source (default: executeORBranching),
  * every call site inside the closure that targets a closure function (or the dispatch), with its syntactic context:
      stmt  - result unused, a plain statement                      (a status check can follow directly)
      expr  - result used inside an expression / condition / init    (needs a temporary or manual handling)

usage: analyze.py [ast.json] [--source executeORBranching] [--json out.json]
"""
import json
import re
import sys
import collections

CLASS = "CCalculationTableauCompletionTaskHandleAlgorithm"


def read_docs(path):
    dec = json.JSONDecoder()
    text = open(path, encoding="utf-8", errors="replace").read()
    pos, n = 0, len(text)
    while True:
        while pos < n and text[pos] in " \r\n\t":
            pos += 1
        if pos >= n:
            return
        obj, end = dec.raw_decode(text, pos)
        yield obj
        pos = end


class LocState:
    def __init__(self):
        self.file = None
        self.line = 0

    def update(self, loc):
        if not isinstance(loc, dict):
            return
        if "spellingLoc" in loc or "expansionLoc" in loc:
            self.update(loc.get("spellingLoc"))
            self.update(loc.get("expansionLoc"))
            return
        if "file" in loc:
            self.file = loc["file"]
        if "line" in loc:
            self.line = loc["line"]


STMT_PARENTS_BODY = {"CompoundStmt", "CaseStmt", "DefaultStmt", "LabelStmt", "SwitchStmt"}
TRANSPARENT = {"ImplicitCastExpr", "ExprWithCleanups", "ParenExpr", "CXXBindTemporaryExpr", "MaterializeTemporaryExpr",
               "CXXConstructExpr", "CStyleCastExpr", "CXXStaticCastExpr", "CXXFunctionalCastExpr", "CXXReinterpretCastExpr"}


def callee_name(call):
    """Member-function name of a call node, '(dispatch)' for ->* calls, else None."""
    k = call.get("kind")
    inner = call.get("inner") or []
    if k == "CXXMemberCallExpr" and inner:
        f = inner[0]
        while f.get("kind") in TRANSPARENT and f.get("inner"):
            f = f["inner"][0]
        if f.get("kind") == "MemberExpr":
            return f.get("name")
        if f.get("kind") == "BinaryOperator" and f.get("opcode") == "->*":
            return "(dispatch)"
        if f.get("kind") == "ParenExpr":
            return "(dispatch)"
    if k == "CallExpr" and inner:
        f = inner[0]
        while f.get("kind") in TRANSPARENT and f.get("inner"):
            f = f["inner"][0]
        if f.get("kind") == "DeclRefExpr":
            return (f.get("referencedDecl") or {}).get("name")
    return None


def classify(parent_chain, node):
    """Classify a call by how its (possibly default) result is used before the next statement.

    unused   - call is a whole statement                              -> check right after it
    init     - initializer of a declaration or RHS of '=' statement   -> check right after the statement
    return   - (part of) a return statement                           -> caller checks the flag
    nested   - result used inside a larger expression (argument, receiver, operand, member access)
                                                                       -> default value would be consumed: needs temporary
    cond     - inside an if/while/for/switch/do condition              -> needs rewrite
    short    - right operand of &&, ||, ?:                             -> needs rewrite
    other    - anything else
    """
    child = node
    short = False
    direct = True       # call result flows directly to the statement/initializer/assignment/return
    last_kind = None
    for depth in range(len(parent_chain) - 1, -1, -1):
        p = parent_chain[depth]
        k = p.get("kind")
        if k in TRANSPARENT:
            child = p
            continue
        if k == "BinaryOperator" and p.get("opcode") in ("&&", "||"):
            inner = p.get("inner", [])
            if inner and child is not inner[0]:
                short = True
            direct = False
            child = p
            continue
        if k == "ConditionalOperator":
            inner = p.get("inner", [])
            if inner and child is not inner[0]:
                short = True
            direct = False
            child = p
            continue
        if k == "BinaryOperator" and p.get("opcode") == "=":
            inner = p.get("inner", [])
            if not (len(inner) == 2 and child is inner[1]):
                direct = False
            child = p
            last_kind = "assign"
            continue
        if k == "VarDecl":
            child = p
            last_kind = "init"
            continue
        if k in STMT_PARENTS_BODY or k == "DeclStmt":
            if short:
                return "short"
            if not direct:
                return "nested"
            return "unused" if last_kind is None else "init"
        if k == "ReturnStmt":
            return "short" if short else ("return" if direct else "nested")
        if k == "IfStmt":
            inner = p.get("inner", [])
            idx = next((i for i, c in enumerate(inner) if c is child), -1)
            cond_idx = (1 if p.get("hasInit") else 0) + (1 if p.get("hasVar") else 0)
            if idx > cond_idx:
                if short:
                    return "short"
                if not direct:
                    return "nested"
                return "unused" if last_kind is None else "init"
            return "cond"
        if k in ("WhileStmt", "ForStmt", "DoStmt", "CXXForRangeStmt", "SwitchStmt"):
            inner = p.get("inner", [])
            idx = next((i for i, c in enumerate(inner) if c is child), -1)
            if inner and idx == len(inner) - 1 and k != "SwitchStmt":
                if short:
                    return "short"
                if not direct:
                    return "nested"
                return "unused" if last_kind is None else "init"
            return "cond"
        # any other parent: the call is an operand/argument/receiver of a larger expression
        direct = False
        child = p
    return "other"


def analyse(path, source):
    functions = {}      # name -> {'ret': str, 'line': int, 'calls': [(callee, line, ctx)]}
    taken = set()       # functions whose address is taken (jump tables)
    st = LocState()
    for doc in read_docs(path):
        walk_decl(doc, functions, taken, st)
    return functions, taken


def ret_type(qual):
    # "bool (CIndividualProcessNode *&, ...)" -> "bool"; "void (...) noexcept" -> "void"
    depth = 0
    for i, ch in enumerate(qual):
        if ch == "(" and depth == 0:
            return qual[:i].strip()
    return qual.strip()


def walk_decl(doc, functions, taken, st):
    stack = [(doc, [])]
    # depth-first in document order, keeping location state consistent with the JSON order
    def visit(node, parents):
        st.update(node.get("loc"))
        rng = node.get("range") or {}
        st.update(rng.get("begin"))
        k = node.get("kind")
        if k in ("CXXMethodDecl", "CXXConstructorDecl") and node.get("name") and any(
                c.get("kind") == "CompoundStmt" for c in node.get("inner", [])):
            name = node["name"]
            functions.setdefault(name, {"ret": ret_type(node.get("type", {}).get("qualType", "")),
                                        "line": st.line, "calls": [], "node": None})
            functions[name]["calls"] = []
            ctx_fn = name
            for c in node["inner"]:
                if c.get("kind") == "CompoundStmt":
                    walk_body(c, [node], ctx_fn, functions, taken, st)
        else:
            for c in node.get("inner", []) or []:
                visit(c, parents + [node])
        st.update(rng.get("end"))
    visit(doc, [])


def walk_body(node, parents, fn, functions, taken, st):
    st.update(node.get("loc"))
    rng = node.get("range") or {}
    st.update(rng.get("begin"))
    k = node.get("kind")
    if k in ("CXXMemberCallExpr", "CallExpr"):
        cn = callee_name(node)
        if cn:
            line = st.line
            functions[fn]["calls"].append((cn, line, classify(parents, node)))
    if k == "UnaryOperator" and node.get("opcode") == "&":
        for c in node.get("inner", []) or []:
            if c.get("kind") == "DeclRefExpr":
                d = c.get("referencedDecl") or {}
                if d.get("kind") == "CXXMethodDecl" or d.get("name"):
                    taken.add(d.get("name"))
    for c in node.get("inner", []) or []:
        walk_body(c, parents + [node], fn, functions, taken, st)
    st.update(rng.get("end"))


def main():
    args = sys.argv[1:]
    path = "logs/returncode/ast.json"
    source = "executeORBranching"
    out = None
    i = 0
    while i < len(args):
        if args[i] == "--source":
            source = args[i + 1]; i += 2
        elif args[i] == "--json":
            out = args[i + 1]; i += 2
        else:
            path = args[i]; i += 1
    functions, taken = analyse(path, source)
    names = set(functions)
    print("member functions with body:", len(names), " address-taken:", len(taken))
    edges = collections.defaultdict(set)
    for f, info in functions.items():
        for cn, line, ctx in info["calls"]:
            if cn == "(dispatch)":
                for t in taken:
                    if t in names:
                        edges[f].add(t)
            elif cn in names and cn != f:
                edges[f].add(cn)
    rev = collections.defaultdict(set)
    for a, bs in edges.items():
        for b in bs:
            rev[b].add(a)
    lvl = {source: 0}
    q = [source]
    while q:
        x = q.pop(0)
        for y in rev.get(x, ()):
            if y not in lvl:
                lvl[y] = lvl[x] + 1
                q.append(y)
    closure = set(lvl) - {source}
    print("closure from", source, ":", len(closure), "functions")
    by = collections.Counter()
    sites = []
    for f in sorted(closure):
        for cn, line, ctx in functions[f]["calls"]:
            if cn == "(dispatch)" or cn in lvl:
                by[ctx] += 1
                sites.append((f, cn, line, ctx))
    print("call sites into the closure:", len(sites), dict(by))
    rets = collections.Counter(functions[f]["ret"] for f in closure)
    print("return types of closure functions:", dict(rets.most_common(12)))
    exprs = [s for s in sites if s[3] in ("cond", "short", "other", "nested")]
    print("hard call sites (cond / short-circuit / nested / other):", len(exprs))
    for s in exprs[:25]:
        print("   ", s)
    if out:
        json.dump({"closure": sorted(closure), "sites": sites, "returns": {f: functions[f]["ret"] for f in closure}},
                  open(out, "w"), indent=1)


if __name__ == "__main__":
    main()
