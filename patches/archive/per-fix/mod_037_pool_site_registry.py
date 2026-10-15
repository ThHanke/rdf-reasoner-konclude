import sys

FILES = [
    "Source/Utilities/Memory/CNewCentralizedLimitedAllocationMemoryPoolProvider.cpp",
    "Source/Utilities/Memory/CNewAllocationMemoryPoolProvider.cpp",
]

if "--list-files" in sys.argv:
    for f in FILES:
        print(f)
    sys.exit(0)

# Diagnostic (native, KON_POOLSITE=<dir>): register every live pool block with its call index and allocation stack
# (KonPoolStats::siteAdd/siteDel) so the blocks that survive a call can be attributed to an allocation site.


def modify(path, content):
    n_alloc = content.count("KonPoolStats::poolAlloc(memoryBlockSize);")
    n_free = content.count("KonPoolStats::poolFree(tmpMemoryPool->getMemoryBlockSize());")
    if n_alloc < 1 or n_free != 1:
        raise ValueError(f"{path}: unexpected counts alloc={n_alloc} free={n_free}")
    content = content.replace("KonPoolStats::poolAlloc(memoryBlockSize);", "KonPoolStats::poolAlloc(memoryBlockSize, memoryPool);")
    content = content.replace("KonPoolStats::poolFree(tmpMemoryPool->getMemoryBlockSize());", "KonPoolStats::poolFree(tmpMemoryPool->getMemoryBlockSize(), tmpMemoryPool);")
    return content


if __name__ == "__main__":
    vendor = sys.argv[1]
    for f in FILES:
        p = f"{vendor}/{f}"
        s = open(p).read()
        out = modify(p, s)   # compute first: a failing modify() must not truncate the file
        open(p, "w").write(out)
