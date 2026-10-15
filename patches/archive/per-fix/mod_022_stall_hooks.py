import sys

FILES = [
    "Source/Scheduler/CTaskProcessorThreadBase.cpp",
    "Source/Reasoner/Kernel/Manager/CReasonerManagerThread.cpp",
]

if "--list-files" in sys.argv:
    for f in FILES:
        print(f)
    sys.exit(0)

# Stall detection hooks (see src/compat/KonStall.h):
#  - every processed tableau task counts as activity
#  - the blocking prepareOntology() polls its callback in 1 s slices and gives up when nothing has
#    been busy for the stall threshold. The callback lives on the heap and is leaked on a stall:
#    a late completion must not write into a dead stack frame.
TASK_OLD = """		bool CTaskProcessorThreadBase::processTask(CTask* task) {
			mLastProcessedTask = task;"""
TASK_NEW = """		bool CTaskProcessorThreadBase::processTask(CTask* task) {
			KonStall::Scope konStallScope;
			mLastProcessedTask = task;"""

WAIT_OLD = """					CBlockingCallbackData callback;
					postEvent(new CPrepareOntologyEvent(ontology,reqList,&callback));
					callback.waitForCallback();
					return this;"""
WAIT_NEW = """					CBlockingCallbackData* callback = new CBlockingCallbackData();
					KonStall::beginWait();
					postEvent(new CPrepareOntologyEvent(ontology,reqList,callback));
					while (!callback->waitForCallback(1000)) {
						if (KonStall::stallDetected()) {
							return this; // callback intentionally leaked, see KonStall.h
						}
					}
					delete callback;
					return this;"""


def modify(path, content):
    if path.endswith("CTaskProcessorThreadBase.cpp"):
        if content.count(TASK_OLD) != 1:
            raise ValueError(f"{path}: task hook anchor not found")
        content = content.replace(TASK_OLD, TASK_NEW)
        if '#include "KonStall.h"' not in content:
            i = content.index("#include")
            content = content[:i] + '#include "KonStall.h"\n' + content[i:]
        return content
    if path.endswith("CReasonerManagerThread.cpp"):
        if content.count(WAIT_OLD) != 1:
            raise ValueError(f"{path}: wait anchor not found")
        content = content.replace(WAIT_OLD, WAIT_NEW)
        if '#include "KonStall.h"' not in content:
            i = content.index("#include")
            content = content[:i] + '#include "KonStall.h"\n' + content[i:]
        return content
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
