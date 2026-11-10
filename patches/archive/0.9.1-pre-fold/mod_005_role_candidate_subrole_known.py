import sys, os

FILES = ["Source/Reasoner/Realizer/COptimizedRepresentativeKPSetOntologyRealizingThread.cpp"]

HELPER_ANCHOR = '\t\t\tbool COptimizedRepresentativeKPSetOntologyRealizingThread::createNextRoleComplexCandidateConfirmationTest('
HELPER = "\t\t\t// A confirmation test for (a,b) on a role is redundant when a sub-role already has the pair as known\n\t\t\t// instance (sub-role det pair implies the super-role pair). Which role message of an individual test is\n\t\t\t// handled first decides whether the super-role candidate is queued as possible although the sub-role\n\t\t\t// pair is known, so without this check the number of tests depends on message order.\n\t\t\t// Known det pairs live in one of three stores (see addComplexRoleExplicitIndirectNeighbourLink): the complex role data,\n\t\t\t// the individual's direct known/possible neighbour hash, or the backend neighbour-role-set label cache.\n\t\t\tstatic bool isRolePairKnownOnItem(COptimizedRepresentativeKPSetOntologyRealizingItem* reqConfPreCompItem, COptimizedKPSetRoleInstancesItem* roleItem, bool inversion, const CRealizationIndividualInstanceItemReference& srcRef, cint64 tgtId) {\n\t\t\t\tcint64 srcId = srcRef.getIndividualID();\n\t\t\t\tCOptimizedKPSetIndividualComplexRoleData* complexData = roleItem->getIndividualIdComplexRoleData(srcId, false);\n\t\t\t\tif (complexData) {\n\t\t\t\t\tCOptimizedKPSetRoleInstancesData* instanceData = ((COptimizedKPSetIndividualComplexRoleExplicitIndirectLinksData*)complexData)->getRoleNeighbourInstanceItemData(inversion, tgtId, false);\n\t\t\t\t\tif (instanceData && instanceData->mKnownInstance) {\n\t\t\t\t\t\treturn true;\n\t\t\t\t\t}\n\t\t\t\t}\n\t\t\t\tCOptimizedKPSetIndividualItem* srcItem = (COptimizedKPSetIndividualItem*)srcRef.getRealizationInstanceItem();\n\t\t\t\tif (srcItem && srcItem->getKnownPossibleRoleNeighboursInstancesHash()->contains(roleItem)) {\n\t\t\t\t\tCOptimizedKPSetRoleNeighbourInstancesHashData& neighbourData = srcItem->getKnownPossibleRoleNeighboursInstancesHash()->operator[](roleItem);\n\t\t\t\t\tCOptimizedKPSetRoleInstancesData* instanceData = neighbourData.getRoleNeighbourInstanceItemData(inversion, tgtId, false);\n\t\t\t\t\tif (instanceData && instanceData->mKnownInstance) {\n\t\t\t\t\t\treturn true;\n\t\t\t\t\t}\n\t\t\t\t}\n\t\t\t\tCBackendRepresentativeMemoryCacheIndividualAssociationData* indiAssData = reqConfPreCompItem->getBackendAssociationCacheReader()->getIndividualAssociationData(srcId);\n\t\t\t\tif (indiAssData) {\n\t\t\t\t\tCBackendRepresentativeMemoryLabelCacheItem* combinationLabelItem = indiAssData->getLabelCacheEntry(CBackendRepresentativeMemoryLabelCacheItem::NEIGHBOUR_INSTANTIATED_ROLE_SET_COMBINATION_LABEL);\n\t\t\t\t\tCBackendRepresentativeMemoryCacheIndividualNeighbourRoleSetHash* neighbourRoleSetHash = indiAssData->getNeighbourRoleSetHash();\n\t\t\t\t\tif (combinationLabelItem && neighbourRoleSetHash) {\n\t\t\t\t\t\tCBackendRepresentativeMemoryLabelCacheItem* cacheLabelItem = neighbourRoleSetHash->getNeighbourRoleSetLabel(tgtId);\n\t\t\t\t\t\tCOptimizedKPSetRoleInstancesCombinedNeighbourRoleSetCacheLabelData* labelData = roleItem->getCombinedNeighbourCacheLabelItemDataHash(inversion)->value(combinationLabelItem);\n\t\t\t\t\t\tif (cacheLabelItem && labelData && labelData->hasKnownInstancesLabelItem(cacheLabelItem)) {\n\t\t\t\t\t\t\treturn true;\n\t\t\t\t\t\t}\n\t\t\t\t\t}\n\t\t\t\t}\n\t\t\t\treturn false;\n\t\t\t}\n\n\t\t\tstatic bool isComplexRolePairKnownBySubRole(COptimizedRepresentativeKPSetOntologyRealizingItem* reqConfPreCompItem, COptimizedKPSetRoleInstancesItem* roleInstancesItem, bool inversion, const CRealizationIndividualInstanceItemReference& item1Ref, const CRealizationIndividualInstanceItemReference& item2Ref, QSet<COptimizedKPSetRoleInstancesItem*>& visited) {\n\t\t\t\tfor (const TRoleItemInversionPair& subPair : *roleInstancesItem->getSuccessorItemList()) {\n\t\t\t\t\tCOptimizedKPSetRoleInstancesItem* subItem = subPair.first;\n\t\t\t\t\tif (!subItem || visited.contains(subItem)) {\n\t\t\t\t\t\tcontinue;\n\t\t\t\t\t}\n\t\t\t\t\tvisited.insert(subItem);\n\t\t\t\t\tbool subInversion = inversion ^ subPair.second;\n\t\t\t\t\t// parent(a,b) <=> sub(a,b) without inversion, sub(b,a) with inversion; sub(x,y) is stored either as\n\t\t\t\t\t// (x, successor y) or, when derived from the inverse marker, as (y, predecessor x)\n\t\t\t\t\tconst CRealizationIndividualInstanceItemReference& subSrcRef = subInversion ? item2Ref : item1Ref;\n\t\t\t\t\tconst CRealizationIndividualInstanceItemReference& subTgtRef = subInversion ? item1Ref : item2Ref;\n\t\t\t\t\tif (isRolePairKnownOnItem(reqConfPreCompItem, subItem, false, subSrcRef, subTgtRef.getIndividualID()) || isRolePairKnownOnItem(reqConfPreCompItem, subItem, true, subTgtRef, subSrcRef.getIndividualID())) {\n\t\t\t\t\t\treturn true;\n\t\t\t\t\t}\n\t\t\t\t\tif (isComplexRolePairKnownBySubRole(reqConfPreCompItem, subItem, subInversion, item1Ref, item2Ref, visited)) {\n\t\t\t\t\t\treturn true;\n\t\t\t\t\t}\n\t\t\t\t}\n\t\t\t\treturn false;\n\t\t\t}\n\n\n\n"

CALL_ANCHOR = '\t\t\t\tCRealizationIndividualInstanceItemReference item2Ref = candidatePair.second;\n\n\t\t\t\treqConfPreCompItem->incTestingRoleInstanceCandidatesCount();\n'
CALL_NEW = (
    "\t\t\t\tCRealizationIndividualInstanceItemReference item2Ref = candidatePair.second;\n\n"
    + '\t\t\t\t{\n\t\t\t\t\tQSet<COptimizedKPSetRoleInstancesItem*> visitedSubRoles;\n\t\t\t\t\tif (isComplexRolePairKnownBySubRole(reqConfPreCompItem, roleInstancesItem, false, item1Ref, item2Ref, visitedSubRoles)) {\n\t\t\t\t\t\tCOptimizedKPSetIndividualComplexRoleData* knownComplexData = roleInstancesItem->getIndividualIdComplexRoleData(item1Ref.getIndividualID(), true);\n\t\t\t\t\t\tCOptimizedKPSetRoleInstancesData* knownInstanceData = ((COptimizedKPSetIndividualComplexRoleExplicitIndirectLinksData*)knownComplexData)->getRoleNeighbourInstanceItemData(false, item2Ref.getIndividualID(), true);\n\t\t\t\t\t\tif (!knownInstanceData->mTestedInstance && !knownInstanceData->mTestingInstance && !knownInstanceData->mKnownInstance) {\n\t\t\t\t\t\t\tknownInstanceData->mKnownInstance = true;\n\t\t\t\t\t\t\tknownInstanceData->mTestedInstance = true;\n\t\t\t\t\t\t}\n\t\t\t\t\t\treturn false;\n\t\t\t\t\t}\n\t\t\t\t}\n\n'
    + "\t\t\t\treqConfPreCompItem->incTestingRoleInstanceCandidatesCount();\n"
)

GATE_OLD = '\t\t\t\t\t\t\t\tif (reqConfPreCompItem->hasRemainingCandidateConfirmationRoleInstanceItems()) {\n'
GATE_NEW = '\t\t\t\t\t\t\t\t// confirm possible role candidates only after all role initialization/propagation tests are done: a candidate that\n\t\t\t\t\t\t\t\t// is possible on a super role is often known on a sub-role whose initialization is still pending, and a test started\n\t\t\t\t\t\t\t\t// before that information arrives is wasted (the number of such tests depended on message order)\n\t\t\t\t\t\t\t\tif (reqConfPreCompItem->hasRemainingCandidateConfirmationRoleInstanceItems() && !reqConfPreCompItem->hasPropagatingRoleInstanceCandidates() && !reqConfPreCompItem->hasRemainingInitializingRoleInstanceItems() &&\n\t\t\t\t\t\t\t\t\t\t!reqConfPreCompItem->hasRemainingInitializingRoleInstanceIndividualItemReferences() && !reqConfPreCompItem->hasRemainingInitializingRoleSuccessorInstanceIndividualItemReferencePairs() && !reqConfPreCompItem->hasRemainingInitializingRolePredeccessorInstanceIndividualItemReferencePairs()) {\n'


def modify(rel_path, content):
    # replace on the raw text; inserted lines take the file's line ending style
    nl = "\r\n" if "\r\n" in content else "\n"
    def conv(t):
        return t.replace("\n", nl)
    for old, new in ((HELPER_ANCHOR, HELPER + HELPER_ANCHOR), (CALL_ANCHOR, CALL_NEW), (GATE_OLD, GATE_NEW)):
        o, n = conv(old), conv(new)
        assert content.count(o) == 1, (rel_path, old[:60])
        content = content.replace(o, n, 1)
    return content


if __name__ == "__main__":
    if "--list-files" in sys.argv:
        for f in FILES:
            print(f)
        sys.exit(0)
    vendor_dir = sys.argv[1]
    for rel_path in FILES:
        full = os.path.join(vendor_dir, rel_path)
        with open(full, newline="") as fh:
            content = fh.read()
        new = modify(rel_path, content)
        if new != content:
            with open(full, "w", newline="") as fh:
                fh.write(new)
