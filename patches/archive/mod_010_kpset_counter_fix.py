import sys
from pathlib import Path

FILES = [
    "Source/Reasoner/Classifier/CSubsumptionClassifierThread.cpp",
    "Source/Reasoner/Classifier/COptimizedKPSetClassSubsumptionClassifierThread.cpp",
    "Source/Reasoner/Classifier/COptimizedKPSetRoleSubsumptionClassifierThread.cpp",
]

if "--list-files" in sys.argv:
    for f in FILES:
        print(f)
    sys.exit(0)

T5 = "\t" * 5
T6 = "\t" * 6
T3 = "\t" * 3
T4 = "\t" * 4

# CSubsumptionClassifierThread.cpp: change == 0 to <= 0 + clamp in WASM branch.
# Late KPSet pthread callbacks (from previous classification) drive counter negative;
# <= 0 + clamp ensures doNextPendingTests() fires and counter never stays negative.
WASM_OLD = (
    f"{T5}currRunningTestParallelCount--;\n"
    f"#ifdef WASM_BUILD\n"
    f"{T5}if (currRunningTestParallelCount == 0) {{\n"
    f"{T6}doNextPendingTests();\n"
    f"{T5}}}\n"
    f"#else"
)

WASM_NEW = (
    f"{T5}currRunningTestParallelCount--;\n"
    f"#ifdef WASM_BUILD\n"
    f"{T5}if (currRunningTestParallelCount <= 0) {{\n"
    f"{T6}currRunningTestParallelCount = 0;\n"
    f"{T6}doNextPendingTests();\n"
    f"{T5}}}\n"
    f"#else"
)

# KPSet class classifier: reset counter at start of scheduleOntologyClassification.
# Subclass overrides base class method without calling it, so currRunningTestParallelCount
# is never reset between calls. Late pthread callbacks from call N decrement it below zero,
# making call N+1's classification never reach the == 0 trigger -> hang.
CLASS_OLD = (
    f"{T3}CSubsumptionClassifierThread *COptimizedKPSetClassSubsumptionClassifierThread::scheduleOntologyClassification(CConcreteOntology *ontology, CClassificationCalculationSupport *classificationSupport, CConfigurationBase *config) {{\n"
    f"\n"
    f"\n"
    f"{T4}CTaxonomy *taxonomy"
)

CLASS_NEW = (
    f"{T3}CSubsumptionClassifierThread *COptimizedKPSetClassSubsumptionClassifierThread::scheduleOntologyClassification(CConcreteOntology *ontology, CClassificationCalculationSupport *classificationSupport, CConfigurationBase *config) {{\n"
    f"\n"
    f"{T4}currRunningTestParallelCount = 0;\n"
    f"\n"
    f"{T4}CTaxonomy *taxonomy"
)

# KPSet role classifier: same fix
ROLE_OLD = (
    f"{T3}CSubsumptionClassifierThread *COptimizedKPSetRoleSubsumptionClassifierThread::scheduleOntologyClassification(CConcreteOntology *ontology, CClassificationCalculationSupport *classificationSupport, CConfigurationBase *config) {{\n"
    f"\n"
    f"\n"
    f"{T4}CRolePropertiesHierarchy* hierarchy"
)

ROLE_NEW = (
    f"{T3}CSubsumptionClassifierThread *COptimizedKPSetRoleSubsumptionClassifierThread::scheduleOntologyClassification(CConcreteOntology *ontology, CClassificationCalculationSupport *classificationSupport, CConfigurationBase *config) {{\n"
    f"\n"
    f"{T4}currRunningTestParallelCount = 0;\n"
    f"\n"
    f"{T4}CRolePropertiesHierarchy* hierarchy"
)


def modify(path, content):
    if "CSubsumptionClassifierThread.cpp" in path:
        new = content.replace(WASM_OLD, WASM_NEW)
        if new == content:
            raise ValueError(f"{path}: no match for WASM_OLD")
        return new
    if "COptimizedKPSetClassSubsumptionClassifierThread.cpp" in path:
        new = content.replace(CLASS_OLD, CLASS_NEW)
        if new == content:
            raise ValueError(f"{path}: no match for CLASS_OLD")
        return new
    if "COptimizedKPSetRoleSubsumptionClassifierThread.cpp" in path:
        new = content.replace(ROLE_OLD, ROLE_NEW)
        if new == content:
            raise ValueError(f"{path}: no match for ROLE_OLD")
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
