import sys

K = "Source/Reasoner/Kernel/Task/"
FILES = [
    K + "CSaturationTaskData.h",
    K + "CSaturationTaskData.cpp",
    K + "CConsistenceTaskData.h",
    K + "CConsistenceTaskData.cpp",
    "Source/Reasoner/Consistiser/CTotallyOntologyPrecomputationItem.cpp",
]

if "--list-files" in sys.argv:
    for f in FILES:
        print(f)
    sys.exit(0)

# Upstream (single run, process exits): overtakeData() marks the finished task chain
# "memory not releaseable" so the scheduler keeps its memory pools, and nothing ever
# releases them. In a long-lived process every call leaks ~1.7 GB (Roberts). Release the
# pools of the overtaken task chain in the destructor (only if overtaken: the owner may
# delete un-overtaken data, whose pools the scheduler still owns). The precomputation
# item additionally frees all saturation data except the last one (that one belongs to
# CPrecomputation, consistence data belongs to CConsistence).

INCLS = '#include <algorithm>\n#include <vector>\n#include "Utilities/Memory/CNewAllocationMemoryPoolProvider.h"\n\n'
RELEASE_FN = """
				// Release the pools of an overtaken task chain. Tasks live inside their own pools,
				// so first collect all pool chains, then free them.
				static void releaseTaskChainPools(const std::vector<CSatisfiableCalculationTask*>& tasks) {
					std::vector<CMemoryPool*> pools;
					for (CSatisfiableCalculationTask* task : tasks) {
						CMemoryPool* pool = task->getMemoryPools();
						if (pool && std::find(pools.begin(), pools.end(), pool) == pools.end()) {
							pools.push_back(pool);
						}
					}
					CNewAllocationMemoryPoolProvider tmpProv;
					for (CMemoryPool* pool : pools) {
						tmpProv.releaseMemoryPool(pool);
					}
				}
"""


def rep(content, old, new, path):
    if content.count(old) != 1:
        raise ValueError(f"{path}: expected 1 occurrence of {old!r}, found {content.count(old)}")
    return content.replace(old, new)


def modify(path, content):
    if path.endswith("CSaturationTaskData.h"):
        content = rep(content, "CSatisfiableCalculationTask* mSaturationTask;\n",
                      "CSatisfiableCalculationTask* mSaturationTask;\n\t\t\t\t\t\tbool mOvertaken = false;\n", path)
    elif path.endswith("CConsistenceTaskData.h"):
        content = rep(content, "CSatisfiableCalculationTask* mGraphCachedSatTask;\n",
                      "CSatisfiableCalculationTask* mGraphCachedSatTask;\n\t\t\t\t\t\tbool mOvertaken = false;\n", path)
    elif path.endswith("CSaturationTaskData.cpp"):
        content = rep(content, "namespace Konclude {\n", INCLS + "namespace Konclude {\n", path)
        content = rep(content, "namespace Task {\n",
                      "namespace Task {\n" + RELEASE_FN, path)
        content = rep(content, "CSaturationTaskData::~CSaturationTaskData() {\n",
                      """CSaturationTaskData::~CSaturationTaskData() {
					if (mOvertaken) {
						std::vector<CSatisfiableCalculationTask*> tasks;
						for (CSatisfiableCalculationTask* taskIt = mSaturationTask; taskIt; taskIt = (CSatisfiableCalculationTask*)taskIt->getParentTask()) {
							tasks.push_back(taskIt);
						}
						mSaturationTask = nullptr;
						releaseTaskChainPools(tasks);
					}
""", path)
        content = rep(content, "bool CSaturationTaskData::overtakeData() {\n",
                      "bool CSaturationTaskData::overtakeData() {\n\t\t\t\t\tmOvertaken = true;\n", path)
    elif path.endswith("CConsistenceTaskData.cpp"):
        content = rep(content, "namespace Konclude {\n", INCLS + "namespace Konclude {\n", path)
        content = rep(content, "namespace Task {\n",
                      "namespace Task {\n" + RELEASE_FN, path)
        content = rep(content, "CConsistenceTaskData::~CConsistenceTaskData() {\n",
                      """CConsistenceTaskData::~CConsistenceTaskData() {
					if (mOvertaken) {
						std::vector<CSatisfiableCalculationTask*> tasks;
						if (mDetSatTask) {
							tasks.push_back(mDetSatTask);
						}
						for (CSatisfiableCalculationTask* taskIt = mGraphCachedSatTask; taskIt; taskIt = (CSatisfiableCalculationTask*)taskIt->getParentTask()) {
							tasks.push_back(taskIt);
						}
						mDetSatTask = nullptr;
						mGraphCachedSatTask = nullptr;
						releaseTaskChainPools(tasks);
					}
""", path)
        content = rep(content, "bool CConsistenceTaskData::overtakeData() {\n",
                      "bool CConsistenceTaskData::overtakeData() {\n\t\t\t\t\tmOvertaken = true;\n", path)
    elif path.endswith("CTotallyOntologyPrecomputationItem.cpp"):
        content = rep(content, "				for (auto* item : mSatItemContainer) { delete item; }\n",
                      "				for (CSaturationData* satData : mSaturDataList) { if (satData != mLastSaturData) delete satData; }\n"
                      "				for (auto* item : mSatItemContainer) { delete item; }\n", path)
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
