import sys

U = "Source/Utilities/Memory/"
FILES = [
    "Source/Scheduler/CTaskStatus.cpp",
    U + "CMemoryPoolAllocationManager.cpp",
    U + "CNewAllocationMemoryPoolProvider.cpp",
    U + "CNewCentralizedLimitedAllocationMemoryPoolProvider.cpp",
]

if "--list-files" in sys.argv:
    for f in FILES:
        print(f)
    sys.exit(0)

# Diagnostic only (counters in src/compat/KonPoolStats.h): task lifecycle and memory-pool
# allocation/release totals, to find what keeps per-call task memory alive.


def rep(content, old, new, path, count=1):
    if content.count(old) != count:
        raise ValueError(f"{path}: expected {count} occurrence(s) of {old!r}, found {content.count(old)}")
    return content.replace(old, new)


def modify(path, content):
    inc = lambda c, first: rep(c, first, first + '\n#include "KonPoolStats.h"', path)
    if path.endswith("CTaskStatus.cpp"):
        content = inc(content, '#include "CTaskStatus.h"')
        content = rep(content, "			mReleaseable = true;\n", "			mReleaseable = true;\n			KonPoolStats::gTasksCreated.fetch_add(1, std::memory_order_relaxed);\n", path)
        content = rep(content, "			mTaskState = TSCOMPLETED;\n",
                      "			mTaskState = TSCOMPLETED;\n			KonPoolStats::gTasksCompleted.fetch_add(1, std::memory_order_relaxed);\n			if (!mReleaseable) KonPoolStats::gTasksKept.fetch_add(1, std::memory_order_relaxed);\n", path)
    elif path.endswith("CMemoryPoolAllocationManager.cpp"):
        content = inc(content, '#include "CMemoryPoolAllocationManager.h"')
        content = rep(content, "				CMemoryPool* memoryPoolLinker = memoryPoolContainer->takeMemoryPools();\n				return releaseTemporaryMemoryPools(memoryPoolLinker);",
                      "				CMemoryPool* memoryPoolLinker = memoryPoolContainer->takeMemoryPools();\n				KonPoolStats::gContainersReleased.fetch_add(1, std::memory_order_relaxed);\n				return releaseTemporaryMemoryPools(memoryPoolLinker);", path)
    elif path.endswith("CNewAllocationMemoryPoolProvider.cpp"):
        content = inc(content, '#include "CNewAllocationMemoryPoolProvider.h"')
        content = rep(content, "				mStatAllocatedPoolSize += memoryBlockSize;\n", "				mStatAllocatedPoolSize += memoryBlockSize;\n				KonPoolStats::poolAlloc(memoryBlockSize);\n", path)
        content = rep(content, "					mStatReleasedPoolSize += tmpMemoryPool->getMemoryBlockSize();\n", "					mStatReleasedPoolSize += tmpMemoryPool->getMemoryBlockSize();\n					KonPoolStats::poolFree(tmpMemoryPool->getMemoryBlockSize());\n", path)
    elif path.endswith("CNewCentralizedLimitedAllocationMemoryPoolProvider.cpp"):
        content = inc(content, '#include "CNewCentralizedLimitedAllocationMemoryPoolProvider.h"')
        content = rep(content, "mStatAllocatedPoolSize += memoryBlockSize;\n", "mStatAllocatedPoolSize += memoryBlockSize;\n				KonPoolStats::poolAlloc(memoryBlockSize);\n", path, count=2)
        content = rep(content, "					mStatReleasedPoolSize += tmpMemoryPool->getMemoryBlockSize();\n", "					mStatReleasedPoolSize += tmpMemoryPool->getMemoryBlockSize();\n					KonPoolStats::poolFree(tmpMemoryPool->getMemoryBlockSize());\n", path)
    return content


if __name__ == "__main__" and len(sys.argv) > 1:
    from pathlib import Path
    vendor_dir = Path(sys.argv[1])
    for rel_path in FILES:
        p = vendor_dir / rel_path
        content = p.read_text(encoding="utf-8")
        new_content = modify(rel_path, content)
        if new_content != content:
            p.write_text(new_content, encoding="utf-8")
            print(f"  modified: {rel_path}")
