import sys, os

D = "Source/Reasoner/Kernel/Cache/"
FILES = [
    D + "CSaturationNodeAssociatedExpansionCacheContext.h",
    D + "CSaturationNodeAssociatedExpansionCacheContext.cpp",
    D + "CSaturationNodeAssociatedExpansionCache.h",
    D + "CSaturationNodeAssociatedExpansionCache.cpp",
]


def rep(c, old, new, rel):
    assert c.count(old) == 1, (rel, old[:60])
    return c.replace(old, new, 1)


def modify(rel_path, content):
    nl = "\r\n" if "\r\n" in content else "\n"
    c = content.replace("\r\n", "\n")
    if rel_path.endswith("Context.h"):
        c = rep(c, "\t\t\t\t\t\tCSaturationNodeAssociatedExpansionCacheContext* releaseTemporaryMemoryPools(CMemoryPool* memoryPools);\n",
                "\t\t\t\t\t\tCSaturationNodeAssociatedExpansionCacheContext* releaseTemporaryMemoryPools(CMemoryPool* memoryPools);\n"
                "\t\t\t\t\t\t// give all arena memory back (only valid when no live node still refers to cache entries allocated here)\n"
                "\t\t\t\t\t\tCSaturationNodeAssociatedExpansionCacheContext* resetArena();\n", rel_path)
    elif rel_path.endswith("Context.cpp"):
        c = rep(c, "\t\t\t\tCIndividualSaturationProcessNodeStatusUpdateLinker* CSaturationNodeAssociatedExpansionCacheContext::getIndividualSaturationUpdateLinker(bool create) {\n",
                "\t\t\t\tCSaturationNodeAssociatedExpansionCacheContext* CSaturationNodeAssociatedExpansionCacheContext::resetArena() {\n"
                "\t\t\t\t\tmMemMan->releaseAllMemory();\n"
                "\t\t\t\t\tmMemMan->flushFreePools();\n"
                "\t\t\t\t\tmConSatUpdateLinker = nullptr;\n"
                "\t\t\t\t\tmAddRelMemory = 0;\n"
                "\t\t\t\t\treturn this;\n"
                "\t\t\t\t}\n\n\n"
                "\t\t\t\tCIndividualSaturationProcessNodeStatusUpdateLinker* CSaturationNodeAssociatedExpansionCacheContext::getIndividualSaturationUpdateLinker(bool create) {\n", rel_path)
    elif rel_path.endswith("Cache.h"):
        c = rep(c, "\t\t\t\t\t\tCSaturationNodeAssociatedExpansionCacheContext mContext;\n",
                "\t\t\t\t\t\tCSaturationNodeAssociatedExpansionCacheContext mContext;\n"
                "\t\t\t\t\t\t// second arena: the cache entries hang off saturation nodes of one ontology and were allocated from one\n"
                "\t\t\t\t\t\t// never-freed arena, so every ontology leaked its entries. Arenas alternate per ontology epoch; the arena\n"
                "\t\t\t\t\t\t// of the ontology two generations back (dead by then) is reset on the first write of a new epoch.\n"
                "\t\t\t\t\t\tCSaturationNodeAssociatedExpansionCacheContext mContext2;\n"
                "\t\t\t\t\t\tCSaturationNodeAssociatedExpansionCacheContext* mCurrentContext;\n"
                "\t\t\t\t\t\tlong long mContextEpoch;\n", rel_path)
        c = rep(c, "\t\t\t\t\t\tvirtual bool processCustomsEvents(QEvent::Type type, CCustomEvent *event);\n",
                "\t\t\t\t\t\tvirtual bool processCustomsEvents(QEvent::Type type, CCustomEvent *event);\n"
                "\t\t\t\t\t\tCSaturationNodeAssociatedExpansionCacheContext* selectContext();\n", rel_path)
    elif rel_path.endswith("Cache.cpp"):
        c = rep(c, '#include "CSaturationNodeAssociatedExpansionCache.h"\n',
                '#include "CSaturationNodeAssociatedExpansionCache.h"\n#include "KonPoolStats.h"\n', rel_path)
        c = rep(c, "\t\t\t\t\tmSaturationNodeCacheUpdate = new CSaturationNodeCacheUpdater(&mContext);\n",
                "\t\t\t\t\tmSaturationNodeCacheUpdate = new CSaturationNodeCacheUpdater(&mContext);\n"
                "\t\t\t\t\tmCurrentContext = &mContext;\n"
                "\t\t\t\t\tmContextEpoch = KonPoolStats::gOntologyEpoch.load();\n", rel_path)
        c = rep(c, "\t\t\t\t\t\tinstallWriteCacheData(writeData,&mContext);\n\t\t\t\t\t\tmContext.getMemoryPoolAllocationManager()->releaseTemporaryMemoryPools(memoryPools);\n",
                "\t\t\t\t\t\tCSaturationNodeAssociatedExpansionCacheContext* context = selectContext();\n"
                "\t\t\t\t\t\tinstallWriteCacheData(writeData,context);\n"
                "\t\t\t\t\t\tcontext->getMemoryPoolAllocationManager()->releaseTemporaryMemoryPools(memoryPools);\n", rel_path)
        c = rep(c, "\t\t\t\tbool CSaturationNodeAssociatedExpansionCache::processCustomsEvents(QEvent::Type type, CCustomEvent *event) {\n",
                "\t\t\t\tCSaturationNodeAssociatedExpansionCacheContext* CSaturationNodeAssociatedExpansionCache::selectContext() {\n"
                "\t\t\t\t\tlong long epoch = KonPoolStats::gOntologyEpoch.load(std::memory_order_acquire);\n"
                "\t\t\t\t\tif (epoch != mContextEpoch) {\n"
                "\t\t\t\t\t\tmContextEpoch = epoch;\n"
                "\t\t\t\t\t\tmCurrentContext = (epoch & 1) ? &mContext2 : &mContext;\n"
                "\t\t\t\t\t\tmCurrentContext->resetArena();\n"
                "\t\t\t\t\t}\n"
                "\t\t\t\t\treturn mCurrentContext;\n"
                "\t\t\t\t}\n\n\n\n"
                "\t\t\t\tbool CSaturationNodeAssociatedExpansionCache::processCustomsEvents(QEvent::Type type, CCustomEvent *event) {\n", rel_path)
    return c.replace("\n", nl) if nl == "\r\n" else c


if __name__ == "__main__":
    if "--list-files" in sys.argv:
        for f in FILES:
            print(f)
        sys.exit(0)
    vendor_dir = sys.argv[1]
    for rel_path in FILES:
        full = os.path.join(vendor_dir, rel_path)
        with open(full, newline="") as fh:
            content = fh.read()
        new = modify(rel_path, content)
        if new != content:
            with open(full, "w", newline="") as fh:
                fh.write(new)
