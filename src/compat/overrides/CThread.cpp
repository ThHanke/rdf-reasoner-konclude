/*
 *		Copyright (C) 2013-2015, 2019 by the Konclude Developer Team.
 *		LGPLv3 — see vendor/konclude/ for full license text.
 *
 *		WASM override: replaces vendor/konclude/Source/Concurrent/CThread.cpp.
 *		Each CThread gets a real pthread_t with per-thread mutex/condvar event
 *		queue.  postEvent is non-blocking; run() is the blocking event loop.
 *		State is stored in a static map so CThread.h needs no modification.
 */
#include <deque>
#include <functional>
#include <unordered_map>
#include <pthread.h>
#include <thread>
#include "Concurrent/CThread.h"
#include "Concurrent/Events/CRequestFeedbackEvent.h"
#include "Logger/CLogger.h"

namespace {
    struct PthreadState {
        pthread_t        thread{};
        pthread_mutex_t  queueMutex;
        pthread_cond_t   queueCond;
        std::deque<QEvent*> eventQueue;
        bool shouldStop = false;
        bool running    = false;
        bool started    = false;

        PthreadState() {
            pthread_mutex_init(&queueMutex, nullptr);
            pthread_cond_init(&queueCond, nullptr);
        }
        ~PthreadState() {
            pthread_mutex_destroy(&queueMutex);
            pthread_cond_destroy(&queueCond);
        }
    };

    static std::unordered_map<void*, PthreadState*> sThreadStates;
    static pthread_mutex_t sMapMutex = PTHREAD_MUTEX_INITIALIZER;

    static PthreadState* getState(void* key) {
        pthread_mutex_lock(&sMapMutex);
        auto it = sThreadStates.find(key);
        PthreadState* s = (it != sThreadStates.end()) ? it->second : nullptr;
        pthread_mutex_unlock(&sMapMutex);
        return s;
    }

    static PthreadState* getOrCreateState(void* key) {
        pthread_mutex_lock(&sMapMutex);
        PthreadState*& s = sThreadStates[key];
        if (!s) s = new PthreadState();
        pthread_mutex_unlock(&sMapMutex);
        return s;
    }
}

namespace Konclude {
    namespace Concurrent {

        qint64 CThread::nextThreadID = 1;

        CThread::CThread(QString threadIdentifierName, CWatchDog *watchDogThread) {
            threadName = threadIdentifierName;
            waitTimeSecs = 0;
            blockTimeSecs = 0;
            runTimeSecs = 0;
            threadID = 0;
            mWatchDog = watchDogThread;
            threadRuns = false;
            mActiveEventProcessing = false;
        }

        CThread::~CThread() {
            stopThread(true);
            pthread_mutex_lock(&sMapMutex);
            auto it = sThreadStates.find(this);
            if (it != sThreadStates.end()) {
                PthreadState* s = it->second;
                pthread_mutex_destroy(&s->queueMutex);
                pthread_cond_destroy(&s->queueCond);
                for (QEvent* ev : s->eventQueue) delete ev;
                delete s;
                sThreadStates.erase(it);
            }
            pthread_mutex_unlock(&sMapMutex);
        }

        void CThread::setTaskDescription(QString description) {
            lastTaskDescription = taskDescription;
            taskDescription = description;
        }

        QString CThread::getLastTaskDescription() { return lastTaskDescription; }
        QString CThread::getTaskDescription()     { return taskDescription; }
        QString CThread::getThreadName()          { return threadName; }
        qint64  CThread::getWaitTimeSecs()        { return waitTimeSecs; }
        qint64  CThread::getRunTimeSecs()         { return runTimeSecs; }
        qint64  CThread::getBlockTimeSecs()       { return blockTimeSecs; }
        qint64  CThread::getThreadID()            { return threadID; }

        void CThread::postEvent(QEvent* event, int /*priority*/) {
            PthreadState* s = getState(this);
            if (!s) {
                delete event; return;
            }
            pthread_mutex_lock(&s->queueMutex);
            s->eventQueue.push_back(event);
            pthread_cond_signal(&s->queueCond);
            pthread_mutex_unlock(&s->queueMutex);
        }

        void CThread::waitSynchronization() {
            QSemaphore syncSem(0);
            postEvent(new CWaitSynchronizationEvent(&syncSem));
            syncSem.acquire();
        }

        bool CThread::isThreadRunning() {
            PthreadState* s = getState(this);
            return s && s->running;
        }

        void CThread::restartThread() {
            stopThread(true);
            startThread();
        }

        void CThread::run() {
            threadID = nextThreadID++;

            bool registered = false;
            if (mWatchDog) registered = mWatchDog->registerThread(this);

            threadStarted();

            PthreadState* s = getOrCreateState(this);
            s->running = true;
            threadRuns = true;

            pthread_mutex_lock(&s->queueMutex);
            while (true) {
                while (s->eventQueue.empty() && !s->shouldStop)
                    pthread_cond_wait(&s->queueCond, &s->queueMutex);
                if (s->shouldStop && s->eventQueue.empty()) break;
                QEvent* ev = s->eventQueue.front();
                s->eventQueue.pop_front();
                pthread_mutex_unlock(&s->queueMutex);

                try {
                    this->event(ev);
                } catch (...) {}
                delete ev;

                pthread_mutex_lock(&s->queueMutex);
            }
            pthread_mutex_unlock(&s->queueMutex);

            s->running = false;
            threadRuns = false;
            threadStopped();
            if (mWatchDog) mWatchDog->checkoutThread(this);
        }

        void CThread::prepareExecution()  {}
        void CThread::concludeExecution() {}
        void CThread::prepareWaiting()    {}
        void CThread::concludeWaiting()   {}

        bool CThread::event(QEvent* event) {
            try {
                TIMEMEASUREMENTENDWAITING();
                TIMEMEASUREMENTBEGINEXECUTION();
                SETTASKDESCRIPTION("Start Processing Events");

                mActiveEventProcessing = true;
                bool processed = processEvents(event);

                if (!processed) {
                    QEvent::Type type = event->type();
                    if (type >= 1200 && type < 2000) {
                        processControlEvents(type, (CControlEvent*)event);
                        processed = true;
                    } else if (type >= 2000) {
                        processCustomsEvents(type, (CCustomEvent*)event);
                        processed = true;
                    }
                }
                mActiveEventProcessing = false;

                TIMEMEASUREMENTENDEXECUTION();
                TIMEMEASUREMENTBEGINWAITING();
                SETTASKDESCRIPTION("Wait for Events");

                return processed;
            } catch (exception& e) {
                LOG(ERROR, "::Konclude::Thread",
                    logTr("Unhandled standard exception %1, thread %2 stopped.").arg(e.what()).arg(threadName), this);
                return false;
            } catch (...) {
                LOG(ERROR, "::Konclude::Thread",
                    logTr("Unhandled exception, thread %1 stopped.").arg(threadName), this);
                return false;
            }
        }

        bool CThread::isThreadProcessingEvents() { return mActiveEventProcessing; }

        void CThread::prepareBlocking()  {}
        void CThread::concludeBlocking() {}
        void CThread::threadStarted()    {}
        void CThread::threadStopped()    {}

        void CThread::startThread(QThread::Priority /*priority*/) {
            PthreadState* s = getOrCreateState(this);
            s->shouldStop = false;
            s->running    = false;
            s->started    = false;
            if (pthread_create(&s->thread, nullptr, [](void* arg) -> void* {
                    static_cast<CThread*>(arg)->run();
                    return nullptr;
                }, this) == 0) {
                s->started = true;
            }
        }

        void CThread::stopThread(bool waitStopped) {
            PthreadState* s = getState(this);
            if (!s || !s->started) return;
            pthread_mutex_lock(&s->queueMutex);
            s->shouldStop = true;
            pthread_cond_signal(&s->queueCond);
            pthread_mutex_unlock(&s->queueMutex);
            if (waitStopped) {
                pthread_join(s->thread, nullptr);
                s->started = false;
            }
        }

        bool CThread::processEvents(QEvent* /*event*/)                        { return false; }
        bool CThread::processCustomsEvents(QEvent::Type, CCustomEvent*)        { return false; }

        bool CThread::processControlEvents(QEvent::Type type, CControlEvent* event) {
            if (type == EVENTREQUESTFEEDBACKWATCHDOG) {
                SETTASKDESCRIPTION("Send WatchDog Feedback");
                CRequestFeedbackEvent* rfe = (CRequestFeedbackEvent*)event;
                CWatchDog* watchDog = (CWatchDog*)rfe->getWatchDogThread();
                watchDog->feedbackThread(this, rfe->getUpdateNumber());
                return true;
            } else if (type == EVENTWAITSYNCHRONIZATION) {
                SETTASKDESCRIPTION("Synchronize");
                CWaitSynchronizationEvent* wse = (CWaitSynchronizationEvent*)event;
                wse->synchronize();
                return true;
            }
            return false;
        }

    } // namespace Concurrent
} // namespace Konclude
