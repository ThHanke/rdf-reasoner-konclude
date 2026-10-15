import re
import sys

FILES = [
    "Source/Reasoner/Classifier/COptimizedKPSetRoleSubsumptionClassifierThread.cpp",
    "Source/Reasoner/Classifier/COptimizedKPSetClassSubsumptionClassifierThread.cpp",
    "Source/Reasoner/Classifier/COptimizedSubClassSubsumptionClassifierThread.cpp",
    "Source/Reasoner/Classifier/COptimizedClassExtractedSaturationSubsumptionClassifierThread.cpp",
    "Source/Reasoner/Classifier/CIncrementalKPSetClassSubsumptionClassifierThread.cpp",
    "Source/Reasoner/Classifier/COptimizedKPSetRoleOntologyClassificationItem.cpp",
]

if "--list-files" in sys.argv:
    for f in FILES:
        print(f)
    sys.exit(0)

# Finished classification items are queued in mStaleClassItems and only deleted by the BASE class
# scheduleOntologyClassification (at the start of the next classification). Every concrete classifier thread overrides
# that method without calling the base, so the queue was never flushed: each call leaked its class/role classification
# items, their testing items (COptimizedKPSetClass/RoleTestingItem) and the temporary role classification ontology
# (found by a vtable census of the process heap and ctor/dtor counts: items created, never destroyed).
# Flush the queue at the start of every override: same "delete stale items at the start of the next call" rule.

FLUSH = "				for (auto* stale : mStaleClassItems) { delete stale; }\n				mStaleClassItems.clear();\n"


def modify(path, content):
    if path.endswith("COptimizedKPSetRoleOntologyClassificationItem.cpp"):
        # The temporary role classification ontology shares the main ontology's CConsistence (setConsistence in
        # createTemporaryRoleClassificationOntology); ~CConcreteOntology deletes it -> double delete. The realizing item
        # clears it before deleting its temporary ontologies; do the same here.
        old = "				delete mTmpRoleClassificationOnt;\n"
        if content.count(old) != 1:
            raise ValueError(f"{path}: expected 1 delete of mTmpRoleClassificationOnt, found {content.count(old)}")
        return content.replace(old, "				if (mTmpRoleClassificationOnt) {\n					mTmpRoleClassificationOnt->setConsistence(nullptr);\n				}\n				delete mTmpRoleClassificationOnt;\n")
    pat = re.compile(r"(::scheduleOntologyClassification\([^)]*\)\s*\{)(\r?\n)")
    ms = pat.findall(content)
    if len(ms) != 1:
        raise ValueError(f"{path}: expected 1 scheduleOntologyClassification override, found {len(ms)}")
    def sub(m):
        eol = m.group(2)
        return m.group(1) + eol + FLUSH.replace("\n", eol)
    return pat.sub(sub, content, count=1)


if __name__ == "__main__":
    vendor = sys.argv[1]
    for f in FILES:
        p = f"{vendor}/{f}"
        s = open(p).read()
        out = modify(p, s)   # compute first: a failing modify() must not truncate the file
        open(p, "w").write(out)
