import sys

FILES = [
    "Source/Utilities/Memory/CMemoryPoolAllocationManager.h",
    "Source/Utilities/Memory/CMemoryPoolAllocationManager.cpp",
    "Source/Scheduler/CTaskProcessorThreadBase.h",
    "Source/Scheduler/CTaskProcessorThreadBase.cpp",
]

if "--list-files" in sys.argv:
    for f in FILES:
        print(f)
    sys.exit(0)

# Flush of the per-thread free-pool reserves (see KonPoolStats.h requestPoolFlush()): the free lists
# are owned by their thread, so each task processor thread frees its own list when it notices a new
# flush generation in its processing loop (the loop wakes at least every 100 ms).


def rep(content, old, new, path):
    if content.count(old) != 1:
        raise ValueError(f"{path}: expected 1 occurrence of {old!r}, found {content.count(old)}")
    return content.replace(old, new)


def modify(path, content):
    if path.endswith("CMemoryPoolAllocationManager.h"):
        return rep(content, "					virtual CMemoryTemporaryAllocationManager* releaseAllMemory();\n",
                   "					virtual CMemoryTemporaryAllocationManager* releaseAllMemory();\n\n					//! Return all pools of the free list to the provider (owner thread only)\n					CMemoryTemporaryAllocationManager* flushFreePools();\n", path)
    if path.endswith("CMemoryPoolAllocationManager.cpp"):
        return rep(content, "			CMemoryPool* CMemoryPoolAllocationManager::acqireTemporaryMemoryPool(size_t size) {",
                   """			CMemoryTemporaryAllocationManager* CMemoryPoolAllocationManager::flushFreePools() {
				while (mFreeMemoryPoolList) {
					CMemoryPool* tmpMemPool = mFreeMemoryPoolList;
					mFreeMemoryPoolList = mFreeMemoryPoolList->getNextMemoryPool();
					tmpMemPool->clearNext();
					mMemoryPoolProvider->releaseMemoryPool(tmpMemPool);
				}
				mFreeMemoryPoolCount = 0;
				return this;
			}


			CMemoryPool* CMemoryPoolAllocationManager::acqireTemporaryMemoryPool(size_t size) {""", path)
    if path.endswith("CTaskProcessorThreadBase.h"):
        return rep(content, "				CTaskHandleMemoryAllocationManager *mMemoryAllocator;\n",
                   "				CTaskHandleMemoryAllocationManager *mMemoryAllocator;\n				long long mSeenPoolFlushGen = 0;\n", path)
    if path.endswith("CTaskProcessorThreadBase.cpp"):
        content = rep(content, '#include "CTaskProcessorThreadBase.h"',
                      '#include "CTaskProcessorThreadBase.h"\n#include "KonPoolStats.h"\n#include "Utilities/Memory/CMemoryPoolAllocationManager.h"', path)
        return rep(content, "				mProcessingBlocked = false;\n				eventSafeguardProcessed = false;\n",
                   """				mProcessingBlocked = false;
				if (mSeenPoolFlushGen != KonPoolStats::gFlushGen.load(std::memory_order_acquire)) {
					mSeenPoolFlushGen = KonPoolStats::gFlushGen.load(std::memory_order_acquire);
					if (CMemoryPoolAllocationManager* poolMan = dynamic_cast<CMemoryPoolAllocationManager*>(mMemoryAllocator)) {
						poolMan->flushFreePools();
					}
				}
				eventSafeguardProcessed = false;
""", path)
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
