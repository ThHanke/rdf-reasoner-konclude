import sys

FILES = [
    "Source/Reasoner/Kernel/Manager/CRealizationManager.cpp",
]

if "--list-files" in sys.argv:
    for f in FILES:
        print(f)
    sys.exit(0)

# In this Konclude version CIncrementalKPSetOntologyConceptRealizingThread is a stub:
# its initializeIndividualProcessingKPSetsFromConsistencyData() override has the whole reuse
# body commented out and returns true without initializing any individual, so an incrementally
# realized revision comes out empty (only the taxonomy). Always use the full realizer; the
# revision still reuses precomputation and classification.
OLD = "if (previousRealizedOntologyVersion && onlyChangedABoxAxioms) {"
NEW = "if (false && previousRealizedOntologyVersion && onlyChangedABoxAxioms) {"


def modify(path, content):
    if path.endswith("CRealizationManager.cpp"):
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
