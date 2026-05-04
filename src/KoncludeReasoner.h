#pragma once
#include <string>

class KoncludeReasoner {
public:
    KoncludeReasoner();
    ~KoncludeReasoner();

    void loadNTriples(const std::string& ntriples);
    bool classify();
    bool isConsistent();
    std::string getInferredNTriples();
    void reset();

private:
    struct Impl;
    Impl* mImpl;
};
