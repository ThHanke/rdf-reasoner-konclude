import sys

FILES = ["Source/Reasoner/Kernel/Process/CIndividualNodeRepresentativeMemoryBackendCacheSynchronisationData.cpp"]

if "--list-files" in sys.argv:
    for f in FILES:
        print(f)
    sys.exit(0)

# The copy-init of the per-individual backend sync data called hash->init(otherHash) without a context.
# CQtManagedRestrictedModificationHash/Map::init(other, context = nullptr) overwrites mContext/mMemMan with
# that null context, so the hash (created with the task's pool manager) silently switched to plain malloc:
# its detach copies and new nodes were malloc'd, but the owning task pool is dropped wholesale and the
# hash destructor never runs -> ~77 MB per Roberts realization leaked. Pass the sync data's process context.

OLD_NEW = [
    ("getRoleNeighbourExpansionDataHash()->init(synchData->mRoleNeighbourExpansionDataHash);",
     "getRoleNeighbourExpansionDataHash()->init(synchData->mRoleNeighbourExpansionDataHash, mContext);"),
    ("getNeighbourExpansionDataHash()->init(synchData->mNeighbourExpansionDataHash);",
     "getNeighbourExpansionDataHash()->init(synchData->mNeighbourExpansionDataHash, mContext);"),
    ("getNeighbourLabelExpansionDataHash(i, true)->init(hash);",
     "getNeighbourLabelExpansionDataHash(i, true)->init(hash, mContext);"),
    ("getIntegratedMergedIndividualIdSet()->init(synchData->mIntegratedMergedIndividualIdSet);",
     "getIntegratedMergedIndividualIdSet()->init(synchData->mIntegratedMergedIndividualIdSet, mContext);"),
    ("getRemainingIndirectCompatibilityMergedIndividualCheckingSet()->init(synchData->mRemainingIndirectCompatibilityMergedIndividualCheckingSet);",
     "getRemainingIndirectCompatibilityMergedIndividualCheckingSet()->init(synchData->mRemainingIndirectCompatibilityMergedIndividualCheckingSet, mContext);"),
    ("getRoleRepresentativeNeighbourCountHash(true)->init(synchData->mRoleRepNeighbourCountHash);",
     "getRoleRepresentativeNeighbourCountHash(true)->init(synchData->mRoleRepNeighbourCountHash, mContext);"),
]


def modify(path, content):
    for old, new in OLD_NEW:
        if content.count(old) != 1:
            raise ValueError(f"{path}: expected 1 occurrence of {old!r}, found {content.count(old)}")
        content = content.replace(old, new)
    return content


if __name__ == "__main__":
    vendor = sys.argv[1]
    for f in FILES:
        p = f"{vendor}/{f}"
        s = open(p).read()
        out = modify(p, s)   # compute first: a failing modify() must not truncate the file
        open(p, "w").write(out)
