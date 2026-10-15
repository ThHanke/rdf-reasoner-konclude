"""
Patch 015 — BackendAssCache: triggerSlotGC() + null-guard in getMinimumSlotReferreringInstalledValidRecomputationId.

Two fixes for sequential materialize hang:

1. Add public triggerSlotGC() that GCs old accumulated slots between calls.
   In sync mode cleanUnusedSlots() never runs automatically between WASM calls.
   Each call's realizer Update2 writes enriched individual associations into a new slot.
   Old slots accumulate → subsequent saturation processes individuals from ALL slots → hang.

2. Null-guard in getMinimumSlotReferreringInstalledValidRecomputationId.
   Slots from prior calls with different ontology IDs return null from getOntologyData(currentId).
   Without the guard, dereferencing null → "unwind" crash at the 7th sequential call.
   The guard skips stale slots — correct behavior since they hold no data for the current ontology.
"""
import sys
from pathlib import Path

FILES = [
    "Source/Reasoner/Kernel/Cache/CBackendRepresentativeMemoryCache.h",
    "Source/Reasoner/Kernel/Cache/CBackendRepresentativeMemoryCache.cpp",
]

if "--list-files" in sys.argv:
    for f in FILES:
        print(f)
    sys.exit(0)

VENDOR_DIR = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("vendor/konclude")

# Fix 1: header — add triggerSlotGC() declaration
OLD_HEADER = "writeStringifiedRepresentativeCacheToFile();\r\n"
NEW_HEADER = "writeStringifiedRepresentativeCacheToFile();\r\n\t\t\t\t\t\tvoid triggerSlotGC();\r\n"

# Fix 1: CPP — add triggerSlotGC() implementation before cleanUnusedSlots
OLD_CPP = "\n\t\t\t\tvoid CBackendRepresentativeMemoryCache::cleanUnusedSlots("
NEW_CPP = (
    "\n\t\t\t\tvoid CBackendRepresentativeMemoryCache::triggerSlotGC() {\n"
    "\t\t\t\t\tif (!mSlotLinker || !mSlotLinker->getNext()) return;\n"
    "\t\t\t\t\tCBackendRepresentativeMemoryCacheSlotItem* head = mSlotLinker;\n"
    "\t\t\t\t\tmSlotLinker = head->getNext();\n"
    "\t\t\t\t\thead->setNext(nullptr);\n"
    "\t\t\t\t\tcleanUnusedSlots(&mContext);\n"
    "\t\t\t\t\thead->setNext(mSlotLinker);\n"
    "\t\t\t\t\tmSlotLinker = head;\n"
    "\t\t\t\t}\n"
    "\n"
    "\t\t\t\tvoid CBackendRepresentativeMemoryCache::cleanUnusedSlots("
)

# Fix 2: CPP — null-guard in getMinimumSlotReferreringInstalledValidRecomputationId
# Slots from prior calls carry different ontology IDs; getOntologyData returns null for those.
# Without the guard: null dereference crash ("unwind") at call 7+ in sequential materialize.
OLD_NULL_GUARD_LF = (
    "getOntologyData(ontologyIdentifier);\n"
    "\t\t\t\t\t\tcint64 minValidRecId = referredOntologyData->getMinimumValidRecomputationId();"
)
NEW_NULL_GUARD_LF = (
    "getOntologyData(ontologyIdentifier);\n"
    "\t\t\t\t\t\tif (!referredOntologyData) continue;\n"
    "\t\t\t\t\t\tcint64 minValidRecId = referredOntologyData->getMinimumValidRecomputationId();"
)
OLD_NULL_GUARD_CRLF = OLD_NULL_GUARD_LF.replace("\n", "\r\n")
NEW_NULL_GUARD_CRLF = NEW_NULL_GUARD_LF.replace("\n", "\r\n")


def modify(path, content):
    if path.endswith(".h"):
        assert OLD_HEADER in content, "Header anchor not found"
        content = content.replace(OLD_HEADER, NEW_HEADER, 1)
    if path.endswith(".cpp"):
        assert OLD_CPP in content, "CPP triggerSlotGC anchor not found"
        content = content.replace(OLD_CPP, NEW_CPP, 1)
        # Try LF then CRLF for the null-guard
        if OLD_NULL_GUARD_LF in content:
            content = content.replace(OLD_NULL_GUARD_LF, NEW_NULL_GUARD_LF, 1)
        elif OLD_NULL_GUARD_CRLF in content:
            content = content.replace(OLD_NULL_GUARD_CRLF, NEW_NULL_GUARD_CRLF, 1)
        else:
            assert False, "CPP null-guard anchor not found (tried LF and CRLF)"
    return content


for rel in FILES:
    p = VENDOR_DIR / rel
    content = p.read_bytes().decode("utf-8")
    p.write_bytes(modify(rel, content).encode("utf-8"))
