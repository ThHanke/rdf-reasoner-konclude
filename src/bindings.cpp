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
        .function("buildInferredTripleBuffer",   &KoncludeReasoner::buildInferredTripleBuffer)
        .function("getInferredTripleBufferPtr",  &KoncludeReasoner::getInferredTripleBufferPtr)
        .function("reset",                       &KoncludeReasoner::reset);
}
