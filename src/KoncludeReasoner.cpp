// KoncludeReasoner.cpp — implementation of the KoncludeReasoner Embind wrapper.
//
// Architecture:
//   - Pimpl pattern: all Konclude state lives in Impl.
//   - loadNTriples: parse NTriples string → librdf model via CRDFRedlandRaptorParser,
//     then map into OWL axioms via CConcreteOntologyRedlandTriplesDataExpressionMapper.
//   - classify: drive preprocessing + precomputation + classification through
//     CReasonerManagerThread::prepareOntology (synchronous in WASM via patch-002).
//   - getInferredNTriples: walk the CTaxonomy hierarchy nodes and emit rdfs:subClassOf triples
//     plus owl:equivalentClass for concepts sharing the same CHierarchyNode.
//   - isConsistent: query CConsistence::isOntologyConsistent().
//   - reset: destroy and recreate Impl.

#include "KoncludeReasoner.h"
#include "QtCompat.h"

#include <unordered_map>
#include <unordered_set>
#include <chrono>
#include <cstdio>

// ─── Konclude kernel headers ────────────────────────────────────────────────

// Ontology
#include "Reasoner/Ontology/CConcreteOntology.h"
#include "Reasoner/Ontology/COntologyProcessingStep.h"
#include "Reasoner/Ontology/COntologyProcessingStepRequirement.h"
#include "Reasoner/Ontology/COntologyProcessingStepVector.h"
#include "Reasoner/Ontology/COntologyProcessingStatus.h"

// Generator / Builder
#include "Reasoner/Generator/CConcreteOntologyBasementBuilder.h"
#include "Reasoner/Generator/CConcreteOntologyUpdateCollectorBuilder.h"
#include "Reasoner/Generator/CConcreteOntologyRedlandTriplesDataExpressionMapper.h"

// Parser
#include "Parser/CRDFRedlandRaptorParser.h"

// Taxonomy / Classification / Consistence
#include "Reasoner/Taxonomy/CTaxonomy.h"
#include "Reasoner/Taxonomy/CHierarchyNode.h"
#include "Reasoner/Classification/CClassification.h"
#include "Reasoner/Classification/CClassConceptClassification.h"
#include "Reasoner/Consistence/CConsistence.h"

// Processing step data
#include "Reasoner/Ontology/COntologyProcessingStepDataVector.h"
#include "Reasoner/Ontology/COntologyProcessingStepData.h"

// Config
#include "Config/CGlobalConfigurationBase.h"
#include "Config/CConfigurationGroup.h"
#include "Config/CConvertBooleanConfigType.h"
#include "Control/Command/CReasonerConfigurationGroup.h"

// Reasoner manager
#include "Reasoner/Kernel/Manager/CReasonerManagerThread.h"

// Calc environment (for STPU access in quiesce-wait)
#include "Reasoner/Kernel/Calculation/CConcurrentTaskCalculationEnvironment.h"

// Classifier
#include "Reasoner/Classifier/CClassificationManager.h"
#include "Reasoner/Classifier/CConfigDependedSubsumptionClassifierFactory.h"

// Concept name (IRI)
#include "Reasoner/Ontology/CIRIName.h"

// ─── Namespaces ──────────────────────────────────────────────────────────────

using namespace Konclude;
using namespace Konclude::Reasoner::Ontology;
using namespace Konclude::Reasoner::Kernel::Calculation;
using namespace Konclude::Reasoner::Taxonomy;
using namespace Konclude::Reasoner::Classification;
using namespace Konclude::Reasoner::Consistence;
using namespace Konclude::Reasoner::Generator;
using namespace Konclude::Reasoner::Classifier;
using namespace Konclude::Reasoner::Kernel::Manager;
using namespace Konclude::Config;
using namespace Konclude::Control::Command;
using namespace Konclude::Parser;

// Forward declaration of completeTask guard accessor (CSingleThreadTaskProcessorUnit.cpp override).
namespace Konclude { namespace Scheduler {
    class CSingleThreadTaskProcessorUnit;
    std::mutex* stpuGetCompleteTaskGuard(CSingleThreadTaskProcessorUnit* stpu);
} }
using namespace Konclude::Scheduler;

// ─── WasmReasonerManagerThread ───────────────────────────────────────────────
// Subclass that exposes classificationMan so it can be injected after init.

class WasmReasonerManagerThread : public CReasonerManagerThread {
public:
    WasmReasonerManagerThread() : CReasonerManagerThread(nullptr) {}

    void setClassificationManager(CClassificationManager* mgr) {
        classificationMan = mgr;
    }

    CSingleThreadTaskProcessorUnit* getStpu() {
        CCalculationManager* cm = getCalculationManager();
        if (!cm) return nullptr;
        auto* env = dynamic_cast<CConcurrentTaskCalculationEnvironment*>(cm->getCalculationContext());
        return env ? env->getSingleTaskProcessorUnit() : nullptr;
    }
};

// ─── Minimal CConfigurationProvider stub ─────────────────────────────────────
// CReasonerManagerThread::initializeManager needs a CConfigurationProvider.
// We supply a minimal one backed by a CGlobalConfigurationBase with an empty group.

class WasmConfigProvider : public CConfigurationProvider {
public:
    WasmConfigProvider() {
        mGroup = new CReasonerConfigurationGroup();
        mConfig = new CGlobalConfigurationBase(mGroup, 1);
        // Disable saturation-only subsumer extraction to force the full KPSet tableau classifier.
        // Without this, Roberts-family ontologies hit the saturation-only fast path which misses
        // role-subproperty+hasValue subsumptions (e.g. ForefatherOfRobert ⊑ AncestorOfRobert).
        CConfigData* d = mConfig->createAndSetConfig(
            "Konclude.Calculation.Classification.SaturationSubsumerExtraction");
        if (d) {
            CConvertBooleanConfigType* bt =
                dynamic_cast<CConvertBooleanConfigType*>(d->getConfigType());
            if (bt) bt->readFromBoolean(false);
        }
    }
    ~WasmConfigProvider() {
        delete mConfig;
        delete mGroup;
    }
    CConfigurationBase* getCurrentConfiguration() override {
        return mConfig;
    }
private:
    CReasonerConfigurationGroup* mGroup;
    CGlobalConfigurationBase*    mConfig;
};

// ─── Impl ─────────────────────────────────────────────────────────────────────

struct KoncludeReasoner::Impl {
    // Configuration infrastructure
    WasmConfigProvider*           mConfigProvider   = nullptr;
    CGlobalConfigurationBase*     mBasementConfig   = nullptr;

    // Ontology objects
    CConcreteOntology*            mOntology         = nullptr;

    // Reasoning infrastructure
    WasmReasonerManagerThread*    mReasonerManager  = nullptr;
    CClassificationManager*       mClassManager     = nullptr;

    // Result flags
    bool mClassified   = false;
    bool mLoadError    = false;

    Impl() {
        mConfigProvider = new WasmConfigProvider();

        mBasementConfig = static_cast<CGlobalConfigurationBase*>(
            mConfigProvider->getCurrentConfiguration());

        // ── Build working ontology with basement directly applied ──
        // Use self-contained constructor so getBasementOntology() == mOntology.
        // This prevents countActiveEntites() from calling referenceDataBoxes()
        // which would wipe all SubClassOf axioms added by mapTriples().
        buildFreshOntology();

        // ── Initialise the reasoner manager (synchronous in WASM via patch-002) ──
        mReasonerManager = new WasmReasonerManagerThread();
        mReasonerManager->initializeManager(mConfigProvider);

        // ── Initialise the classification manager and inject it into the reasoner ──
        CConfigDependedSubsumptionClassifierFactory* classFactory =
            new CConfigDependedSubsumptionClassifierFactory(mReasonerManager);
        mClassManager = new CClassificationManager();
        mClassManager->initializeManager(classFactory, mConfigProvider);
        // Inject the classification manager through the subclass accessor.
        mReasonerManager->setClassificationManager(mClassManager);
    }

    ~Impl() {
        delete mOntology;
        delete mReasonerManager;
        delete mClassManager;
        delete mConfigProvider;
    }

    void buildFreshOntology() {
        mOntology = new CConcreteOntology(mBasementConfig);
        CConcreteOntologyBasementBuilder* bb =
            new CConcreteOntologyBasementBuilder(mOntology);
        bb->initializeBuilding();
        bb->buildOntologyBasement();
        bb->completeBuilding();
        delete bb;
    }

    // Reset: destroy working ontology and build a fresh one.
    void reset() {
        delete mOntology;
        buildFreshOntology();
        mClassified  = false;
        mLoadError   = false;
    }
};

// ─── KoncludeReasoner public API ──────────────────────────────────────────────

KoncludeReasoner::KoncludeReasoner()
    : mImpl(new Impl())
{}

KoncludeReasoner::~KoncludeReasoner() {
    delete mImpl;
}

// loadTripleBuffer ─────────────────────────────────────────────────────────────
//
// See KoncludeReasoner.h for the wire format comment.
//
void KoncludeReasoner::loadTripleBuffer(int triplePtr, int tripleCount, int strTablePtr, int strTableLen) {
    auto t0 = std::chrono::steady_clock::now();

    if (!strTablePtr || !triplePtr) {
        fprintf(stderr, "{warn} KoncludeReasoner >> loadTripleBuffer called with null pointer\n");
        return;
    }

    // ── Decode the string table ──────────────────────────────────────────────
    // Layout: [count:u32][offset0:u32 … offsetN:u32][UTF-8 string data...]
    const uint32_t* hdr  = reinterpret_cast<const uint32_t*>(strTablePtr);
    uint32_t        count = hdr[0];

    // Pointer to the start of the string-data section (after the header).
    const char* strData = reinterpret_cast<const char*>(strTablePtr) + 4 + 4 * count;
    int strDataLen = strTableLen - 4 - static_cast<int>(4 * count);

    // Build O(1) lookup: term index → (char* start, size_t len)
    struct TermEntry { const char* ptr; size_t len; };
    std::vector<TermEntry> terms(count);
    for (uint32_t i = 0; i < count; ++i) {
        uint32_t off = hdr[1 + i];
        uint32_t end = (i + 1 < count) ? hdr[2 + i]
                                        : static_cast<uint32_t>(strDataLen);
        terms[i] = { strData + off, end - off };
    }

    // ── Build CRedlandStoredTriplesData (world / storage / model) ────────────
    // Pattern mirrors CRDFRedlandRaptorParser::getUpdatingTripleData +
    // parseTriples() in src/compat/overrides/CRDFRedlandRaptorParser.cpp.
    CConcreteOntologyUpdateCollectorBuilder* builder =
        new CConcreteOntologyUpdateCollectorBuilder(mImpl->mOntology);
    builder->initializeBuilding();

    CRedlandStoredTriplesData* tripleData = new CRedlandStoredTriplesData();
    tripleData->initTriplesData(CTRIPLES_DATA_UPDATE_TYPE::TRIPLES_DATA_ADDITION, nullptr);

    librdf_world* world = librdf_new_world();
    librdf_world_open(world);
    tripleData->setRedlandWorldData(world);

    librdf_storage* indexedStorage = librdf_new_storage(world, "hashes", NULL,
        "hash-type='memory',index-predicates='yes'");
    tripleData->setRedlandIndexedStorageData(indexedStorage);

    librdf_model* model = librdf_new_model(world, indexedStorage, NULL);
    tripleData->setRedlandIndexedModelData(model);

    if (!model) {
        delete tripleData;
        builder->completeBuilding();
        delete builder;
        mImpl->mLoadError = true;
        return;
    }

    // ── Helper: build a librdf_node* for a given uint32 intern ID ────────────
    auto makeNode = [&](uint32_t id) -> librdf_node* {
        uint32_t typeTag = id >> 30;
        uint32_t idx     = id & 0x3FFFFFFFu;
        if (idx >= count) return nullptr;

        const char* data = terms[idx].ptr;
        size_t       len  = terms[idx].len;

        if (typeTag == 0) {
            // NamedNode: string is the plain IRI
            // librdf_new_node_from_uri_string expects a null-terminated string.
            std::string iri(data, len);
            return librdf_new_node_from_uri_string(world,
                reinterpret_cast<const unsigned char*>(iri.c_str()));
        } else if (typeTag == 1) {
            // BlankNode: string is the blank-node identifier
            std::string bname(data, len);
            return librdf_new_node_from_blank_identifier(world,
                reinterpret_cast<const unsigned char*>(bname.c_str()));
        } else {
            // Literal: "value\0datatype\0language" within [data, data+len)
            // Split on null bytes.
            const char* p = data;
            const char* end = data + len;

            // value: up to first \0
            const char* valEnd = reinterpret_cast<const char*>(memchr(p, '\0', end - p));
            if (!valEnd) valEnd = end;
            std::string value(p, valEnd - p);

            // datatype: next segment
            std::string datatype;
            if (valEnd < end) {
                const char* dtStart = valEnd + 1;
                const char* dtEnd = reinterpret_cast<const char*>(memchr(dtStart, '\0', end - dtStart));
                if (!dtEnd) dtEnd = end;
                datatype = std::string(dtStart, dtEnd - dtStart);
            }

            // language: remaining segment
            std::string language;
            if (!datatype.empty() || (valEnd < end)) {
                const char* dtEnd2 = (!datatype.empty())
                    ? (valEnd + 1 + datatype.size() + 1)
                    : (valEnd + 1 + 1);
                if (dtEnd2 < end) {
                    const char* langEnd = reinterpret_cast<const char*>(memchr(dtEnd2, '\0', end - dtEnd2));
                    if (!langEnd) langEnd = end;
                    language = std::string(dtEnd2, langEnd - dtEnd2);
                }
            }

            if (!datatype.empty()) {
                librdf_uri* typeUri = librdf_new_uri(world,
                    reinterpret_cast<const unsigned char*>(datatype.c_str()));
                librdf_node* n = librdf_new_node_from_typed_literal(world,
                    reinterpret_cast<const unsigned char*>(value.c_str()),
                    language.empty() ? nullptr : language.c_str(),
                    typeUri);
                librdf_free_uri(typeUri);
                return n;
            } else {
                return librdf_new_node_from_literal(world,
                    reinterpret_cast<const unsigned char*>(value.c_str()),
                    language.empty() ? nullptr : language.c_str(),
                    0);
            }
        }
    };

    // ── Insert triples into model + CXLinker ─────────────────────────────────
    const uint32_t* triples = reinterpret_cast<const uint32_t*>(triplePtr);
    CXLinker<librdf_statement*>* statementLinker = tripleData->getRedlandStatementLinker();
    CXLinker<librdf_statement*>* lastStatementLinker = nullptr;
    if (statementLinker) {
        lastStatementLinker = statementLinker->getLastListLink();
    }

    for (int i = 0; i < tripleCount; ++i) {
        uint32_t sId = triples[i * 3 + 0];
        uint32_t pId = triples[i * 3 + 1];
        uint32_t oId = triples[i * 3 + 2];

        librdf_node* sNode = makeNode(sId);
        librdf_node* pNode = makeNode(pId);
        librdf_node* oNode = makeNode(oId);

        if (!sNode || !pNode || !oNode) {
            if (sNode) librdf_free_node(sNode);
            if (pNode) librdf_free_node(pNode);
            if (oNode) librdf_free_node(oNode);
            continue;
        }

        // librdf_new_statement_from_nodes takes ownership of sNode/pNode/oNode.
        librdf_statement* stmt = librdf_new_statement_from_nodes(world, sNode, pNode, oNode);
        if (!stmt) continue;

        if (!librdf_model_contains_statement(model, stmt)) {
            // Keep a copy in the linker (mapper walks the linker).
            librdf_statement* linkerStmt = librdf_new_statement_from_statement(stmt);
            CXLinker<librdf_statement*>* newLinker = new CXLinker<librdf_statement*>();
            newLinker->initLinker(linkerStmt, nullptr);
            if (statementLinker) {
                lastStatementLinker->setNext(newLinker);
                lastStatementLinker = newLinker;
            } else {
                statementLinker = newLinker;
                lastStatementLinker = newLinker;
            }
            librdf_model_add_statement(model, stmt);
        }
        librdf_free_statement(stmt);
    }
    tripleData->setRedlandStatementLinker(statementLinker);

    // ── Register data with the builder, then map triples → OWL axioms ────────
    // addTriplesData MUST be called before mapTriples so getLatestTriplesData(true)
    // returns this tripleData rather than null.
    builder->addTriplesData(tripleData);

    CConcreteOntologyRedlandTriplesDataExpressionMapper* mapper =
        new CConcreteOntologyRedlandTriplesDataExpressionMapper(builder);
    mapper->mapTriples(mImpl->mOntology, mImpl->mOntology->getOntologyTriplesData());
    delete mapper;

    builder->completeBuilding();
    delete builder;

    mImpl->mClassified = false;

    double loadMs = std::chrono::duration<double, std::milli>(
        std::chrono::steady_clock::now() - t0).count();
    fprintf(stderr, "{info} KoncludeReasoner >> loadTripleBuffer: %d triples in %.0f ms\n",
        tripleCount, loadMs);
}

// loadNTriples ─────────────────────────────────────────────────────────────────
//
// Pipeline:
//   1. Create a CConcreteOntologyUpdateCollectorBuilder for mOntology.
//   2. Construct CRDFRedlandRaptorParser (patched in Unit 5 to accept std::string).
//   3. Call parser->parseTriples(ntriplesData, baseUri) — fills a
//      CRedlandStoredTriplesData attached to the builder's OntologyTriplesData.
//   4. Create a CConcreteOntologyRedlandTriplesDataExpressionMapper and call
//      mapTriples() to translate the triples into OWL axioms in mOntology.
//   5. Complete the building phase.
//
void KoncludeReasoner::loadNTriples(const std::string& ntriples) {
    auto t0 = std::chrono::steady_clock::now();
    // Create an update builder that accumulates axioms into mOntology.
    CConcreteOntologyUpdateCollectorBuilder* builder =
        new CConcreteOntologyUpdateCollectorBuilder(mImpl->mOntology);
    builder->initializeBuilding();

    // Parse the NTriples data into librdf.
    // Format "ntriples" is passed to the Redland parser.
    // The parser feeds the triples data into the builder via addTriplesData().
    CRDFRedlandRaptorParser* parser = new CRDFRedlandRaptorParser(
        builder,
        CTRIPLES_DATA_UPDATE_TYPE::TRIPLES_DATA_ADDITION,
        "ntriples",
        mImpl->mBasementConfig);

    const std::string baseUri = "http://example.org/wasm-input";
    bool parseOk = parser->parseTriples(ntriples, baseUri);
    delete parser;

    if (!parseOk) {
        // Parsing failed — mark error; axioms from this call are discarded.
        mImpl->mLoadError = true;
        builder->completeBuilding();
        delete builder;
        return;
    }

    // Map the librdf triples into OWL axioms inside mOntology.
    CConcreteOntologyRedlandTriplesDataExpressionMapper* mapper =
        new CConcreteOntologyRedlandTriplesDataExpressionMapper(builder);
    mapper->mapTriples(mImpl->mOntology, mImpl->mOntology->getOntologyTriplesData());
    delete mapper;

    builder->completeBuilding();
    delete builder;

    // Mark as not yet classified (new data has been added).
    mImpl->mClassified = false;

    double loadMs = std::chrono::duration<double, std::milli>(
        std::chrono::steady_clock::now() - t0).count();
    fprintf(stderr, "{info} KoncludeReasoner >> Finished loading NTriples in %.0f ms\n", loadMs);
}

// classify ─────────────────────────────────────────────────────────────────────
//
// Drives the Konclude reasoning pipeline through CReasonerManagerThread::
// prepareOntology (blocking variant).  Under the WASM single-threaded build
// (patch-002) postEvent dispatches synchronously, so this call is blocking
// without any real thread.
//
// Requirements:
//   OPSTRIPLESMAPPING  → map any additional triples
//   OPSACTIVECOUNT     → count active entities
//   OPSBUILD           → build from axioms
//   OPSPREPROCESS      → normalise / simplify
//   OPSCONSISTENCY     → consistency check
//   OPSPRECOMPUTESATURATION → saturation
//   OPSCLASSCLASSIFY   → class hierarchy classification
//
bool KoncludeReasoner::classify() {
    if (mImpl->mLoadError) {
        return false;
    }

    auto t0 = std::chrono::steady_clock::now();

    COntologyProcessingStepVector* stepVec =
        COntologyProcessingStepVector::getProcessingStepVectorInstance();

    QList<COntologyProcessingRequirement*> reqList;

    // Build the chain of requirements.  Each step enables the next.
    auto addReq = [&](COntologyProcessingStep::PROCESSINGSTEPTYPE stepType) {
        reqList.push_back(new COntologyProcessingStepRequirement(
            stepVec->getProcessingStep(stepType),
            COntologyProcessingStatus::PSCOMPLETELYYPROCESSED,
            /*forbidden processing flags=*/ 0,
            COntologyProcessingStatus::PSSUCESSFULL,
            /*forbidden error flags=*/ 0));
    };

    addReq(COntologyProcessingStep::OPSTRIPLESMAPPING);
    addReq(COntologyProcessingStep::OPSACTIVECOUNT);
    addReq(COntologyProcessingStep::OPSBUILD);
    addReq(COntologyProcessingStep::OPSPREPROCESS);
    addReq(COntologyProcessingStep::OPSCONSISTENCY);
    addReq(COntologyProcessingStep::OPSPRECOMPUTESATURATION);
    addReq(COntologyProcessingStep::OPSCLASSCLASSIFY);

    // Blocking prepareOntology — returns once the last task callback fires.
    // mCalculationManager is set on the reasoner manager thread in threadStarted(),
    // which runs before any event is processed, so getStpu() is safe to call here
    // (after prepareOntology returns, the reasoner manager thread has definitely
    // initialized — guaranteed by the waitForCallback happens-before relationship).
    mImpl->mReasonerManager->prepareOntology(mImpl->mOntology, reqList);

    // Shut down the STPU thread before returning.
    //
    // Root cause of teardown crash: STPU is an orphaned pthread that keeps running
    // after prepareOntology() returns.  Even if its current completeTask() call has
    // finished (confirmed via the guard mutex), it may re-enter completeTask() for
    // stale events posted mid-classification, and those calls race with ~Impl().
    //
    // Fix: after the completeTask guard confirms the last invocation is done, we:
    //   1. stopProcessing()  — sets mProcessingStopped, so processingLoop() exits
    //   2. signalizeEvent()  — wakes STPU if it is blocked on mProcessingWakeUpSemaphore
    //   3. stopThread(true)  — joins the pthread (via CThread::stopThread)
    // All three methods are already public on CSingleThreadTaskProcessorUnit.
    {
        CSingleThreadTaskProcessorUnit* stpu = mImpl->mReasonerManager->getStpu();
        if (stpu) {
            // Wait for the last completeTask() to finish before stopping.
            std::mutex* guard = stpuGetCompleteTaskGuard(stpu);
            if (guard) {
                std::lock_guard<std::mutex> lk(*guard);
            }
            stpu->stopProcessing();   // sets mProcessingStopped = true
            stpu->signalizeEvent();   // releases wake-up semaphore if STPU is blocked
            stpu->stopThread(true);   // pthread_join — STPU thread is fully dead
        }
    }

    // Clean up requirement objects.
    for (auto* r : reqList) {
        delete r;
    }

    // Check whether classification actually completed.
    // CClassification::isOntologyClassified() is never set to true in this codebase,
    // so we check the processing step status directly.
    COntologyProcessingStepDataVector* stepDataVec =
        mImpl->mOntology->getProcessingSteps()->getOntologyProcessingStepDataVector();
    COntologyProcessingStepData* classifyStepData =
        stepDataVec->getProcessingStepData(COntologyProcessingStep::OPSCLASSCLASSIFY);
    bool classified = classifyStepData &&
        classifyStepData->getProcessingStatus()->hasPartialProcessingFlags(
            COntologyProcessingStatus::PSCOMPLETELYYPROCESSED);
    mImpl->mClassified = classified;

    double classifyMs = std::chrono::duration<double, std::milli>(
        std::chrono::steady_clock::now() - t0).count();
    fprintf(stderr, "{info} KoncludeReasoner >> Finished class classification in %.0f ms\n", classifyMs);

    return mImpl->mClassified;
}

// isConsistent ─────────────────────────────────────────────────────────────────

bool KoncludeReasoner::isConsistent() {
    CConsistence* cons = mImpl->mOntology->getConsistence();
    if (!cons) {
        return true;
    }
    return cons->isOntologyConsistent();
}

// ─── PairHash for unordered dedup in getInferredNTriples ─────────────────────
struct PairHash {
    std::size_t operator()(const std::pair<std::string, std::string>& p) const {
        std::size_t seed = std::hash<std::string>{}(p.first);
        seed ^= std::hash<std::string>{}(p.second) + 0x9e3779b9u + (seed << 6) + (seed >> 2);
        return seed;
    }
};

// getInferredNTriples ──────────────────────────────────────────────────────────
//
// Walk the CTaxonomy stored in the ontology (set after classification) and emit
// one rdfs:subClassOf triple per (child, parent) hierarchy node edge.
//
// Node IRIs are retrieved via CIRIName::getRecentIRIName(concept->getClassNameLinker()).
// Anonymous / built-in concepts (owl:Thing, owl:Nothing) have the empty string or
// a well-known IRI; we skip blank IRIs to keep the output clean.
//
std::string KoncludeReasoner::getInferredNTriples() {
    if (!mImpl->mClassified) {
        return "";
    }

    CTaxonomy* taxonomy = mImpl->mOntology->getConceptTaxonomy();
    if (!taxonomy) {
        return "";
    }

    // rdfs:subClassOf predicate IRI string (used for every emitted triple).
    const std::string subClassOf =
        "<http://www.w3.org/2000/01/rdf-schema#subClassOf>";

    // Helper: get IRI from a concept pointer (not the node representative).
    auto conceptIri = [](CConcept* concept) -> std::string {
        if (!concept) return "";
        QString iriQ = CIRIName::getRecentIRIName(concept->getClassNameLinker());
        return iriQ.empty() ? "" : std::string(iriQ);
    };

    static const std::string owlNothing =
        "http://www.w3.org/2002/07/owl#Nothing";

    const std::string equivClass =
        "<http://www.w3.org/2002/07/owl#equivalentClass>";

    std::string result;
    std::unordered_set<std::pair<std::string,std::string>, PairHash> emitted;

    QHash<CConcept*, CHierarchyNode*>* nodeHash = taxonomy->getConceptHierarchyNodeHash();
    if (!nodeHash) {
        return "";
    }

    // First pass: collect all named IRIs per node (for equivalence detection).
    std::unordered_map<CHierarchyNode*, std::vector<std::string>> nodeToIris;
    for (auto it = nodeHash->constBegin(), itEnd = nodeHash->constEnd(); it != itEnd; ++it) {
        CHierarchyNode* node = it.value();
        if (!node || !node->isActive()) continue;
        std::string iri = conceptIri(it.key());
        if (!iri.empty() && iri != owlNothing) {
            nodeToIris[node].push_back(iri);
        }
    }

    // Emit owl:equivalentClass for nodes with multiple named IRIs.
    // Both directions per pair so owl:equivalentClass (symmetric) is explicit.
    for (auto& [node, iris] : nodeToIris) {
        if (iris.size() < 2) continue;
        for (size_t i = 0; i < iris.size(); ++i) {
            for (size_t j = 0; j < iris.size(); ++j) {
                if (i == j) continue;
                auto key = std::make_pair(iris[i], iris[j]);
                if (!emitted.insert(key).second) continue;
                result += '<';
                result += iris[i];
                result += "> ";
                result += equivClass;
                result += " <";
                result += iris[j];
                result += "> .\n";
            }
        }
    }

    // Second pass: emit rdfs:subClassOf — one triple per taxonomy edge.
    // Iterate unique nodes (not the concept-keyed hash) and pick one
    // representative IRI per node, matching native Konclude's compact
    // taxonomy output: no cross-equivalence subClassOf materialisation.
    static const std::string owlThing =
        "http://www.w3.org/2002/07/owl#Thing";

    // Pick the canonical representative IRI for a node: the named concept
    // with the lowest concept tag (oldest/primary). This matches native
    // Konclude's representative selection — primary named classes receive
    // lower tags than derived equivalents.
    auto nodeRep = [&conceptIri](CHierarchyNode* node) -> std::string {
        if (!node) return "";
        QList<CConcept*>* list = node->getEquivalentConceptList();
        if (!list) return "";
        CConcept* best = nullptr;
        qint64 bestTag = std::numeric_limits<qint64>::max();
        for (CConcept* c : *list) {
            if (!c) continue;
            std::string iri = conceptIri(c);
            if (iri.empty()) continue;
            qint64 tag = c->getConceptTag();
            if (tag < bestTag) { bestTag = tag; best = c; }
        }
        return best ? conceptIri(best) : "";
    };

    for (auto& [node, iris] : nodeToIris) {
        std::string childIri = nodeRep(node);
        if (childIri.empty() || childIri == owlNothing || childIri == owlThing) {
            continue;
        }
        QSet<CHierarchyNode*>* parents = node->getParentNodeSet();
        if (!parents) {
            continue;
        }
        for (CHierarchyNode* parentNode : *parents) {
            // Skip stale pointers — nodes merged away during equivalence
            // detection are absent from nodeToIris (nodeHash no longer
            // maps any concept to them).
            if (nodeToIris.count(parentNode) == 0) {
                continue;
            }
            std::string parentIri = nodeRep(parentNode);
            if (parentIri.empty() || parentIri == owlNothing) {
                continue;
            }
            auto key = std::make_pair(childIri, parentIri);
            if (!emitted.insert(key).second) {
                continue;
            }
            result += '<';
            result += childIri;
            result += "> ";
            result += subClassOf;
            result += " <";
            result += parentIri;
            result += "> .\n";
        }
    }

    return result;
}

// reset ────────────────────────────────────────────────────────────────────────

void KoncludeReasoner::reset() {
    mImpl->reset();
}
