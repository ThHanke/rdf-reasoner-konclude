import sys
from pathlib import Path

FILES = [
    "Source/Reasoner/Realizer/COptimizedRepresentativeKPSetOntologyRealizingThread.cpp",
    "Source/Reasoner/Realizer/COptimizedKPSetRoleInstancesItem.cpp",
]

if "--list-files" in sys.argv:
    for f in FILES:
        print(f)
    sys.exit(0)

# Root cause of the non-deterministic loss of role assertions (e.g. Roberts isRelationOf):
# complex role candidates (links found by candidate-initialization that still need a confirmation
# test) are only created AFTER the role item was marked for role realization. The role item is
# queued for confirmation exactly once, at marking time, and only if it already has candidates
# then. Candidates arriving later are never queued; the realizer runs out of work, the step
# completes, and the unconfirmed links (mKnownInstance == false) are silently dropped by the
# readout. Whether candidates exist at marking time depends on processing order, hence on
# container iteration order (pointer hashes).
#
# Fix: (1) queue the role item whenever a new complex candidate is added to an item that is
# already marked for processing; (2) reset the queued flag when the item is dequeued so it can
# be queued again; (3) takeNextTestingComplexInstanceCandidate() checked hasPossibleInstances()
# (the other, simple candidate set) instead of hasComplexInstanceCandidates() and returned an
# empty pair without consuming anything.

T_OLD1 = ("\t\t\t\t\tif (wasAlreadyPossibleMarked && instanceData->mKnownInstance) {\n"
          "\t\t\t\t\t\t// remove from testing queue\n")
T_NEW1 = ("\t\t\t\t\tif (!instanceData->mKnownInstance && roleInstItem->hasToProcessPossibleInstancesFlag()) {\n"
          "\t\t\t\t\t\t// late candidate: make sure the (already marked) role item is queued for confirmation\n"
          "\t\t\t\t\t\trealItem->addRoleInstanceItemToProcessComplexCandidateInstances(roleInstItem);\n"
          "\t\t\t\t\t}\n") + T_OLD1

T_OLD2 = ("\t\t\t\t\t\t\t\t\t\tif (!nextCandidateConfirmationRoleItem->hasComplexInstanceCandidates()) {\n"
          "\t\t\t\t\t\t\t\t\t\t\tcandidateConfirmationRoleInstancesItemList->removeFirst();\n")
T_NEW2 = ("\t\t\t\t\t\t\t\t\t\tif (!nextCandidateConfirmationRoleItem->hasComplexInstanceCandidates()) {\n"
          "\t\t\t\t\t\t\t\t\t\t\tnextCandidateConfirmationRoleItem->setComplexCandidateProcessingQueuedFlag(false);\n"
          "\t\t\t\t\t\t\t\t\t\t\tcandidateConfirmationRoleInstancesItemList->removeFirst();\n")

I_OLD = ("\t\t\t\tCOptimizedKPSetIndividualItemReferencePair nextItem = COptimizedKPSetIndividualItemReferencePair(CRealizationIndividualInstanceItemReference(), CRealizationIndividualInstanceItemReference());\n"
         "\t\t\t\tif (hasPossibleInstances()) {\n"
         "\t\t\t\t\tQSet<COptimizedKPSetIndividualItemReferencePair>::iterator it = mComplexRoleCandidateInstancesSet.begin();")
I_NEW = I_OLD.replace("if (hasPossibleInstances()) {", "if (hasComplexInstanceCandidates()) {")


def modify(path, content):
    if path.endswith("COptimizedRepresentativeKPSetOntologyRealizingThread.cpp"):
        for old, new in ((T_OLD1, T_NEW1), (T_OLD2, T_NEW2)):
            if content.count(old) != 1:
                raise ValueError(f"{path}: expected 1 match, found {content.count(old)} for {old[:60]!r}")
            content = content.replace(old, new)
        return content
    if path.endswith("COptimizedKPSetRoleInstancesItem.cpp"):
        if content.count(I_OLD) != 1:
            raise ValueError(f"{path}: expected 1 match for take-next guard, found {content.count(I_OLD)}")
        return content.replace(I_OLD, I_NEW)
    return content


if __name__ == "__main__" and len(sys.argv) > 1 and not sys.argv[1].startswith("--"):
    vendor_dir = Path(sys.argv[1])
    for rel_path in FILES:
        p = vendor_dir / rel_path
        content = p.read_text(encoding="utf-8")
        new_content = modify(rel_path, content)
        if new_content != content:
            p.write_text(new_content, encoding="utf-8")
            print(f"  modified: {rel_path}")
