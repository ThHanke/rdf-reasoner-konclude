#include <emscripten/bind.h>
#include "KoncludeReasoner.h"

using namespace emscripten;

EMSCRIPTEN_BINDINGS(konclude) {
    class_<KoncludeReasoner>("KoncludeReasoner")
        .constructor<>()
        .function("loadNTriples",        &KoncludeReasoner::loadNTriples)
        .function("loadTripleBuffer",    &KoncludeReasoner::loadTripleBuffer)
        .function("classify",            &KoncludeReasoner::classify)
        .function("isConsistent",        &KoncludeReasoner::isConsistent)
        .function("getInferredNTriples", &KoncludeReasoner::getInferredNTriples)
        .function("reset",               &KoncludeReasoner::reset);
}
