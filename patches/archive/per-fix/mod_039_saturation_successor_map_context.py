import sys

FILES = [
    "Source/Utilities/Container/CQtManagedRestrictedModificationMap.h",
    "Source/Reasoner/Kernel/Process/CLinkedRoleSaturationSuccessorHash.cpp",
]

if "--list-files" in sys.argv:
    for f in FILES:
        print(f)
    sys.exit(0)

# CLinkedRoleSaturationSuccessorData was built with CObjectAllocator::allocateAndConstruct, i.e. through its default
# argument context = nullptr. Its successor map (mSuccNodeDataMap) therefore had a null memory manager: every node and
# bucket array was plain malloc, but the data object itself lives in a task pool that is dropped wholesale (no
# destructor), so the malloc'd map memory was never freed (~4.4 MB per Roberts realization). Build the data object with
# the hash's process context and rebind the map to the writing task's context before each write: the data object is
# shared along the task chain and later tasks write into it; they must allocate from their own pool, which lives as long
# as the chain (overtaken chains are released together, patch 023).


def rep(content, old, new, path):
    if content.count(old) != 1:
        raise ValueError(f"{path}: expected 1 occurrence of {old!r}, found {content.count(old)}")
    return content.replace(old, new)


def modify(path, content):
    if path.endswith("CQtManagedRestrictedModificationMap.h"):
        return rep(content,
            "					CQtManagedRestrictedModificationMap<Key, T>* init(const CQtManagedRestrictedModificationMap<Key, T> &other, CContext* context = nullptr);\n",
            "					//! Allocate all further nodes/buckets from the given context's memory manager (existing ones keep their allocator)\n					inline void rebindContext(CContext* context) {\n						mContext = context;\n						mMemMan = CContext::getMemoryAllocationManager(mContext);\n					}\n\n					CQtManagedRestrictedModificationMap<Key, T>* init(const CQtManagedRestrictedModificationMap<Key, T> &other, CContext* context = nullptr);\n", path)
    content = rep(content,
        "					CSaturationSuccessorData*& succData = roleSuccData->mSuccNodeDataMap[linkedIndiID];\n",
        "					roleSuccData->mSuccNodeDataMap.rebindContext(mContext);\n					CSaturationSuccessorData*& succData = roleSuccData->mSuccNodeDataMap[linkedIndiID];\n", path)
    content = rep(content,
        "						roleSuccData = CObjectAllocator<CLinkedRoleSaturationSuccessorData>::allocateAndConstruct(mContext->getUsedMemoryAllocationManager());\n",
        "						roleSuccData = CObjectParameterizingAllocator<CLinkedRoleSaturationSuccessorData, CProcessContext*>::allocateAndConstructAndParameterize(mContext->getUsedMemoryAllocationManager(), mContext);\n", path)
    return content


if __name__ == "__main__":
    vendor = sys.argv[1]
    for f in FILES:
        p = f"{vendor}/{f}"
        s = open(p).read()
        out = modify(p, s)   # compute first: a failing modify() must not truncate the file
        open(p, "w").write(out)
