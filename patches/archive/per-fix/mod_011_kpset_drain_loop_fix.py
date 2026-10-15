import sys
from pathlib import Path

FILES = [
    "Source/Reasoner/Classifier/COptimizedKPSetClassSubsumptionClassifierThread.cpp",
]

if "--list-files" in sys.argv:
    for f in FILES:
        print(f)
    sys.exit(0)

# In flushPendingInitMessages(), the trailing drain loop (while itPoss != itPossEnd)
# incorrectly reads itDownPoss.value() (past-end iterator) instead of itPoss.value().
# This causes SIGSEGV at call 4 whenever a second realization follows a first that
# changed the class hierarchy.
OLD = "\t\t\t\t\t\t\t\t\tCOptimizedKPSetClassPossibleSubsumptionData* possData = itDownPoss.value();\n"
NEW = "\t\t\t\t\t\t\t\t\tCOptimizedKPSetClassPossibleSubsumptionData* possData = itPoss.value();\n"


def modify(path, content):
    if "COptimizedKPSetClassSubsumptionClassifierThread.cpp" in path:
        new = content.replace(OLD, NEW)
        if new == content:
            raise ValueError(f"{path}: no match for drain-loop pattern")
        return new
    return content


if __name__ == "__main__" and len(sys.argv) > 1:
    vendor_dir = Path(sys.argv[1])
    for rel_path in FILES:
        p = vendor_dir / rel_path
        content = p.read_text(encoding="utf-8")
        new_content = modify(rel_path, content)
        if new_content != content:
            p.write_text(new_content, encoding="utf-8")
            print(f"  modified: {rel_path}")
