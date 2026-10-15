import sys

FILES = [
    "Source/Reasoner/Kernel/Cache/CBackendRepresentativeMemoryCache.cpp",
    "Source/Reasoner/Realizer/COptimizedRepresentativeKPSetOntologyRealizingItem.cpp",
    "Source/Reasoner/Realizer/COptimizedRepresentativeKPSetOntologyRealizingThread.cpp",
]

if "--list-files" in sys.argv:
    for f in FILES:
        print(f)
    sys.exit(0)

# Diagnostics for patch 029: realizing items created/destroyed, fixed-reader hand-backs queued/drained/still referenced.


def rep(content, old, new, path):
    if content.count(old) != 1:
        raise ValueError(f"{path}: expected 1 occurrence of {old!r}, found {content.count(old)}")
    return content.replace(old, new)


def modify(path, content):
    if path.endswith("CBackendRepresentativeMemoryCache.cpp"):
        content = rep(content, "					mPendingFixedReleases.append(ontologyData);\n",
                      "					mPendingFixedReleases.append(ontologyData);\n					KonPoolStats::gReaderReleasesQueued.fetch_add(1, std::memory_order_relaxed);\n", path)
        content = rep(content, "						data->decUsageCount();\n						if (data->getUsageCount() <= 0) {\n							++mOntologyDataReleasedCount;\n							if (data->getRecomputationReferenceLinker()) {",
                      "						data->decUsageCount();\n						KonPoolStats::gReaderReleasesDrained.fetch_add(1, std::memory_order_relaxed);\n						KonPoolStats::gReaderDrainLastUsage.store(data->getUsageCount(), std::memory_order_relaxed);\n						if (data->getUsageCount() <= 0) {\n							++mOntologyDataReleasedCount;\n							if (data->getRecomputationReferenceLinker()) {", path)
    elif path.endswith("OntologyRealizingItem.cpp"):
        content = rep(content, "				if (mBackendAssocCacheReader) {\n					mBackendAssocCacheReader->releaseFixedOntologyData();",
                      "				KonPoolStats::gRealItemsDestroyed.fetch_add(1, std::memory_order_relaxed);\n				if (mBackendAssocCacheReader) {\n					mBackendAssocCacheReader->releaseFixedOntologyData();", path)
        if '#include "KonPoolStats.h"' not in content:
            content = rep(content, '#include "COptimizedRepresentativeKPSetOntologyRealizingItem.h"\n',
                          '#include "COptimizedRepresentativeKPSetOntologyRealizingItem.h"\n#include "KonPoolStats.h"\n', path)
    elif path.endswith("OntologyRealizingThread.cpp"):
        content = rep(content, "				COptimizedRepresentativeKPSetOntologyRealizingItem* item = new COptimizedRepresentativeKPSetOntologyRealizingItem();\n",
                      "				COptimizedRepresentativeKPSetOntologyRealizingItem* item = new COptimizedRepresentativeKPSetOntologyRealizingItem();\n				KonPoolStats::gRealItemsCreated.fetch_add(1, std::memory_order_relaxed);\n", path)
        if '#include "KonPoolStats.h"' not in content:
            content = rep(content, '#include "COptimizedRepresentativeKPSetOntologyRealizingThread.h"\n',
                          '#include "COptimizedRepresentativeKPSetOntologyRealizingThread.h"\n#include "KonPoolStats.h"\n', path)
    return content


if __name__ == "__main__":
    vendor = sys.argv[1]
    for f in FILES:
        p = f"{vendor}/{f}"
        s = open(p).read()
        open(p, "w").write(modify(p, s))
