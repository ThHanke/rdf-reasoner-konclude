import sys
from pathlib import Path

FILES = [
    "Source/Reasoner/Realizer/COptimizedRepresentativeKPSetOntologyRealizingThread.cpp",
]

if "--list-files" in sys.argv:
    for f in FILES:
        print(f)
    sys.exit(0)


# Add fprintf after incPropagatingRoleInstanceCandidatesCount call so we can
# see every role test submission with individual pointer and running count.
# Add fprintf after decPropagatingRoleInstanceCandidatesCount so we can see
# completions.  Logs are captured by vitest via stderr redirect.
_INC_OLD = """\t\t\t\t\treqConfPreCompItem->incPropagatingRoleInstanceCandidatesCount();
\t\t\t\t\tCIndividualReference indiRef = indiRealItemRef;"""

_INC_NEW = """\t\t\t\t\treqConfPreCompItem->incPropagatingRoleInstanceCandidatesCount();
\t\t\t\t\tCIndividualReference indiRef = indiRealItemRef;
\t\t\t\t\tfprintf(stderr, "[ROLE-INC] indi=%p cnt=%lld\\n", (void*)indiRef.getIndividual(), (long long)reqConfPreCompItem->getPropagatingRoleInstanceCandidatesCount());"""

_DEC_OLD = """\t\t\t\t\t\treqConfPreCompItem->decPropagatingRoleInstanceCandidatesCount();
\t\t\t\t\t\tCRealizationIndividualInstanceItemReference individualItemReference = indiRoleCandTestItem->getInstantiatedItemReference();"""

_DEC_NEW = """\t\t\t\t\t\treqConfPreCompItem->decPropagatingRoleInstanceCandidatesCount();
\t\t\t\t\t\tfprintf(stderr, "[ROLE-DEC] cnt=%lld\\n", (long long)reqConfPreCompItem->getPropagatingRoleInstanceCandidatesCount());
\t\t\t\t\t\tCRealizationIndividualInstanceItemReference individualItemReference = indiRoleCandTestItem->getInstantiatedItemReference();"""


def modify(path, content):
    if not path.endswith("COptimizedRepresentativeKPSetOntologyRealizingThread.cpp"):
        return content
    assert _INC_OLD in content, "INC anchor not found — check indentation"
    assert _DEC_OLD in content, "DEC anchor not found — check indentation"
    content = content.replace(_INC_OLD, _INC_NEW, 1)
    content = content.replace(_DEC_OLD, _DEC_NEW, 1)
    return content


if __name__ == "__main__":
    vendor_dir = Path(sys.argv[1])
    for rel_path in FILES:
        full_path = vendor_dir / rel_path
        content = full_path.read_text(encoding="utf-8")
        modified = modify(str(full_path), content)
        if modified != content:
            full_path.write_text(modified, encoding="utf-8")
