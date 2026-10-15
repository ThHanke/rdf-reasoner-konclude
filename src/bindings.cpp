#include <emscripten/bind.h>
#include "KoncludeReasoner.h"

using namespace emscripten;

EMSCRIPTEN_BINDINGS(konclude) {
    class_<KoncludeReasoner>("KoncludeReasoner")
        .constructor<>()
        .function("syncTripleBuffer",    &KoncludeReasoner::syncTripleBuffer)
        .function("generation",          &KoncludeReasoner::generation)
        .function("lastSyncAdded",       &KoncludeReasoner::lastSyncAdded)
        .function("lastSyncRemoved",     &KoncludeReasoner::lastSyncRemoved)
        .function("tripleCount",         &KoncludeReasoner::tripleCount)
        .function("rebuildCount",        &KoncludeReasoner::rebuildCount)
        .function("classification",      &KoncludeReasoner::classification)
        .function("realization",         &KoncludeReasoner::realization)
        .function("consistency",         &KoncludeReasoner::consistency)
        .function("processorCount",      &KoncludeReasoner::processorCount)
        .function("buildInferredTripleBuffer",        &KoncludeReasoner::buildInferredTripleBuffer)
        .function("buildPropertyTripleBuffer",        &KoncludeReasoner::buildPropertyTripleBuffer)
        .function("getInferredTripleBufferPtr",        &KoncludeReasoner::getInferredTripleBufferPtr)
        .function("buildUnsatisfiableClassBuffer",    &KoncludeReasoner::buildUnsatisfiableClassBuffer)
        .function("isSubClassOf",                     &KoncludeReasoner::isSubClassOf)
        .function("isInstanceOf",                     &KoncludeReasoner::isInstanceOf)
        .function("isSatisfiableClass",               &KoncludeReasoner::isSatisfiableClass)
        .function("getSubClassJustification",         &KoncludeReasoner::getSubClassJustification)
        .function("hasNativeJustification",           &KoncludeReasoner::hasNativeJustification)
        .function("getAxiomsForConceptTag",           &KoncludeReasoner::getAxiomsForConceptTag)
        .function("getAxiomsForRoleTag",              &KoncludeReasoner::getAxiomsForRoleTag)
        .function("getJustificationByType",           &KoncludeReasoner::getJustificationByType)
        .function("hasJustificationByType",           &KoncludeReasoner::hasJustificationByType)
        .function("stalled",                          &KoncludeReasoner::stalled)
        .function("setStallThresholdMs",              &KoncludeReasoner::setStallThresholdMs)
        .function("reset",                            &KoncludeReasoner::reset);
}
