import sys

FILES = [
    "Source/Reasoner/Kernel/Cache/CBackendRepresentativeMemoryCacheReader.h",
    "Source/Reasoner/Kernel/Cache/CBackendRepresentativeMemoryCacheReader.cpp",
    "Source/Reasoner/Kernel/Cache/CBackendRepresentativeMemoryCache.h",
    "Source/Reasoner/Kernel/Cache/CBackendRepresentativeMemoryCache.cpp",
    "Source/Reasoner/Realizer/COptimizedRepresentativeKPSetOntologyRealizingItem.cpp",
]

if "--list-files" in sys.argv:
    for f in FILES:
        print(f)
    sys.exit(0)

# The realizer creates a fixed cache reader per ontology (createOntologyFixedCacheReader), which adds
# one usage reference to the ontology's cache data. Nothing ever released it, so after the cache evicted
# the stale data (which drops the other references) the data, its ~200 MB of pools and the reader
# stayed alive forever: one leaked ontology generation per reasoning call.
# Fix: the realizing item hands the reference back when it dies; the cache drops it on its own thread
# at the start of the next prepareOntologyDataUpdate() and frees the data when nothing else uses it
# (same cleanup as the stale-eviction path; slot references are released by cleanUnusedSlots()).


def rep(content, old, new, path):
    if content.count(old) != 1:
        raise ValueError(f"{path}: expected 1 occurrence of {old!r}, found {content.count(old)}")
    return content.replace(old, new)


def modify(path, content):
    if path.endswith("CBackendRepresentativeMemoryCacheReader.h"):
        content = rep(content,
            "						CBackendRepresentativeMemoryCacheReader* fixOntologyData(CBackendRepresentativeMemoryCacheOntologyData* ontologyData);\n",
            "						CBackendRepresentativeMemoryCacheReader* fixOntologyData(CBackendRepresentativeMemoryCacheOntologyData* ontologyData);\n"
            "						//! Remember the cache that owns the fixed data's extra usage reference (set by createOntologyFixedCacheReader)\n"
            "						CBackendRepresentativeMemoryCacheReader* setFixedReleaseCache(void* cache);\n"
            "						//! Hand the fixed data's usage reference back to the cache (queued, executed on the cache thread)\n"
            "						void releaseFixedOntologyData();\n", path)
        content = rep(content,
            "						CBackendRepresentativeMemoryCacheOntologyData* mFixedOntologyData;\n",
            "						CBackendRepresentativeMemoryCacheOntologyData* mFixedOntologyData;\n						void* mFixedReleaseCache = nullptr;\n", path)
    elif path.endswith("CBackendRepresentativeMemoryCacheReader.cpp"):
        content = rep(content, '#include "CBackendRepresentativeMemoryCacheReader.h"\n',
            '#include "CBackendRepresentativeMemoryCacheReader.h"\n#include "CBackendRepresentativeMemoryCache.h"\n', path)
        content = rep(content,
            "				bool CBackendRepresentativeMemoryCacheReader::hasUpdatedSlotItem() {\n",
            "				CBackendRepresentativeMemoryCacheReader* CBackendRepresentativeMemoryCacheReader::setFixedReleaseCache(void* cache) {\n"
            "					mFixedReleaseCache = cache;\n"
            "					return this;\n"
            "				}\n\n\n"
            "				void CBackendRepresentativeMemoryCacheReader::releaseFixedOntologyData() {\n"
            "					if (mFixedOntologyData && mFixedReleaseCache) {\n"
            "						static_cast<CBackendRepresentativeMemoryCache*>(mFixedReleaseCache)->queueFixedReaderRelease(mFixedOntologyData);\n"
            "					}\n"
            "					mFixedOntologyData = nullptr;\n"
            "					mOntologyData = nullptr;\n"
            "					mFixedReleaseCache = nullptr;\n"
            "				}\n\n\n"
            "				bool CBackendRepresentativeMemoryCacheReader::hasUpdatedSlotItem() {\n", path)
    elif path.endswith("CBackendRepresentativeMemoryCache.h"):
        content = rep(content,
            "						CBackendRepresentativeMemoryCacheReader* createOntologyFixedCacheReader(cint64 ontologyIdentifier);\n",
            "						CBackendRepresentativeMemoryCacheReader* createOntologyFixedCacheReader(cint64 ontologyIdentifier);\n"
            "						//! Thread-safe: a fixed reader gives its usage reference back (processed by drainFixedReaderReleases on the cache thread)\n"
            "						void queueFixedReaderRelease(CBackendRepresentativeMemoryCacheOntologyData* ontologyData);\n"
            "						void drainFixedReaderReleases();\n", path)
        content = rep(content,
            "						QReadWriteLock mFixedOntologyIdentifierDataHashLock;\n",
            "						QReadWriteLock mFixedOntologyIdentifierDataHashLock;\n"
            "						QMutex mPendingFixedReleasesMutex;\n"
            "						QList<CBackendRepresentativeMemoryCacheOntologyData*> mPendingFixedReleases;\n", path)
    elif path.endswith("CBackendRepresentativeMemoryCache.cpp"):
        content = rep(content,
            "					reader->fixOntologyData(ontologyData);\n",
            "					reader->fixOntologyData(ontologyData);\n					if (ontologyData) {\n						reader->setFixedReleaseCache(this);\n					}\n", path)
        content = rep(content,
            "				CBackendRepresentativeMemoryCacheWriter* CBackendRepresentativeMemoryCache::createCacheWriter() {\n",
            "				void CBackendRepresentativeMemoryCache::queueFixedReaderRelease(CBackendRepresentativeMemoryCacheOntologyData* ontologyData) {\n"
            "					mPendingFixedReleasesMutex.lock();\n"
            "					mPendingFixedReleases.append(ontologyData);\n"
            "					mPendingFixedReleasesMutex.unlock();\n"
            "				}\n\n\n"
            "				void CBackendRepresentativeMemoryCache::drainFixedReaderReleases() {\n"
            "					QList<CBackendRepresentativeMemoryCacheOntologyData*> pending;\n"
            "					mPendingFixedReleasesMutex.lock();\n"
            "					pending.swap(mPendingFixedReleases);\n"
            "					mPendingFixedReleasesMutex.unlock();\n"
            "					if (pending.isEmpty()) {\n"
            "						return;\n"
            "					}\n"
            "					CMemoryPoolAllocationManager* memMan = mContext.getMemoryPoolAllocationManager();\n"
            "					for (CBackendRepresentativeMemoryCacheOntologyData* data : pending) {\n"
            "						data->decUsageCount();\n"
            "						if (data->getUsageCount() <= 0) {\n"
            "							++mOntologyDataReleasedCount;\n"
            "							if (data->getRecomputationReferenceLinker()) {\n"
            "								data->getRecomputationReferenceLinker()->setOntologyDataInactive();\n"
            "							}\n"
            "							CBackendRepresentativeMemoryCacheOntologyContext* ontCtx = data->getOntologyContext();\n"
            "							if (ontCtx) {\n"
            "								CMemoryPool* ontCtxPools = ontCtx->getMemoryPoolContainer()->getMemoryPools();\n"
            "								if (ontCtxPools) {\n"
            "									memMan->releaseTemporaryMemoryPools(ontCtxPools);\n"
            "								}\n"
            "								delete ontCtx;\n"
            "							}\n"
            "							CMemoryPool* tmpPools = data->getTemporaryContext()->getMemoryPoolContainer()->getMemoryPools();\n"
            "							if (tmpPools) {\n"
            "								memMan->releaseTemporaryMemoryPools(tmpPools);\n"
            "							}\n"
            "							KonPoolStats::gOntDataFreed.fetch_add(1, std::memory_order_relaxed);\n"
            "							KonPoolStats::gOntDataReaderReleased.fetch_add(1, std::memory_order_relaxed);\n"
            "							delete data;\n"
            "						}\n"
            "					}\n"
            "				}\n\n\n"
            "				CBackendRepresentativeMemoryCacheWriter* CBackendRepresentativeMemoryCache::createCacheWriter() {\n", path)
        content = rep(content,
            "					CBackendRepresentativeMemoryCacheOntologyData*& ontologyData = (*mOntologyIdentifierDataHash)[ontologyIdentifier];\n					if (!ontologyData || ontologyData->isSlotUpdateIntegrated()) {\n",
            "					drainFixedReaderReleases();\n					CBackendRepresentativeMemoryCacheOntologyData*& ontologyData = (*mOntologyIdentifierDataHash)[ontologyIdentifier];\n					if (!ontologyData || ontologyData->isSlotUpdateIntegrated()) {\n", path)
    elif path.endswith("COptimizedRepresentativeKPSetOntologyRealizingItem.cpp"):
        content = rep(content,
            "				for (auto* v : mDataRoleNonDetCacheLabelItemSetHash) { delete v; }\n",
            "				for (auto* v : mDataRoleNonDetCacheLabelItemSetHash) { delete v; }\n"
            "				if (mBackendAssocCacheReader) {\n"
            "					mBackendAssocCacheReader->releaseFixedOntologyData();\n"
            "					delete mBackendAssocCacheReader;\n"
            "					mBackendAssocCacheReader = nullptr;\n"
            "				}\n", path)
    return content


if __name__ == "__main__":
    vendor = sys.argv[1]
    for f in FILES:
        p = f"{vendor}/{f}"
        s = open(p).read()
        open(p, "w").write(modify(p, s))
