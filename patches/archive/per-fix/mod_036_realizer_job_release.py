import sys

FILES = [
    "Source/Reasoner/Realizer/COntologyRealizingItem.h",
    "Source/Reasoner/Realizer/CRealizerThread.cpp",
]

if "--list-files" in sys.argv:
    for f in FILES:
        print(f)
    sys.exit(0)

# The realizer creates one CSatisfiableCalculationJob (plus constructs and linkers) per realization test
# (processCalculationJob) and nothing ever deleted it (the classifier threads delete theirs; the realizer path
# does not): ~3300 jobs per Roberts realization. Keep the finished jobs in the realizing item and delete them
# when the item is released. Deleting right after the callback would race with the manager thread, which still
# removes its bookkeeping entries by job pointer (a new job at the same address would lose its entry).


def rep(content, old, new, path):
    if content.count(old) != 1:
        raise ValueError(f"{path}: expected 1 occurrence of {old!r}, found {content.count(old)}")
    return content.replace(old, new)


def modify(path, content):
    if path.endswith("COntologyRealizingItem.h"):
        content = rep(content,
            '#include "Reasoner/Ontology/CConcreteOntology.h"\n',
            '#include "Reasoner/Ontology/CConcreteOntology.h"\n#include "Reasoner/Query/CSatisfiableCalculationJob.h"\n#include <vector>\n', path)
        content = rep(content,
            "					virtual ~COntologyRealizingItem() {}\n",
            "					virtual ~COntologyRealizingItem() {\n						for (Konclude::Reasoner::Query::CSatisfiableCalculationJob* job : mCompletedCalculationJobs) {\n							delete job;\n						}\n					}\n\n					//! Takes over a finished calculation job; deleted together with this item\n					void addCompletedCalculationJob(Konclude::Reasoner::Query::CSatisfiableCalculationJob* job) {\n						if (job) {\n							mCompletedCalculationJobs.push_back(job);\n						}\n					}\n\n				protected:\n					std::vector<Konclude::Reasoner::Query::CSatisfiableCalculationJob*> mCompletedCalculationJobs;\n\n				public:\n", path)
        return content
    return rep(content,
        "					ontPreproItem->getRealizingTestingItemSet()->remove(testingItem);\n					realizingTested(ontPreproItem,testingItem,pcce);\n",
        "					ontPreproItem->getRealizingTestingItemSet()->remove(testingItem);\n					ontPreproItem->addCompletedCalculationJob(pcce->getSatisfiableCalculationJob());\n					realizingTested(ontPreproItem,testingItem,pcce);\n", path)


if __name__ == "__main__":
    vendor = sys.argv[1]
    for f in FILES:
        p = f"{vendor}/{f}"
        s = open(p).read()
        out = modify(p, s)   # compute first: a failing modify() must not truncate the file
        open(p, "w").write(out)
