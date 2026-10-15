import re
import sys

FILES = ["Source/Reasoner/Kernel/Cache/CBackendRepresentativeMemoryCache.cpp"]

if "--list-files" in sys.argv:
    for f in FILES:
        print(f)
    sys.exit(0)

# Association write messages carry the memory pools of the sending task handler (mMemPoolCon.takeMemoryPools()):
# the objects in them (label items etc.) are adopted by the cache, so upstream never releases them
# (the releaseTemporaryMemoryPools(memoryPools) line in the write event is commented out). They were therefore
# never freed at all: ~13 MB per Roberts realization (task pool blocks allocated in tryAssociateNodesWithBackendCache).
# Remember them per ontology identifier and release them when the final version of that ontology's cache data is evicted
# (same two points as the individual association contexts, patch 038).

HELPER = '''
				// Memory pools received with association write messages, adopted by the cache; per ontology identifier. Cache thread only.
				static std::unordered_map<cint64, CMemoryPool*> sAdoptedWritePools;
				static void releaseAdoptedWritePools(cint64 ontologyIdentifier, CMemoryPoolAllocationManager* memMan) {
					std::unordered_map<cint64, CMemoryPool*>::iterator it = sAdoptedWritePools.find(ontologyIdentifier);
					if (it != sAdoptedWritePools.end()) {
						CMemoryPool* pools = it->second;
						sAdoptedWritePools.erase(it);
						if (pools) {
							memMan->releaseTemporaryMemoryPools(pools);
						}
					}
				}

'''


def rep(content, old, new, path):
    # The vendor file mixes CRLF and LF lines: match tolerant of both, write the replacement with the matched line ending.
    pat = re.compile(re.escape(old).replace("\\\n", "\r?\n"))
    matches = pat.findall(content)
    if len(matches) != 1:
        raise ValueError(f"{path}: expected 1 occurrence of {old!r}, found {len(matches)}")
    m = pat.search(content)
    eol = "\r\n" if "\r\n" in m.group(0) else "\n"
    return content[:m.start()] + new.replace("\n", eol) + content[m.end():]


def modify(path, content):
    content = rep(content,
        "				static std::unordered_set<CBackendRepresentativeMemoryCacheOntologyData*> sFinalOntologyDataVersions;\n",
        "				static std::unordered_set<CBackendRepresentativeMemoryCacheOntologyData*> sFinalOntologyDataVersions;\n" + HELPER, path)
    content = rep(content,
        "						cint64 ontologyIdentifier = dataLinkerIt->getOntologyIdentifier();\n",
        "						cint64 ontologyIdentifier = dataLinkerIt->getOntologyIdentifier();\n						if (memoryPools) {\n							CMemoryPool*& adoptedPools = sAdoptedWritePools[ontologyIdentifier];\n							adoptedPools = memoryPools->append(adoptedPools);\n						}\n", path)
    content = rep(content,
        "											releaseAllIndividualAssociationContexts(staleData, evictMemMan);\n",
        "											releaseAllIndividualAssociationContexts(staleData, evictMemMan);\n											releaseAdoptedWritePools(staleId, evictMemMan);\n", path)
    content = rep(content,
        "										releaseAllIndividualAssociationContexts(ontologyData, memMan);\n										CBackendRepresentativeMemoryCacheOntologyContext* finalOntCtx",
        "										releaseAllIndividualAssociationContexts(ontologyData, memMan);\n										releaseAdoptedWritePools(ontologyData->getOntologyIdentifer(), memMan);\n										CBackendRepresentativeMemoryCacheOntologyContext* finalOntCtx", path)
    return content


if __name__ == "__main__":
    vendor = sys.argv[1]
    for f in FILES:
        p = f"{vendor}/{f}"
        s = open(p).read()
        out = modify(p, s)   # compute first: a failing modify() must not truncate the file
        open(p, "w").write(out)
