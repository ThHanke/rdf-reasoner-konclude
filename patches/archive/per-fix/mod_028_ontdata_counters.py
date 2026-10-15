import sys

FILES = ["Source/Reasoner/Kernel/Cache/CBackendRepresentativeMemoryCache.cpp"]

if "--list-files" in sys.argv:
    for f in FILES:
        print(f)
    sys.exit(0)

# Diagnostic counters (KonPoolStats.h) for the backend cache's per-ontology data: created, freed
# (any of the three delete sites), evicted-but-still-referenced (usage count > 0 after eviction).


def rep(content, old, new, path, count=1):
    if content.count(old) != count:
        raise ValueError(f"{path}: expected {count} occurrence(s) of {old!r}, found {content.count(old)}")
    return content.replace(old, new)


def modify(path, content):
    content = rep(content, "ontologyData = new CBackendRepresentativeMemoryCacheOntologyData(&mContext);\n",
                  "ontologyData = new CBackendRepresentativeMemoryCacheOntologyData(&mContext);\n						KonPoolStats::gOntDataCreated.fetch_add(1, std::memory_order_relaxed);\n", path)
    content = rep(content, "								delete prevOntologyData;\n",
                  "								KonPoolStats::gOntDataFreed.fetch_add(1, std::memory_order_relaxed);\n								delete prevOntologyData;\n", path)
    content = rep(content, "									delete ontologyData;\n",
                  "									KonPoolStats::gOntDataFreed.fetch_add(1, std::memory_order_relaxed);\n									delete ontologyData;\n", path)
    content = rep(content, "											delete staleData;\n										}\n",
                  "											KonPoolStats::gOntDataFreed.fetch_add(1, std::memory_order_relaxed);\n											delete staleData;\n										} else {\n											KonPoolStats::gOntDataStaleKept.fetch_add(1, std::memory_order_relaxed);\n										}\n", path)
    if '#include "KonPoolStats.h"' not in content:
        content = content.replace('#include "CBackendRepresentativeMemoryCache.h"', '#include "CBackendRepresentativeMemoryCache.h"\n#include "KonPoolStats.h"', 1)
        if '#include "KonPoolStats.h"' not in content:
            raise ValueError(f"{path}: include anchor not found")
    return content


if __name__ == "__main__":
    vendor = sys.argv[1]
    for f in FILES:
        p = f"{vendor}/{f}"
        s = open(p).read()
        open(p, "w").write(modify(p, s))
