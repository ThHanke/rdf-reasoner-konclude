"""
Patch 016 — Proper reader removal from mReaderLinker before clearRealizingItems().

Root cause of 3rd-materialize infinite-loop hang:
  createReaderSlotUpdate() iterates mReaderLinker calling updateSlot(slot) on
  each reader. clearRealizingItems() deletes COptimizedRepresentativeKPSetOntologyRealizingItem
  which owns mBackendAssocCacheReader — but never unlinks it from mReaderLinker.
  Two freed reader pointers remain in mReaderLinker across calls. On call 7,
  createReaderSlotUpdate writes to freed memory → UB → basic-precomputation-mode
  infinite loop → 120s timeout.

Fix:
  1. CBackendRepresentativeMemoryCacheReader: add releaseAllSlots() that decrements
     mUpdatedSlot and mCurrentSlot reference counts and nulls both fields.
  2. CBackendRepresentativeMemoryCache: add removeCacheReader(reader*) that calls
     releaseAllSlots() then unlinks the reader from mReaderLinker under the
     mReaderSyncMutex. Does NOT delete reader (destructor still owns memory).
  3. CRealizerThread: add releaseRealizingItemReaders(cache*) that iterates
     mOntItemHash, dynamic_cast each item to KPSet realizing item, and calls
     cache->removeCacheReader(reader) for each non-null reader. Called from
     WasmRealizationManager BEFORE clearRealizingItems() so no dangling pointers
     ever enter mReaderLinker between calls.
"""
import sys
from pathlib import Path

FILES = [
    "Source/Reasoner/Kernel/Cache/CBackendRepresentativeMemoryCacheReader.h",
    "Source/Reasoner/Kernel/Cache/CBackendRepresentativeMemoryCacheReader.cpp",
    "Source/Reasoner/Kernel/Cache/CBackendRepresentativeMemoryCache.h",
    "Source/Reasoner/Kernel/Cache/CBackendRepresentativeMemoryCache.cpp",
    "Source/Reasoner/Realizer/CRealizerThread.h",
    "Source/Reasoner/Realizer/CRealizerThread.cpp",
]

if "--list-files" in sys.argv:
    for f in FILES:
        print(f)
    sys.exit(0)

VENDOR_DIR = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("vendor/konclude")

# ── Fix 1a: CBackendRepresentativeMemoryCacheReader.h ─────────────────────────
# Add releaseAllSlots() declaration in the public section (CRLF file)
OLD_READER_H = "CBackendRepresentativeMemoryCacheReader* checkRecomputationIdUsage(cint64 recomputationId);\r\n"
NEW_READER_H = ("CBackendRepresentativeMemoryCacheReader* checkRecomputationIdUsage(cint64 recomputationId);\r\n"
                "\t\t\t\t\t\tvoid releaseAllSlots();\r\n")

# ── Fix 1b: CBackendRepresentativeMemoryCacheReader.cpp ───────────────────────
# Add releaseAllSlots() implementation after switchToUpdatedSlotItem (LF file)
OLD_READER_CPP = ("\t\t\t\t\treturn false;\r\n"
                  "\t\t\t\t}\r\n"
                  "\r\n"
                  "\r\n"
                  "\r\n"
                  "\t\t\t\tCBackendRepresentativeMemoryCacheReader* CBackendRepresentativeMemoryCacheReader::setWorkingOntology")
NEW_READER_CPP = (
    "\t\t\t\t\treturn false;\r\n"
    "\t\t\t\t}\r\n"
    "\r\n"
    "\t\t\t\tvoid CBackendRepresentativeMemoryCacheReader::releaseAllSlots() {\r\n"
    "\t\t\t\t\tCBackendRepresentativeMemoryCacheSlotItem* updSlot = mUpdatedSlot.fetchAndStoreOrdered(nullptr);\r\n"
    "\t\t\t\t\tif (updSlot) updSlot->decReader();\r\n"
    "\t\t\t\t\tif (mCurrentSlot) {\r\n"
    "\t\t\t\t\t\tmCurrentSlot->decReader();\r\n"
    "\t\t\t\t\t\tmCurrentSlot = nullptr;\r\n"
    "\t\t\t\t\t}\r\n"
    "\t\t\t\t\tmOntologyData = nullptr;\r\n"
    "\t\t\t\t}\r\n"
    "\r\n"
    "\r\n"
    "\r\n"
    "\t\t\t\tCBackendRepresentativeMemoryCacheReader* CBackendRepresentativeMemoryCacheReader::setWorkingOntology"
)

# ── Fix 2a: CBackendRepresentativeMemoryCache.h ───────────────────────────────
# Add removeCacheReader() declaration after triggerSlotGC() (mixed CRLF/LF file)
# triggerSlotGC was injected by patch-015 with LF line ending; surrounding lines use CRLF.
OLD_CACHE_H = "void triggerSlotGC();\n"
NEW_CACHE_H = ("void triggerSlotGC();\n"
               "\t\t\t\t\t\tvoid removeCacheReader(CBackendRepresentativeMemoryCacheReader* reader);\n")

# ── Fix 2b: CBackendRepresentativeMemoryCache.cpp ─────────────────────────────
# Add removeCacheReader() implementation after createCacheReader() (CRLF file)
OLD_CACHE_CPP = ("\t\t\t\t\treturn reader;\r\n"
                 "\t\t\t\t}\r\n"
                 "\r\n"
                 "\r\n"
                 "\t\t\t\tCBackendRepresentativeMemoryCacheReader* CBackendRepresentativeMemoryCache::createOntologyFixed")
NEW_CACHE_CPP = (
    "\t\t\t\t\treturn reader;\r\n"
    "\t\t\t\t}\r\n"
    "\r\n"
    "\r\n"
    "\t\t\t\tvoid CBackendRepresentativeMemoryCache::removeCacheReader(CBackendRepresentativeMemoryCacheReader* reader) {\r\n"
    "\t\t\t\t\tif (!reader) return;\r\n"
    "\t\t\t\t\treader->releaseAllSlots();\r\n"
    "\t\t\t\t\tmReaderSyncMutex.lock();\r\n"
    "\t\t\t\t\tif (mReaderLinker == reader) {\r\n"
    "\t\t\t\t\t\tmReaderLinker = reader->getNext();\r\n"
    "\t\t\t\t\t} else {\r\n"
    "\t\t\t\t\t\tfor (auto* it = mReaderLinker; it && it->getNext(); it = it->getNext()) {\r\n"
    "\t\t\t\t\t\t\tif (it->getNext() == reader) {\r\n"
    "\t\t\t\t\t\t\t\tit->setNext(reader->getNext());\r\n"
    "\t\t\t\t\t\t\t\tbreak;\r\n"
    "\t\t\t\t\t\t\t}\r\n"
    "\t\t\t\t\t\t}\r\n"
    "\t\t\t\t\t}\r\n"
    "\t\t\t\t\treader->setNext(nullptr);\r\n"
    "\t\t\t\t\tmReaderSyncMutex.unlock();\r\n"
    "\t\t\t\t}\r\n"
    "\r\n"
    "\r\n"
    "\t\t\t\tCBackendRepresentativeMemoryCacheReader* CBackendRepresentativeMemoryCache::createOntologyFixed"
)

# ── Fix 3a: CRealizerThread.h ─────────────────────────────────────────────────
# Forward declare CBackendRepresentativeMemoryCache and add releaseRealizingItemReaders()
# (LF file)
OLD_REALIZER_H_FWD = "\t\tusing namespace Kernel::Calculation;\n\n\t\tnamespace Realizer {"
NEW_REALIZER_H_FWD = ("\t\tusing namespace Kernel::Calculation;\n"
                      "\n"
                      "\t\tnamespace Kernel { namespace Cache { class CBackendRepresentativeMemoryCache; } }\n"
                      "\n"
                      "\t\tnamespace Realizer {")

OLD_REALIZER_H_DECL = "\t\t\t\t\tvirtual void clearRealizingItems();\n"
NEW_REALIZER_H_DECL = ("\t\t\t\t\tvirtual void clearRealizingItems();\n"
                       "\t\t\t\t\tvirtual void releaseRealizingItemReaders(Kernel::Cache::CBackendRepresentativeMemoryCache* cache);\n")

# ── Fix 3b: CRealizerThread.cpp ───────────────────────────────────────────────
# Add includes and releaseRealizingItemReaders() implementation (LF file)
OLD_REALIZER_CPP_INC = "#include \"CRealizerThread.h\"\n"
NEW_REALIZER_CPP_INC = ("#include \"CRealizerThread.h\"\n"
                        "#include \"COptimizedRepresentativeKPSetOntologyRealizingItem.h\"\n"
                        "#include \"../Kernel/Cache/CBackendRepresentativeMemoryCache.h\"\n")

OLD_REALIZER_CPP_IMPL = ("\t\t\tmOntItemHash.clear();\n"
                         "\t\t\t}\n"
                         "\n"
                         "\n"
                         "\t\t\tbool CRealizerThread::realize(")
NEW_REALIZER_CPP_IMPL = (
    "\t\t\tmOntItemHash.clear();\n"
    "\t\t\t}\n"
    "\n"
    "\t\t\tvoid CRealizerThread::releaseRealizingItemReaders(Kernel::Cache::CBackendRepresentativeMemoryCache* cache) {\n"
    "\t\t\t\tif (!cache) return;\n"
    "\t\t\t\tfor (auto it = mOntItemHash.begin(); it != mOntItemHash.end(); ++it) {\n"
    "\t\t\t\t\tauto* kpsItem = dynamic_cast<COptimizedRepresentativeKPSetOntologyRealizingItem*>(it.value());\n"
    "\t\t\t\t\tif (kpsItem) {\n"
    "\t\t\t\t\t\tauto* reader = kpsItem->getBackendAssociationCacheReader();\n"
    "\t\t\t\t\t\tif (reader) cache->removeCacheReader(reader);\n"
    "\t\t\t\t\t}\n"
    "\t\t\t\t}\n"
    "\t\t\t}\n"
    "\n"
    "\n"
    "\t\t\tbool CRealizerThread::realize("
)


def modify(path, content):
    if path.endswith("CBackendRepresentativeMemoryCacheReader.h"):
        assert OLD_READER_H in content, "Reader.h: checkRecomputationIdUsage anchor not found"
        content = content.replace(OLD_READER_H, NEW_READER_H, 1)

    elif path.endswith("CBackendRepresentativeMemoryCacheReader.cpp"):
        assert OLD_READER_CPP in content, "Reader.cpp: switchToUpdatedSlotItem end anchor not found"
        content = content.replace(OLD_READER_CPP, NEW_READER_CPP, 1)

    elif path.endswith("CBackendRepresentativeMemoryCache.h"):
        assert OLD_CACHE_H in content, "Cache.h: triggerSlotGC anchor not found"
        content = content.replace(OLD_CACHE_H, NEW_CACHE_H, 1)

    elif path.endswith("CBackendRepresentativeMemoryCache.cpp"):
        assert OLD_CACHE_CPP in content, "Cache.cpp: createCacheReader end anchor not found"
        content = content.replace(OLD_CACHE_CPP, NEW_CACHE_CPP, 1)

    elif path.endswith("CRealizerThread.h"):
        assert OLD_REALIZER_H_FWD in content, "CRealizerThread.h: namespace Realizer anchor not found"
        content = content.replace(OLD_REALIZER_H_FWD, NEW_REALIZER_H_FWD, 1)
        assert OLD_REALIZER_H_DECL in content, "CRealizerThread.h: clearRealizingItems anchor not found"
        content = content.replace(OLD_REALIZER_H_DECL, NEW_REALIZER_H_DECL, 1)

    elif path.endswith("CRealizerThread.cpp"):
        assert OLD_REALIZER_CPP_INC in content, "CRealizerThread.cpp: include anchor not found"
        content = content.replace(OLD_REALIZER_CPP_INC, NEW_REALIZER_CPP_INC, 1)
        assert OLD_REALIZER_CPP_IMPL in content, "CRealizerThread.cpp: clearRealizingItems impl anchor not found"
        content = content.replace(OLD_REALIZER_CPP_IMPL, NEW_REALIZER_CPP_IMPL, 1)

    return content


for rel in FILES:
    p = VENDOR_DIR / rel
    content = p.read_bytes().decode("utf-8")
    p.write_bytes(modify(rel, content).encode("utf-8"))
