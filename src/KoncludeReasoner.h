#pragma once
#include <string>

class KoncludeReasoner {
public:
    KoncludeReasoner();
    ~KoncludeReasoner();

    // loadTripleBuffer — zero-copy binary input protocol.
    //
    // Wire format (see ts/intern.ts for the JS encoder):
    //
    //   strTablePtr → [count:u32][offset0:u32 … offsetN:u32][UTF-8 strings...]
    //     offsets are byte positions within the string-data section (after the header).
    //
    //   triplePtr → [s:u32, p:u32, o:u32, …]  (tripleCount tuples, stride 12 bytes)
    //     each uint32 encodes term type in the top 2 bits (id >> 30):
    //       0 = NamedNode  → librdf_new_node_from_uri_string
    //       1 = BlankNode  → librdf_new_node_from_blank_identifier
    //       2 = Literal    → string-data entry is "value\0datatype\0language"
    //     lower 30 bits (id & 0x3FFFFFFF) = index into the offset array.
    void loadTripleBuffer(int triplePtr, int tripleCount, int strTablePtr, int strTableLen);

    // classification — TBox only (class + property hierarchy).
    bool classification();
    // realization — TBox + ABox (includes classification as prerequisite).
    bool realization();
    // consistency — check ontology consistency (call after classification).
    bool consistency();
    // processorCount — number of parallel worker threads configured.
    int processorCount();

    // Binary output protocol.
    // buildInferredTripleBuffer() assembles a combined output buffer:
    //   [strTableLen:u32][strTable][tripleBuffer]
    // Returns total byte length (0 if not classified).
    // getInferredTripleBufferPtr() returns the raw pointer into the internal
    // buffer — valid until the next call to loadTripleBuffer / reset.
    int buildInferredTripleBuffer();
    int getInferredTripleBufferPtr();

    void reset();

private:
    struct Impl;
    Impl* mImpl;
    static bool runPipeline(Impl* impl, bool includeRealization);
};
