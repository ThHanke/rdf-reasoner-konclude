#include <emscripten/bind.h>
#include "KoncludeReasoner.h"

using namespace emscripten;

EMSCRIPTEN_BINDINGS(konclude) {
    class_<KoncludeReasoner>("KoncludeReasoner")
        .constructor<>()
        .function("loadTripleBuffer",    &KoncludeReasoner::loadTripleBuffer)
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
        .function("reset",                            &KoncludeReasoner::reset);
}
