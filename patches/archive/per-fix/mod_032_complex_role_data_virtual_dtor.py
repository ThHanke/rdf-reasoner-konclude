import sys

FILES = ["Source/Reasoner/Realizer/COptimizedKPSetIndividualComplexRoleData.h"]

if "--list-files" in sys.argv:
    for f in FILES:
        print(f)
    sys.exit(0)

# COptimizedKPSetRoleInstancesItem::~COptimizedKPSetRoleInstancesItem deletes its per-individual values through
# COptimizedKPSetIndividualComplexRoleData*, but the real objects are
# COptimizedKPSetIndividualComplexRoleExplicitIndirectLinksData (which also derives from
# COptimizedKPSetRoleNeighbourInstancesHashData, holder of the big successor/predecessor hash tables).
# With a non-virtual base destructor the derived part was never destroyed: every neighbour hash of every
# individual/role leaked (~60 MB per Roberts call) and the wrong size reached sized operator delete
# (corrupts jemalloc bins, invisible under glibc).


def rep(content, old, new, path):
    if content.count(old) != 1:
        raise ValueError(f"{path}: expected 1 occurrence of {old!r}, found {content.count(old)}")
    return content.replace(old, new)


def modify(path, content):
    return rep(content,
        "					//! Constructor\n					COptimizedKPSetIndividualComplexRoleData();\n",
        "					//! Constructor\n					COptimizedKPSetIndividualComplexRoleData();\n\n					//! Virtual: values are deleted through this base class\n					virtual ~COptimizedKPSetIndividualComplexRoleData() {}\n", path)


if __name__ == "__main__":
    vendor = sys.argv[1]
    for f in FILES:
        p = f"{vendor}/{f}"
        s = open(p).read()
        out = modify(p, s)   # compute first: a failing modify() must not truncate the file
        open(p, "w").write(out)
