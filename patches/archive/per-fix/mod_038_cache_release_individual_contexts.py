import sys

FILES = ["Source/Reasoner/Kernel/Cache/CBackendRepresentativeMemoryCache.cpp"]

if "--list-files" in sys.argv:
    for f in FILES:
        print(f)
    sys.exit(0)

# Evicting the final version of a per-call OntologyData released only its OntologyContext / temporary pools. The
# individual association memory contexts (own pool containers: the per-individual association data written by
# processCustomsEvents) that the final version still references, plus any still queued for release, were never
# released: ~24 MB of cache pools per Roberts realization stayed allocated for the whole process (found with the
# pool-site registry, patch 037). Release them when the data is evicted for good (no newer version of the same
# ontology identifier exists). Older versions of the same identifier share contexts with their successor: untouched.

HELPER = '''
				// Versions evicted for good (no newer version of their ontology identifier) that were still referenced by a reader slot
				// and are released later by cleanUnusedSlots. Cache thread only.
				static std::unordered_set<CBackendRepresentativeMemoryCacheOntologyData*> sFinalOntologyDataVersions;

				static void releaseAllIndividualAssociationContexts(CBackendRepresentativeMemoryCacheOntologyData* ontologyData, CMemoryPoolAllocationManager* memMan) {
					std::unordered_set<CBackendRepresentativeMemoryCacheIndividualAssociationContext*> contexts;
					CBackendRepresentativeMemoryCacheIndividualAssociationData** vec = ontologyData->getIndividualIdAssoiationDataVector();
					cint64 vecSize = ontologyData->getIndividualIdAssoiationDataVectorSize();
					if (vec) {
						for (cint64 i = 0; i < vecSize; ++i) {
							if (vec[i]) {
								CBackendRepresentativeMemoryCacheIndividualAssociationContext* ctx = vec[i]->getIndividualAssociationMemoryContext();
								if (ctx) {
									contexts.insert(ctx);
								}
							}
						}
					}
					for (CBackendRepresentativeMemoryCacheIndividualAssociationContext* it = ontologyData->getReleaseQueuedIndividualAssociationContextLinker(); it; it = it->getNext()) {
						contexts.insert(it);
					}
					CCACHINGMAP<cint64, CBackendRepresentativeMemoryCacheIndividualAssociationContext*>* releasingMap = ontologyData->getRecomputationIdReleasingIndividualAssociationContextMap();
					if (releasingMap) {
						for (CCACHINGMAP<cint64, CBackendRepresentativeMemoryCacheIndividualAssociationContext*>::const_iterator it = releasingMap->constBegin(), itEnd = releasingMap->constEnd(); it != itEnd; ++it) {
							for (CBackendRepresentativeMemoryCacheIndividualAssociationContext* l = it.value(); l; l = l->getNext()) {
								contexts.insert(l);
							}
						}
					}
					std::unordered_set<CMemoryPool*> poolLists;
					for (CBackendRepresentativeMemoryCacheIndividualAssociationContext* ctx : contexts) {
						CMemoryPool* pools = ctx->getMemoryPoolContainer()->getMemoryPools();
						if (pools) {
							poolLists.insert(pools);
						}
					}
					for (CMemoryPool* pools : poolLists) {
						memMan->releaseTemporaryMemoryPools(pools);
					}
				}

'''


def rep(content, old, new, path):
    # The vendor file mixes CRLF and LF lines: match tolerant of both and write the replacement with the
    # line ending of the matched text.
    import re
    pat = re.compile(re.escape(old).replace("\\\n", "\r?\n"))
    matches = pat.findall(content)
    if len(matches) != 1:
        raise ValueError(f"{path}: expected 1 occurrence of {old!r}, found {len(matches)}")
    m = pat.search(content)
    eol = "\r\n" if "\r\n" in m.group(0) else "\n"
    return content[:m.start()] + new.replace("\n", eol) + content[m.end():]


def modify(path, content):
    anchor = "				void CBackendRepresentativeMemoryCache::deleteExpiredIndividualAssociationMemoryContexts("
    content = rep(content, anchor, HELPER + anchor, path)
    content = rep(content,
        "											CBackendRepresentativeMemoryCacheOntologyContext* staleOntCtx = staleData->getOntologyContext();\n",
        "											releaseAllIndividualAssociationContexts(staleData, evictMemMan);\n											CBackendRepresentativeMemoryCacheOntologyContext* staleOntCtx = staleData->getOntologyContext();\n", path)
    content = rep(content,
        "									ontologyData->getRecomputationReferenceLinker()->setOntologyDataInactive();\n\n									CMemoryPool* memoryPools = ontologyData->getTemporaryContext()->getMemoryPoolContainer()->getMemoryPools();\n",
        "									ontologyData->getRecomputationReferenceLinker()->setOntologyDataInactive();\n\n									if (sFinalOntologyDataVersions.erase(ontologyData) > 0) {\n										releaseAllIndividualAssociationContexts(ontologyData, memMan);\n										CBackendRepresentativeMemoryCacheOntologyContext* finalOntCtx = ontologyData->getOntologyContext();\n										if (finalOntCtx) {\n											CMemoryPool* finalOntCtxPools = finalOntCtx->getMemoryPoolContainer()->getMemoryPools();\n											if (finalOntCtxPools) {\n												memMan->releaseTemporaryMemoryPools(finalOntCtxPools);\n											}\n											delete finalOntCtx;\n										}\n									}\n									CMemoryPool* memoryPools = ontologyData->getTemporaryContext()->getMemoryPoolContainer()->getMemoryPools();\n", path)
    content = rep(content,
        "											KonPoolStats::gOntDataFreed.fetch_add(1, std::memory_order_relaxed);\n											delete staleData;\n",
        "											KonPoolStats::gOntDataFreed.fetch_add(1, std::memory_order_relaxed);\n											delete staleData;\n											evictMemMan->flushFreePools();\n", path)
    content = rep(content,
        "											KonPoolStats::gOntDataStaleKept.fetch_add(1, std::memory_order_relaxed);\n",
        "											KonPoolStats::gOntDataStaleKept.fetch_add(1, std::memory_order_relaxed);\n											sFinalOntologyDataVersions.insert(staleData);\n", path)
    if "#include <unordered_set>" not in content:
        content = content.replace('#include "CBackendRepresentativeMemoryCache.h"\n', '#include "CBackendRepresentativeMemoryCache.h"\n#include <unordered_set>\n', 1)
    return content


if __name__ == "__main__":
    vendor = sys.argv[1]
    for f in FILES:
        p = f"{vendor}/{f}"
        s = open(p).read()
        out = modify(p, s)   # compute first: a failing modify() must not truncate the file
        open(p, "w").write(out)
