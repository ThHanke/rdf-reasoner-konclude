import sys

FILES = [
    "Source/Reasoner/Realizer/COptimizedRepresentativeKPSetOntologyRealizingThread.cpp",
]

if "--list-files" in sys.argv:
    for f in FILES:
        print(f)
    sys.exit(0)

# Upstream bug in prepareRoleInitializingTestData (direct-collectable only-transitive roles): the
# links of the transitive sub-role item are collected for orientation `subRoleItemInversed`
# (= pair.second ^ inversed), but then copied from the sub-role's neighbour hash of orientation
# `inversed`. They differ whenever the sub-role item is the inverse representative of its
# role pair (e.g. hasForeFather vs isForefatherOf), which depends on tag/address order, so the
# derived super-role links (hasAncestor via transitive hasForeFather) were randomly empty.
OLD = "indiExplicitIndirectLinkComplexSubRoleRepresentationData->getRoleNeighbourInstancesHash(inversed, true);"
NEW = "indiExplicitIndirectLinkComplexSubRoleRepresentationData->getRoleNeighbourInstancesHash(subRoleItemInversed, true);"


def modify(path, content):
    if path.endswith("COptimizedRepresentativeKPSetOntologyRealizingThread.cpp"):
        if content.count(OLD) != 1:
            raise ValueError(f"{path}: expected 1 occurrence, found {content.count(OLD)}")
        return content.replace(OLD, NEW)
    return content


if __name__ == "__main__" and len(sys.argv) > 1:
    from pathlib import Path
    vendor_dir = Path(sys.argv[1])
    for rel_path in FILES:
        p = vendor_dir / rel_path
        content = p.read_text(encoding="utf-8")
        new_content = modify(rel_path, content)
        if new_content != content:
            p.write_text(new_content, encoding="utf-8")
            print(f"  modified: {rel_path}")
