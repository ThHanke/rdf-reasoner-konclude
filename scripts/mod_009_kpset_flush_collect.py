import sys, os

# KPSet class classification: the TELLCLASSINITIALIZEPOSSIBLESUBSUM messages are buffered and processed by
# flushPendingInitMessages() at the phase transition. The loop that registers the items with open possible
# subsumptions for testing (nextItemList / remTestingSet / resevePossSubsumClassList) ran BEFORE the flush, so it only
# saw maps that already existed; items whose maps the flush created were never scheduled, and classification ended with
# thousands of unresolved possible subsumptions (true subsumptions lost). Collect again after the flush.

FILES = ["Source/Reasoner/Classifier/COptimizedKPSetClassSubsumptionClassifierThread.cpp"]

T = "\t"


def modify(rel_path, content):
    nl = "\r\n" if "\r\n" in content else "\n"
    c = content.replace("\r\n", "\n")
    old = (T * 8 + "flushPendingInitMessages(optKPSetClassificationItem);\n\n\n"
           + T * 8 + "foreach (COptimizedKPSetClassTestingItem* item, classList) {\n")
    assert c.count(old) == 1, rel_path
    new = (T * 8 + "flushPendingInitMessages(optKPSetClassificationItem);\n\n"
           + T * 8 + "// The flush created possible-subsumption maps after the collection loop above had run: register the\n"
           + T * 8 + "// items of those maps for testing too, otherwise their open candidates are never tested.\n"
           + T * 8 + "{\n"
           + T * 9 + "QSet<COptimizedKPSetClassTestingItem*> collectedItemSet;\n"
           + T * 9 + "foreach (COptimizedKPSetClassTestingItem* collectedItem, resevePossSubsumClassList) {\n"
           + T * 10 + "collectedItemSet.insert(collectedItem);\n"
           + T * 9 + "}\n"
           + T * 9 + "foreach (COptimizedKPSetClassTestingItem* lateItem, classList) {\n"
           + T * 10 + "COptimizedKPSetClassPossibleSubsumptionMap* lateSubsumMap = lateItem->getPossibleSubsumptionMap(false);\n"
           + T * 10 + "if (lateSubsumMap && lateSubsumMap->hasRemainingPossibleSubsumptions() && !collectedItemSet.contains(lateItem)) {\n"
           + T * 11 + "if (mConfPossSubsumCalcOrderTopDown) {\n"
           + T * 12 + "nextItemList->append(lateItem);\n"
           + T * 12 + "remTestingSet->insert(lateItem);\n"
           + T * 11 + "}\n"
           + T * 11 + "resevePossSubsumClassList.append(lateItem);\n"
           + T * 10 + "}\n"
           + T * 9 + "}\n"
           + T * 8 + "}\n\n"
           + T * 8 + "foreach (COptimizedKPSetClassTestingItem* item, classList) {\n")
    c = c.replace(old, new, 1)
    return c.replace("\n", nl) if nl == "\r\n" else c


if __name__ == "__main__":
    if "--list-files" in sys.argv:
        for f in FILES:
            print(f)
        sys.exit(0)
    root = sys.argv[1]
    for rel in FILES:
        p = os.path.join(root, rel)
        with open(p, newline="") as f:
            src = f.read()
        out = modify(rel, src)
        with open(p, "w", newline="") as f:
            f.write(out)
