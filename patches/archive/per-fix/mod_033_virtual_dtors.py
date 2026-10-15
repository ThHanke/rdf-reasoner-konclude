import re
import sys

# (file, class): bases that are deleted through a base pointer but lack a virtual destructor. Found with an ASan run
# (new-delete-type-mismatch): the derived part is skipped (leaks, e.g. the 1432-byte CTotallyOntologyPrecomputationItem
# was freed as its 192-byte base) and the wrong size reaches sized operator delete (corrupts jemalloc bins).
TARGETS = [
    ("Source/Reasoner/Ontology/COntologyProcessingRequirement.h", "COntologyProcessingRequirement"),
    ("Source/Reasoner/Consistiser/COntologyPrecomputationItem.h", "COntologyPrecomputationItem"),
    ("Source/Reasoner/Consistiser/CPrecomputationTestingItem.h", "CPrecomputationTestingItem"),
    ("Source/Reasoner/Preprocess/COntologyPreprocessingItem.h", "COntologyPreprocessingItem"),
    ("Source/Reasoner/Ontology/CIndividualNameResolver.h", "CIndividualNameResolver"),
]
FILES = [f for f, _ in TARGETS]

if "--list-files" in sys.argv:
    for f in FILES:
        print(f)
    sys.exit(0)


def modify(path, content):
    cls = next(c for f, c in TARGETS if path.endswith(f.split("Source/Reasoner/")[1]))
    if f"virtual ~{cls}" in content:
        raise ValueError(f"{path}: already has a virtual destructor")
    pat = re.compile(r"^([ \t]+)" + cls + r"\([^;{}]*\);[ \t]*\n", re.M)
    ms = list(pat.finditer(content))
    if len(ms) != 1:
        raise ValueError(f"{path}: expected 1 constructor declaration, found {len(ms)}")
    m = ms[0]
    ins = f"\n{m.group(1)}//! Virtual: deleted through this base class\n{m.group(1)}virtual ~{cls}() {{}}\n"
    return content[:m.end()] + ins + content[m.end():]


if __name__ == "__main__":
    vendor = sys.argv[1]
    for f in FILES:
        p = f"{vendor}/{f}"
        s = open(p).read()
        out = modify(p, s)   # compute first: a failing modify() must not truncate the file
        open(p, "w").write(out)
