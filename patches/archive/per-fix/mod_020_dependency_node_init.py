import sys

FILES = [
    "Source/Reasoner/Kernel/Process/Dependency/CDependencyNode.cpp",
]

if "--list-files" in sys.argv:
    for f in FILES:
        print(f)
    sys.exit(0)

# Upstream: the CDependencyNode constructor leaves mDepTrackPoint (and the concept /
# individual pointers) uninitialized. Only some derived init functions assign
# mDepTrackPoint; for the others (independent base, ...) getPreviousDependencyTrackPoint()
# and hasDependencies()/getDependedBranchingTag() read garbage. Zero them in the constructor.
OLD = """						mDepNodeType = DNTUNDEFINED;
						//mAdditionalAheadDepLinker = nullptr;
"""
NEW = """						mDepNodeType = DNTUNDEFINED;
						mDepTrackPoint = nullptr;
						mConceptDescriptor = nullptr;
						mIndividualNode = nullptr;
						//mAdditionalAheadDepLinker = nullptr;
"""


def modify(path, content):
    if path.endswith("CDependencyNode.cpp"):
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
