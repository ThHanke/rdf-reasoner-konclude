// KoncludeReasoner.cpp — implementation of the KoncludeReasoner Embind wrapper.
//
// Architecture:
//   - Pimpl pattern: all Konclude state lives in Impl.
//   - loadNTriples: parse NTriples string → librdf model via CRDFRedlandRaptorParser,
//     then map into OWL axioms via CConcreteOntologyRedlandTriplesDataExpressionMapper.
//   - classify: drive preprocessing + precomputation + classification through
//     CReasonerManagerThread::prepareOntology (synchronous in WASM via patch-002).
//   - getInferredNTriples: walk the CTaxonomy hierarchy nodes and emit rdfs:subClassOf triples.
//   - isConsistent: query CConsistence::isOntologyConsistent().
//   - reset: destroy and recreate Impl.

#include "KoncludeReasoner.h"
#include "QtCompat.h"

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

// Config
#include "Config/CGlobalConfigurationBase.h"
#include "Config/CConfigurationGroup.h"

// Reasoner manager
#include "Reasoner/Kernel/Manager/CReasonerManagerThread.h"

// Classifier
#include "Reasoner/Classifier/CClassificationManager.h"
#include "Reasoner/Classifier/CConfigDependedSubsumptionClassifierFactory.h"

// Concept name (IRI)
#include "Reasoner/Ontology/CIRIName.h"

// ─── Namespaces ──────────────────────────────────────────────────────────────

using namespace Konclude;
using namespace Konclude::Reasoner::Ontology;
using namespace Konclude::Reasoner::Taxonomy;
using namespace Konclude::Reasoner::Classification;
using namespace Konclude::Reasoner::Consistence;
using namespace Konclude::Reasoner::Generator;
using namespace Konclude::Reasoner::Classifier;
using namespace Konclude::Reasoner::Kernel::Manager;
using namespace Konclude::Config;
using namespace Konclude::Parser;

// ─── WasmReasonerManagerThread ───────────────────────────────────────────────
// Subclass that exposes classificationMan so it can be injected after init.

class WasmReasonerManagerThread : public CReasonerManagerThread {
public:
    WasmReasonerManagerThread() : CReasonerManagerThread(nullptr) {}

    void setClassificationManager(CClassificationManager* mgr) {
        classificationMan = mgr;
    }
};

// ─── Minimal CConfigurationProvider stub ─────────────────────────────────────
// CReasonerManagerThread::initializeManager needs a CConfigurationProvider.
// We supply a minimal one backed by a CGlobalConfigurationBase with an empty group.

class WasmConfigProvider : public CConfigurationProvider {
public:
    WasmConfigProvider() {
        mGroup = new CConfigurationGroup();
        mConfig = new CGlobalConfigurationBase(mGroup, 1);
    }
    ~WasmConfigProvider() {
        delete mConfig;
        delete mGroup;
    }
    CConfigurationBase* getCurrentConfiguration() override {
        return mConfig;
    }
private:
    CConfigurationGroup*    mGroup;
    CGlobalConfigurationBase* mConfig;
};

// ─── Impl ─────────────────────────────────────────────────────────────────────

struct KoncludeReasoner::Impl {
    // Configuration infrastructure
    WasmConfigProvider*           mConfigProvider   = nullptr;
    CGlobalConfigurationBase*     mBasementConfig   = nullptr;

    // Ontology objects
    CConcreteOntology*            mBasementOntology = nullptr;
    CConcreteOntology*            mOntology         = nullptr;

    // Reasoning infrastructure
    WasmReasonerManagerThread*    mReasonerManager  = nullptr;
    CClassificationManager*       mClassManager     = nullptr;

    // Result flags
    bool mClassified   = false;
    bool mLoadError    = false;

    Impl() {
        mConfigProvider = new WasmConfigProvider();

        // ── Build basement ontology (owl:Thing / owl:Nothing + built-in concepts) ──
        mBasementConfig   = static_cast<CGlobalConfigurationBase*>(
            mConfigProvider->getCurrentConfiguration());

        mBasementOntology = new CConcreteOntology(mBasementConfig);
        CConcreteOntologyBasementBuilder* basementBuilder =
            new CConcreteOntologyBasementBuilder(mBasementOntology);
        basementBuilder->initializeBuilding();
        basementBuilder->buildOntologyBasement();
        basementBuilder->completeBuilding();
        delete basementBuilder;

        // ── Create fresh working ontology referencing the basement ──
        mOntology = new CConcreteOntology(mBasementOntology, mBasementConfig);

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
        delete mBasementOntology;
        // mReasonerManager owns mClassManager via factory; delete in order.
        delete mReasonerManager;
        delete mClassManager;
        delete mConfigProvider;
    }

    // Reset: destroy working ontology and build a fresh one.
    void reset() {
        delete mOntology;
        mOntology = new CConcreteOntology(mBasementOntology, mBasementConfig);
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

    // Blocking prepareOntology — synchronous in WASM (patch-002).
    mImpl->mReasonerManager->prepareOntology(mImpl->mOntology, reqList);

    // Clean up requirement objects.
    for (auto* r : reqList) {
        delete r;
    }

    // Check whether classification actually completed.
    CClassification* classif = mImpl->mOntology->getClassification();
    mImpl->mClassified = (classif != nullptr) && classif->isOntologyClassified();
    return mImpl->mClassified;
}

// isConsistent ─────────────────────────────────────────────────────────────────

bool KoncludeReasoner::isConsistent() {
    CConsistence* cons = mImpl->mOntology->getConsistence();
    if (!cons) {
        return true; // no consistency result yet — optimistically assume consistent
    }
    return cons->isOntologyConsistent();
}

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

    // Helper: get IRI string from a hierarchy node's representative concept.
    // Returns empty string for anonymous / null concepts.
    auto nodeIri = [](CHierarchyNode* node) -> std::string {
        if (!node) return "";
        CConcept* concept = node->getOneEquivalentConcept();
        if (!concept) return "";
        QString iriQ = CIRIName::getRecentIRIName(concept->getClassNameLinker());
        if (iriQ.empty()) return "";
        return std::string(iriQ);
    };

    std::string result;

    // Iterate over the concept–node mapping.
    QHash<CConcept*, CHierarchyNode*>* nodeHash = taxonomy->getConceptHierarchyNodeHash();
    if (!nodeHash) {
        return "";
    }

    for (auto& kv : *nodeHash) {
        CHierarchyNode* childNode = kv;  // QHash range-for yields values directly
        if (!childNode || !childNode->isActive()) {
            continue;
        }
        std::string childIri = nodeIri(childNode);
        if (childIri.empty()) {
            continue;
        }

        // Emit one triple for each direct parent node.
        QSet<CHierarchyNode*>* parents = childNode->getParentNodeSet();
        if (!parents) {
            continue;
        }
        for (CHierarchyNode* parentNode : *parents) {
            std::string parentIri = nodeIri(parentNode);
            if (parentIri.empty()) {
                continue;
            }
            // NTriples format: <subIRI> <predIRI> <objIRI> .
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
