import sys
from pathlib import Path

FILES = [
    "Source/Reasoner/Realizer/COptimizedRepresentativeKPSetOntologyRealizingThread.cpp",
]

if "--list-files" in sys.argv:
    for f in FILES:
        print(f)
    sys.exit(0)

VENDOR_DIR = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("vendor/konclude")


def modify(path, content):
    OLD = (
        '->hasRealizationRolesInitialized()) {\r\n'
        '\t\t\t\t\t\t\t\t\tLOG(INFO,getDomain(),logTr("Create temporary ontology extension for role realization."),this);\r\n'
        '\t\t\t\t\t\t\t\t\tcreateTemporaryRoleRealizationOntology(reqConfPreCompItem);'
    )
    NEW = (
        '->hasRealizationRolesInitialized()) {\r\n'
        '\t\t\t\t\t\t\t\t\tLOG(INFO,getDomain(),logTr("ROLE-INIT-RESIDUALS init=%1 proc=%2 indiv=%3 conf=%4 prop=%5 testing=%6 possible=%7")\r\n'
        '\t\t\t\t\t\t\t\t\t\t.arg(reqConfPreCompItem->getInitializingRoleInstancesItemList()->size())\r\n'
        '\t\t\t\t\t\t\t\t\t\t.arg((int)reqConfPreCompItem->hasRemainingProcessingRoleInstanceItems())\r\n'
        '\t\t\t\t\t\t\t\t\t\t.arg((int)reqConfPreCompItem->hasRemainingInitializingRoleInstanceIndividualItemReferences())\r\n'
        '\t\t\t\t\t\t\t\t\t\t.arg((int)reqConfPreCompItem->hasRemainingCandidateConfirmationRoleInstanceItems())\r\n'
        '\t\t\t\t\t\t\t\t\t\t.arg((int)reqConfPreCompItem->hasPropagatingRoleInstanceCandidates())\r\n'
        '\t\t\t\t\t\t\t\t\t\t.arg((int)reqConfPreCompItem->hasTestingRoleInstanceCandidates())\r\n'
        '\t\t\t\t\t\t\t\t\t\t.arg((int)reqConfPreCompItem->hasTestingPossibleRoleInstances()),this);\r\n'
        '\t\t\t\t\t\t\t\t\tLOG(INFO,getDomain(),logTr("Create temporary ontology extension for role realization."),this);\r\n'
        '\t\t\t\t\t\t\t\t\tcreateTemporaryRoleRealizationOntology(reqConfPreCompItem);'
    )
    assert OLD in content, f"OLD pattern not found in {path}"
    return content.replace(OLD, NEW, 1)


for rel in FILES:
    p = VENDOR_DIR / rel
    content = p.read_bytes().decode("utf-8")
    result = modify(rel, content)
    p.write_bytes(result.encode("utf-8"))
