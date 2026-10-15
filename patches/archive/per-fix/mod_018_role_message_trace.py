import sys
from pathlib import Path

FILES = [
    "Source/Reasoner/Realizer/COptimizedRepresentativeKPSetOntologyRealizingThread.cpp",
]

if "--list-files" in sys.argv:
    for f in FILES:
        print(f)
    sys.exit(0)

# Diagnostic only (NATIVE_DEBUG_BUILD): log one line per TELLREALIZATIONMARKERCANDIDATES message
# (individual id, role tag, inversion, #deterministic and #nondeterministic candidates).
# Used to diff a good vs a bad pointer-hash seed in the native repro harness.
ANCHOR = "\t\t\t\t\t\tCXLinker<CIndividualReference>* detIndiLinker = rmcmd->getDeterministicIndividualReferenceLinker();\n"
TRACE = (
    "#ifdef NATIVE_DEBUG_BUILD\n"
    "\t\t\t\t\t\t{\n"
    "\t\t\t\t\t\t\tcint64 dN = 0, nN = 0;\n"
    "\t\t\t\t\t\t\tfor (CXLinker<CIndividualReference>* l = rmcmd->getDeterministicIndividualReferenceLinker(); l; l = l->getNext()) { ++dN; }\n"
    "\t\t\t\t\t\t\tfor (CXLinker<CIndividualReference>* l = rmcmd->getNondeterministicIndividualReferenceLinker(); l; l = l->getNext()) { ++nN; }\n"
    "\t\t\t\t\t\t\tfprintf(stderr, \"RMSG indi=%lld role=%lld inv=%d det=%lld ndet=%lld\\n\", (long long)individualReference.getIndividualID(), (long long)roleInstItem->getRole()->getRoleTag(), (int)inversed, (long long)dN, (long long)nN);\n"
    "\t\t\t\t\t\t}\n"
    "#endif // NATIVE_DEBUG_BUILD\n"
)


def modify(path, content):
    if path.endswith("COptimizedRepresentativeKPSetOntologyRealizingThread.cpp"):
        if content.count(ANCHOR) != 1:
            raise ValueError(f"{path}: expected 1 anchor, found {content.count(ANCHOR)}")
        return content.replace(ANCHOR, TRACE + ANCHOR)
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
