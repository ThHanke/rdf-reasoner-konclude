import sys

FILES = ["Source/Reasoner/Realizer/COptimizedKPSetRoleInstancesItem.cpp"]

if "--list-files" in sys.argv:
    for f in FILES:
        print(f)
    sys.exit(0)

# mComplexCandidateProcessingQueuedFlag was never initialized (not in the constructor, not in
# initInstancesItem). A recycled heap block with a non-zero byte made the item look "already queued":
# patch 019's requeue guard then skipped it and its complex role candidates were never confirmed
# (lossy isRelationOf in sequential realizations). Found 2026-10-12 with the deterministic scheduler:
# dumpRoleState printed complexQueuedFlag=104 for the lossy run.


def modify(path, content):
    old = "				mPossibleProcessingQueuedFlag = false;\n				mSelfSuccsCompletedFlag = false;\n"
    new = "				mPossibleProcessingQueuedFlag = false;\n				mComplexCandidateProcessingQueuedFlag = false;\n				mSelfSuccsCompletedFlag = false;\n"
    if content.count(old) != 1:
        raise ValueError(f"{path}: expected 1 occurrence, found {content.count(old)}")
    return content.replace(old, new)


if __name__ == "__main__":
    vendor = sys.argv[1]
    for f in FILES:
        p = f"{vendor}/{f}"
        s = open(p).read()
        open(p, "w").write(modify(p, s))
