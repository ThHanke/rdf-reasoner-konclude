import sys

FILES = [
    "Source/Reasoner/Realizer/COntologyRealizingItem.h",
    "Source/Reasoner/Realizer/CRealizerThread.h",
    "Source/Reasoner/Realizer/CRealizerThread.cpp",
]

if "--list-files" in sys.argv:
    for f in FILES:
        print(f)
    sys.exit(0)

# 1. COntologyRealizingItem has virtual methods but no virtual destructor, and items are deleted through
#    COntologyRealizingItem* (upstream's "delete stale items" in CRealizerThread). That skipped the derived
#    item's destructor (all realization data leaked) and passed a wrong size to sized operator delete.
# 2. A per-ontology realizer thread keeps its finished items in mInactiveOntItemSet; they were only deleted when the
#    same thread created a newer item, which never happens. releaseOntologyItems() frees them; the port calls it
#    after joining the stopped realizer (the thread object itself must stay alive, see WasmRealizationManager).


def rep(content, old, new, path):
    if content.count(old) != 1:
        raise ValueError(f"{path}: expected 1 occurrence of {old!r}, found {content.count(old)}")
    return content.replace(old, new)


def modify(path, content):
    if path.endswith("COntologyRealizingItem.h"):
        content = rep(content,
            "					//! Constructor\n					COntologyRealizingItem();\n",
            "					//! Constructor\n					COntologyRealizingItem();\n\n					//! Virtual: items are deleted through this base class\n					virtual ~COntologyRealizingItem() {}\n", path)
    elif path.endswith("CRealizerThread.h"):
        anchor = "					virtual bool callbackRealized(CConcreteOntology* ontology, CCallbackData* callback);"
        if anchor not in content:
            raise ValueError(f"{path}: anchor not found")
        content = content.replace(anchor,
            "					//! Delete all realizing items of this (stopped) thread; the thread object stays valid\n					virtual CRealizerThread* releaseOntologyItems();\n\n" + anchor, 1)
    elif path.endswith("CRealizerThread.cpp"):
        content = rep(content,
            "			CRealizerThread::~CRealizerThread() {\n				stopThread();\n			}\n",
            "			CRealizerThread::~CRealizerThread() {\n				stopThread();\n			}\n\n\n"
            "			CRealizerThread* CRealizerThread::releaseOntologyItems() {\n"
            "				QSet<COntologyRealizingItem*> items = mActiveOntItemSet;\n"
            "				items.unite(mInactiveOntItemSet);\n"
            "				mActiveOntItemSet.clear();\n"
            "				mInactiveOntItemSet.clear();\n"
            "				mProcessingOntItemList.clear();\n"
            "				mOntItemHash.clear();\n"
            "				for (COntologyRealizingItem* item : items) {\n"
            "					delete item;\n"
            "				}\n"
            "				return this;\n"
            "			}\n", path)
    return content


if __name__ == "__main__":
    vendor = sys.argv[1]
    for f in FILES:
        p = f"{vendor}/{f}"
        s = open(p).read()
        out = modify(p, s)   # compute first: a failing modify() must not truncate the file
        open(p, "w").write(out)
