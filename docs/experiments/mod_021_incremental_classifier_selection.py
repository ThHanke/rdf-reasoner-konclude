import sys

FILES = [
    "Source/Reasoner/Classifier/CConfigDependedSubsumptionClassifierFactory.cpp",
]

if "--list-files" in sys.argv:
    for f in FILES:
        print(f)
    sys.exit(0)

# The incremental KPSet classifier is only selected inside the
# AutomatedOptimizedClassifierSelection branch. The port disables that option (it forces
# the KPSet classifier), which also disabled incremental selection. Moreover the incremental
# KPSet classifier is the one that records individual-dependence tracking (needed to reuse a
# classification in a later revision), so the BASE ontology must be classified with it too.
# Rule when the option is off: ontologies without a previously classified version, and
# ABox-only revisions, use the incremental KPSet classifier; other revisions the plain one.
OLD = """				CSubsumptionClassifier *classifier = 0;
				bool automatedClassifierSelection = CConfigDataReader::readConfigBoolean(config,"Konclude.Calculation.Classification.AutomatedOptimizedClassifierSelection",true);
				if (automatedClassifierSelection) {
"""
NEW = """				CSubsumptionClassifier *classifier = 0;
				bool automatedClassifierSelection = CConfigDataReader::readConfigBoolean(config,"Konclude.Calculation.Classification.AutomatedOptimizedClassifierSelection",true);
				if (!automatedClassifierSelection) {
					bool onlyChangedABoxAxioms = ontology->getIncrementalRevisionData()->getAxiomChangeData()->hasOnlyChangedABoxAxioms();
					bool previousClassifiedOntologyVersion = ontology->getIncrementalRevisionData()->getPreviousClassesClassifiedOntology() != nullptr;
					if (!previousClassifiedOntologyVersion || onlyChangedABoxAxioms) {
						classifier = new CIncrementalKPSetClassSubsumptionClassifierThread(reasonerMan);
					}
				}
				if (automatedClassifierSelection) {
"""


def modify(path, content):
    if path.endswith("CConfigDependedSubsumptionClassifierFactory.cpp"):
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
