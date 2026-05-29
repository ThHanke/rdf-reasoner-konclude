// WASM override for CClassificationManager.cpp
//
// Same pthread pool exhaustion problem as CPrecomputationManager.  Each reasoning
// call creates three classifier threads (class, object-property, data-property).
// Fix: reuse a single classifier thread for each type across all calls.

#include "Reasoner/Classifier/CClassificationManager.h"
#include "Reasoner/Classifier/CSubsumptionClassifierThread.h"


namespace Konclude {

    namespace Reasoner {

        namespace Classifier {


            CClassificationManager::CClassificationManager() {
            }


            CClassificationManager::~CClassificationManager() {
                if (mClassifierFac) {
                    delete mClassifierFac;
                }
            }


            cint64 CClassificationManager::getActiveClassifierCount() {
                readWriteLock.lockForRead();
                cint64 activeCount = 0;
                foreach (CSubsumptionClassifier* classifier, mOntoClassifierSet) {
                    CSubsumptionClassifierThread* threadClassifier = dynamic_cast<CSubsumptionClassifierThread*>(classifier);
                    if (threadClassifier && threadClassifier->isClassifierActive()) {
                        ++activeCount;
                    }
                }
                readWriteLock.unlock();
                return activeCount;
            }


            CClassificationManager *CClassificationManager::initializeManager(CSubsumptionClassifierFactory *takeClassifierFactory, CConfigurationProvider *configurationProvider) {
                mClassifierFac = takeClassifierFactory;
                return this;
            }


            CSubsumptionClassifier *CClassificationManager::getClassClassifier(CConcreteOntology *ontology, CConfigurationBase *config, bool create, bool backgroundClassification) {
                // Reuse singleton class classifier — avoids pthread pool exhaustion and
                // dangling-pointer crashes (classifier registers handlers in STPU).
                readWriteLock.lockForRead();
                CSubsumptionClassifier *classifier = nullptr;
                if (!mOntoClassifierHash.isEmpty()) {
                    classifier = mOntoClassifierHash.constBegin().value();
                }
                readWriteLock.unlock();
                if (!classifier) {
                    readWriteLock.lockForWrite();
                    if (!mOntoClassifierHash.isEmpty()) {
                        classifier = mOntoClassifierHash.constBegin().value();
                    }
                    if (!classifier) {
                        classifier = mClassifierFac->createClassifier(ontology, config);
                        mOntoClassifierSet.insert(classifier);
                        mOntoClassifierHash.insert(ontology, classifier);
                    }
                    readWriteLock.unlock();
                }
                return classifier;
            }


            CClassifierStatistics *CClassificationManager::collectClassificationStatistics(CClassifierStatistics *statistics) {
                statistics->resetValues();
                readWriteLock.lockForRead();
                foreach (CSubsumptionClassifier *classifier, mOntoClassifierSet) {
                    CClassifierStatistics *classifierStatistics = classifier->getClassificationStatistics();
                    statistics->appendStatistics(classifierStatistics);
                }
                readWriteLock.unlock();
                return statistics;
            }


            QList<CSubsumptionClassifier *> CClassificationManager::getClassifierList() {
                readWriteLock.lockForRead();
                QList<CSubsumptionClassifier *> list(mOntoClassifierSet.values());
                readWriteLock.unlock();
                return list;
            }


            CClassificationProgress* CClassificationManager::getClassificationProgress() {
                CClassificationProgress newClassProg;
                readWriteLock.lockForRead();
                double percentAvg = 0;
                cint64 percentCount = 0;
                foreach (CSubsumptionClassifier *classifier, mOntoClassifierSet) {
                    CClassificationProgress* classificationProgress = classifier->getClassificationProgress();
                    if (classificationProgress) {
                        newClassProg.setTotalSatisfiable(newClassProg.getTotalSatisfiable()+classificationProgress->getTotalSatisfiable());
                        newClassProg.setClassificationCount(newClassProg.getClassificationCount()+classificationProgress->getClassificationCount());
                        newClassProg.setTestedSatisfiable(newClassProg.getTestedSatisfiable()+classificationProgress->getTestedSatisfiable());
                        newClassProg.setTestedSubsumptions(newClassProg.getTestedSubsumptions()+classificationProgress->getTestedSubsumptions());
                        newClassProg.setTotalSubsumptions(newClassProg.getTotalSubsumptions()+classificationProgress->getTotalSubsumptions());
                        newClassProg.setRemainingMilliSeconds(qMax(newClassProg.getRemainingMilliSeconds(),classificationProgress->getRemainingMilliSeconds()));
                        percentAvg += classificationProgress->getProgessPercent();
                        ++percentCount;
                    }
                }
                readWriteLock.unlock();
                if (percentCount != 0) {
                    percentAvg /= (double)percentCount;
                }
                newClassProg.setProgessPercent(percentAvg);
                mClassificationProgress = newClassProg;
                return &mClassificationProgress;
            }


            CSubsumptionClassifier* CClassificationManager::getDataPropertyClassifier(CConcreteOntology *ontology, CConfigurationBase *config) {
                // Reuse singleton data-property classifier.
                readWriteLock.lockForRead();
                CSubsumptionClassifier *classifier = nullptr;
                if (!mOntoDataPropertyClassifierHash.isEmpty()) {
                    classifier = mOntoDataPropertyClassifierHash.constBegin().value();
                }
                readWriteLock.unlock();
                if (!classifier) {
                    readWriteLock.lockForWrite();
                    if (!mOntoDataPropertyClassifierHash.isEmpty()) {
                        classifier = mOntoDataPropertyClassifierHash.constBegin().value();
                    }
                    if (!classifier) {
                        classifier = mClassifierFac->getDataPropertyClassifier(ontology, config);
                        mOntoClassifierSet.insert(classifier);
                        mOntoDataPropertyClassifierHash.insert(ontology, classifier);
                    }
                    readWriteLock.unlock();
                }
                return classifier;
            }


            CSubsumptionClassifier* CClassificationManager::getObjectPropertyClassifier(CConcreteOntology *ontology, CConfigurationBase *config) {
                // Reuse singleton object-property classifier.
                readWriteLock.lockForRead();
                CSubsumptionClassifier *classifier = nullptr;
                if (!mOntoObjectPropertyClassifierHash.isEmpty()) {
                    classifier = mOntoObjectPropertyClassifierHash.constBegin().value();
                }
                readWriteLock.unlock();
                if (!classifier) {
                    readWriteLock.lockForWrite();
                    if (!mOntoObjectPropertyClassifierHash.isEmpty()) {
                        classifier = mOntoObjectPropertyClassifierHash.constBegin().value();
                    }
                    if (!classifier) {
                        classifier = mClassifierFac->getObjectPropertyClassifier(ontology, config);
                        mOntoClassifierSet.insert(classifier);
                        mOntoObjectPropertyClassifierHash.insert(ontology, classifier);
                    }
                    readWriteLock.unlock();
                }
                return classifier;
            }

        }; // end namespace Classifier

    }; // end namespace Reasoner

}; // end namespace Konclude
