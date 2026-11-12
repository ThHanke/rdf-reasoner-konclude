#!/usr/bin/env python3
"""Patch 005: end a task after OR branching with a status flag instead of a C++ exception, on the direct rule chain.

executeORBranching() creates the branch tasks of a disjunction and then ends the current task with
`throw CCalculationStopProcessingException(true)`, caught by the only try/catch of the file in handleTask().
A PMDco classification does ~324 000 of these; one throw costs ~3 us in Node but ~78 us in Chromium (25 of the 35 CPU-s).

Only the *direct chain* is converted, where nothing executes after each call:
    handleTask -> tableauRuleProcessing -> tableauRuleChoice -> (jump table) applyORRule / applyNegORRule
    -> executeORBranching
A marker (mKonDirect, set immediately before the main-loop tableauRuleChoice call and consumed at its entry) tells the
dispatch that it is on that chain; mKonDirectOR carries "this OR rule was reached directly" down to executeORBranching,
which then sets mKonStopPending and returns. Every other path (nested immediate processing, other callers) still throws.
handleTask turns the flag into what the catch clause did (completed = true) and jumps behind the catch chain.

The source files are CRLF: read and write with newline='' and use \\r\\n in anchors.
"""
import sys

H = "Source/Reasoner/Kernel/Algorithm/CCalculationTableauCompletionTaskHandleAlgorithm.h"
C = "Source/Reasoner/Kernel/Algorithm/CCalculationTableauCompletionTaskHandleAlgorithm.cpp"

T6 = "\t" * 6
T5 = "\t" * 5
T4 = "\t" * 4
T7 = "\t" * 7
T8 = "\t" * 8
NL = "\r\n"


def sub(text, old, new, what):
    n = text.count(old)
    assert n == 1, "%s: %d matches" % (what, n)
    return text.replace(old, new, 1)


def modify_h(text):
    anchor = T6 + "bool tableauRuleProcessing(CIndividualProcessNode*& indiProcNode,CConceptProcessDescriptor*& conProcDes, CCalculationAlgorithmContextBase* calcAlgContext);" + NL
    new = (T6 + "// OR branching ends the task by flag instead of exception on the direct main-loop rule chain (see patch 005)" + NL +
           T6 + "bool mKonStopPending = false;" + NL +
           T6 + "bool mKonDirect = false;" + NL +
           T6 + "bool mKonDirectOR = false;" + NL)
    return sub(text, anchor, new + anchor, "header")


def modify_c(text):
    # 1. tableauRuleProcessing: mark the main-loop call into tableauRuleChoice
    text = sub(text,
               T5 + "tableauRuleChoice(indiProcNode,conProcDes,calcAlgContext);" + NL + NL + T5 + "return true;",
               T5 + "mKonDirect = true;   // consumed at the entry of tableauRuleChoice" + NL +
               T5 + "tableauRuleChoice(indiProcNode,conProcDes,calcAlgContext);" + NL + NL + T5 + "return true;",
               "tableauRuleProcessing call")
    # 2. tableauRuleChoice: consume the marker, mark direct OR dispatch, return right after the dispatch on a pending stop
    text = sub(text,
               T5 + "++mCurrentRecProcDepth;" + NL + NL + NL + T5 + "TableauRuleFunction func = nullptr;",
               T5 + "++mCurrentRecProcDepth;" + NL +
               T5 + "const bool konDirect = mKonDirect;" + NL +
               T5 + "mKonDirect = false;" + NL + NL + NL + T5 + "TableauRuleFunction func = nullptr;",
               "tableauRuleChoice entry")
    for neg in ("false", "true"):
        call = T7 + "(this->*func)(indiProcNode,conProcDes,%s,calcAlgContext);" % neg + NL
        new = (T7 + "const bool konSavedOR = mKonDirectOR;" + NL +
               T7 + "mKonDirectOR = konDirect && (func == &CCalculationTableauCompletionTaskHandleAlgorithm::applyORRule" +
               " || func == &CCalculationTableauCompletionTaskHandleAlgorithm::applyNegORRule);" + NL +
               call +
               T7 + "mKonDirectOR = konSavedOR;" + NL +
               T7 + "if (mKonStopPending) {" + NL +
               T8 + "return;   // the exception would have skipped mLastJumpFunc and --mCurrentRecProcDepth too" + NL +
               T7 + "}" + NL)
        text = sub(text, call, new, "dispatch " + neg)
    # 3. applyORRule: consume the direct flag at entry, hand it to executeORBranching right before the call
    text = sub(text,
               T5 + "STATINC(ORRULEAPPLICATIONCOUNT,calcAlgContext);" + NL +
               T5 + "CConceptDescriptor* conDes = conProDes->getConceptDescriptor();",
               T5 + "const bool konDirectHere = mKonDirectOR;" + NL +
               T5 + "mKonDirectOR = false;" + NL +
               T5 + "STATINC(ORRULEAPPLICATIONCOUNT,calcAlgContext);" + NL +
               T5 + "CConceptDescriptor* conDes = conProDes->getConceptDescriptor();",
               "applyORRule entry")
    text = sub(text,
               T8 + "// delaying failed, execute OR rule" + NL +
               T8 + "executeORBranching(processIndi,conProDes,negate,plannedBranchingProcessRestriction,calcAlgContext);",
               T8 + "// delaying failed, execute OR rule" + NL +
               T8 + "mKonDirectOR = konDirectHere;" + NL +
               T8 + "executeORBranching(processIndi,conProDes,negate,plannedBranchingProcessRestriction,calcAlgContext);",
               "applyORRule call")
    # 4. executeORBranching: consume at entry; flag + return instead of the stop exception
    text = sub(text,
               T5 + "++mAppliedORRuleCount;" + NL + T5 + "STATINC(OREXECUTIONCOUNT,calcAlgContext);",
               T5 + "const bool konDirectHere = mKonDirectOR;" + NL +
               T5 + "mKonDirectOR = false;" + NL +
               T5 + "++mAppliedORRuleCount;" + NL + T5 + "STATINC(OREXECUTIONCOUNT,calcAlgContext);",
               "executeORBranching entry")
    text = sub(text,
               "communicateTaskCreation(newTaskList);" + NL + NL + T7 + "throw CCalculationStopProcessingException(true);" + NL +
               T6 + "} else {" + NL + T7 + "// throw clash",
               "communicateTaskCreation(newTaskList);" + NL + NL +
               T7 + "if (konDirectHere) {" + NL +
               T8 + "mKonStopPending = true;   // handleTask() ends the task as the catch clause did" + NL +
               T8 + "return;" + NL +
               T7 + "}" + NL +
               T7 + "throw CCalculationStopProcessingException(true);" + NL +
               T6 + "} else {" + NL + T7 + "// throw clash",
               "executeORBranching throw")
    # 5. handleTask: reset before the try block, check after the main-loop call, label behind the catch chain
    text = sub(text,
               T6 + "try {" + NL + T7 + "mBackendCacheHandler->setWorkingOntology(satCalcTask->getProcessingDataBox()->getOntology());" + NL,
               T6 + "mKonStopPending = false;" + NL + T6 + "mKonDirect = false;" + NL + T6 + "mKonDirectOR = false;" + NL +
               T6 + "try {" + NL + T7 + "mBackendCacheHandler->setWorkingOntology(satCalcTask->getProcessingDataBox()->getOntology());" + NL,
               "handleTask reset")
    call = "continueProcessingIndividual = tableauRuleProcessing(indiProcNode,conProcDes,mCalcAlgContext);" + NL
    text = sub(text, call,
               "mKonStopPending = false;" + NL + T8 + "mKonDirectOR = false;" + NL + T8 + call +
               T8 + "if (mKonStopPending) {" + NL +
               T8 + "\tmKonStopPending = false;" + NL +
               T8 + "\tcompleted = true;   // what the CCalculationStopProcessingException(true) catch clause did" + NL +
               T8 + "\tgoto konStopHandled;" + NL +
               T8 + "}" + NL,
               "handleTask call")
    text = sub(text,
               T6 + "} catch (...) {" + NL + T7 + "error = true;" + NL + T7 + "errorCode = 3;" + NL + T6 + "}" + NL,
               T6 + "} catch (...) {" + NL + T7 + "error = true;" + NL + T7 + "errorCode = 3;" + NL + T6 + "}" + NL +
               T6 + "konStopHandled:;" + NL,
               "handleTask label")
    return text


def read(path):
    return open(path, encoding="utf-8", errors="surrogateescape", newline="").read()


def write(path, text):
    open(path, "w", encoding="utf-8", errors="surrogateescape", newline="").write(text)


if __name__ == "__main__":
    if sys.argv[1] == "--list-files":
        print(H)
        print(C)
    else:
        root = sys.argv[1].rstrip("/")
        for rel, fn in ((H, modify_h), (C, modify_c)):
            p = root + "/" + rel
            text = read(p)
            write(p, fn(text))
