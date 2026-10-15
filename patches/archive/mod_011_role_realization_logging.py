"""
Patch 011: Add diagnostic logging for sequential materialize hang.

Logs doCallback() generation check, propagatingRoleInstanceCandidatesCount
inc/dec, and job submission to pinpoint which phase hangs on call 3.
"""

import sys
from pathlib import Path

FILES = [
    "Source/Reasoner/Realizer/Events/CRealizingCalculatedCallbackEvent.cpp",
    "Source/Reasoner/Realizer/COptimizedRepresentativeKPSetOntologyRealizingItem.cpp",
    "Source/Reasoner/Realizer/CRealizerThread.cpp",
]

if "--list-files" in sys.argv:
    for f in FILES:
        print(f)
    sys.exit(0)


def modify(path, content):
    name = Path(path).name

    if name == "CRealizingCalculatedCallbackEvent.cpp":
        old = (
            "\t\t\t\tvoid CRealizingCalculatedCallbackEvent::doCallback() {\n"
            "\t\t\t\t\tCThread* t = mRecThread.exchange(nullptr, std::memory_order_acq_rel);\n"
            "\t\t\t\t\tif (t && mTestingItem->mGeneration == mExpectedGeneration) {\n"
            "\t\t\t\t\t\tt->postEvent(this);\n"
            "\t\t\t\t\t}\n"
            "\t\t\t\t}"
        )
        new = (
            "\t\t\t\tvoid CRealizingCalculatedCallbackEvent::doCallback() {\n"
            "\t\t\t\t\tCThread* t = mRecThread.exchange(nullptr, std::memory_order_acq_rel);\n"
            "\t\t\t\t\tbool genMatch = t && (mTestingItem->mGeneration == mExpectedGeneration);\n"
            "\t\t\t\t\tfprintf(stderr, \"[ROLE-CB] doCallback t=%p genMatch=%d testGen=%lld expected=%lld\\n\",\n"
            "\t\t\t\t\t    (void*)t, (int)genMatch,\n"
            "\t\t\t\t\t    (long long)(t ? (long long)mTestingItem->mGeneration : -1LL),\n"
            "\t\t\t\t\t    (long long)mExpectedGeneration);\n"
            "\t\t\t\t\tif (genMatch) {\n"
            "\t\t\t\t\t\tt->postEvent(this);\n"
            "\t\t\t\t\t}\n"
            "\t\t\t\t}"
        )
        if old not in content:
            raise ValueError(f"Pattern not found in {path}")
        return content.replace(old, new)

    if name == "COptimizedRepresentativeKPSetOntologyRealizingItem.cpp":
        old_inc = (
            "\t\t\tCOptimizedRepresentativeKPSetOntologyRealizingItem* COptimizedRepresentativeKPSetOntologyRealizingItem::incPropagatingRoleInstanceCandidatesCount(cint64 incCount) {\n"
            "\t\t\t\tmPropagatingRoleInstanceCandidateCount += incCount;"
        )
        new_inc = (
            "\t\t\tCOptimizedRepresentativeKPSetOntologyRealizingItem* COptimizedRepresentativeKPSetOntologyRealizingItem::incPropagatingRoleInstanceCandidatesCount(cint64 incCount) {\n"
            "\t\t\t\tmPropagatingRoleInstanceCandidateCount += incCount;\n"
            "\t\t\t\tfprintf(stderr, \"[ROLE-CB] inc propCount=%lld\\n\", (long long)mPropagatingRoleInstanceCandidateCount);"
        )
        old_dec = (
            "\t\t\tCOptimizedRepresentativeKPSetOntologyRealizingItem* COptimizedRepresentativeKPSetOntologyRealizingItem::decPropagatingRoleInstanceCandidatesCount(cint64 decCount) {\n"
            "\t\t\t\tmPropagatingRoleInstanceCandidateCount -= decCount;"
        )
        new_dec = (
            "\t\t\tCOptimizedRepresentativeKPSetOntologyRealizingItem* COptimizedRepresentativeKPSetOntologyRealizingItem::decPropagatingRoleInstanceCandidatesCount(cint64 decCount) {\n"
            "\t\t\t\tmPropagatingRoleInstanceCandidateCount -= decCount;\n"
            "\t\t\t\tfprintf(stderr, \"[ROLE-CB] dec propCount=%lld\\n\", (long long)mPropagatingRoleInstanceCandidateCount);"
        )
        if old_inc not in content:
            raise ValueError(f"inc pattern not found in {path}")
        if old_dec not in content:
            raise ValueError(f"dec pattern not found in {path}")
        result = content.replace(old_inc, new_inc)
        result = result.replace(old_dec, new_dec)
        return result

    if name == "CRealizerThread.cpp":
        old = (
            "\t\t\tCRealizerThread* CRealizerThread::processCalculationJob(CSatisfiableCalculationJob* job, COntologyRealizingItem* preCompItem, CRealizingTestingItem* preTestItem) {"
        )
        new = (
            "\t\t\tCRealizerThread* CRealizerThread::processCalculationJob(CSatisfiableCalculationJob* job, COntologyRealizingItem* preCompItem, CRealizingTestingItem* preTestItem) {\n"
            "\t\t\t\tfprintf(stderr, \"[ROLE-CB] submitJob item=%p gen=%lld\\n\", (void*)preTestItem, (long long)preTestItem->mGeneration);"
        )
        if old not in content:
            raise ValueError(f"Pattern not found in {path}")
        return content.replace(old, new)

    return content


if __name__ == "__main__":
    vendor_dir = Path(sys.argv[1])
    for rel_path in FILES:
        full_path = vendor_dir / rel_path
        content = full_path.read_text(encoding="utf-8")
        modified = modify(str(full_path), content)
        full_path.write_text(modified, encoding="utf-8")
        print(f"  Modified: {rel_path}")
