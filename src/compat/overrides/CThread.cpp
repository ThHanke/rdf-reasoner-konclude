/*
 *		Copyright (C) 2013-2015, 2019 by the Konclude Developer Team.
 *		LGPLv3 — see vendor/konclude/ for full license text.
 *
 *		WASM override: replaces vendor/konclude/Source/Concurrent/CThread.cpp.
 *		Each CThread gets a real pthread_t with per-thread mutex/condvar event
 *		queue.  postEvent is non-blocking; run() is the blocking event loop.
 *		State is stored in a static map so CThread.h needs no modification.
 */
#include "KonStall.h"
#include "DetSched.h"
#include "Concurrent/Events/CHandleEventsEvent.h"
#include <memory>
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
#ifdef NATIVE_DEBUG_BUILD
        DetSched::Th*    dth = nullptr;
#endif

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
#ifdef NATIVE_DEBUG_BUILD
            if (DetSched::on()) {
                s->eventQueue.push_back(event);
                DetSched::wake(&s->queueCond, true);
                DetSched::maybePreempt();
                return;
            }
#endif
            pthread_mutex_lock(&s->queueMutex);
            s->eventQueue.push_back(event);
            pthread_cond_signal(&s->queueCond);
            pthread_mutex_unlock(&s->queueMutex);
        }

        void CThread::waitSynchronization() {
            QSemaphore syncSem(0);
            postEvent(new CWaitSynchronizationEvent(&syncSem));
#ifdef NATIVE_DEBUG_BUILD
            // Timed watchdog: print queue depth every 5s, abort at 30s for post-mortem.
            for (int tries = 0; ; ++tries) {
                if (syncSem.tryAcquire(1, 5000)) break;
                PthreadState* s = getState(this);
                size_t qd = s ? s->eventQueue.size() : 0u;
                fprintf(stderr, "WATCHDOG[%s]: waitSync slice %d, queue_depth=%zu\n",
                        threadName.c_str(), tries + 1, qd);
                if (tries >= 5) {
                    fprintf(stderr, "WATCHDOG: 30s timeout — aborting for GDB post-mortem\n");
                    abort();
                }
            }
#else
            syncSem.acquire();
#endif
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

#ifdef NATIVE_DEBUG_BUILD
            if (DETS_ON()) {
                for (;;) {
                    while (s->eventQueue.empty() && !s->shouldStop) DetSched::block(&s->queueCond);
                    if (s->shouldStop) {
                        while (!s->eventQueue.empty()) { delete s->eventQueue.front(); s->eventQueue.pop_front(); }
                        break;
                    }
                    QEvent* ev = s->eventQueue.front();
                    s->eventQueue.pop_front();
                    DetSched::note(((uint64_t)threadID << 32) ^ (uint64_t)ev->type());
                    try { this->event(ev); } catch (...) {}
                    delete ev;
                }
                s->running = false;
                threadRuns = false;
                threadStopped();
                if (mWatchDog) mWatchDog->checkoutThread(this);
                return;
            }
#endif
            pthread_mutex_lock(&s->queueMutex);
            while (true) {
                while (s->eventQueue.empty() && !s->shouldStop) {
                    pthread_cond_wait(&s->queueCond, &s->queueMutex);
                }
                // On stop: drain remaining events without processing. In native
                // Konclude each ontology is a fresh process so threads simply die;
                // events queued after the final callback (e.g. late STPU callbacks
                // referencing already-freed CRealizingTestingItem) are dropped
                // automatically. Replicating that behaviour here prevents
                // use-after-free vtable crashes in the Realizer-Thread.
                if (s->shouldStop) {
                    while (!s->eventQueue.empty()) {
                        delete s->eventQueue.front();
                        s->eventQueue.pop_front();
                    }
                    break;
                }
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
            // Timestamps for stall detection; the task-processor loop event lives as long as the thread
            // and must not count.
            std::unique_ptr<KonStall::EventTouch> konStallTouch;
            if (event->type() != Concurrent::Events::CHandleEventsEvent::EVENTTYPE) konStallTouch.reset(new KonStall::EventTouch());
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
#ifdef NATIVE_DEBUG_BUILD
            if (DetSched::on()) s->dth = DetSched::spawn(threadName.toStdString());
#endif
            int rc = pthread_create(&s->thread, nullptr, [](void* arg) -> void* {
                    CThread* self = static_cast<CThread*>(arg);
#ifdef NATIVE_DEBUG_BUILD
                    PthreadState* st = getState(self);
                    if (DetSched::on() && st && st->dth) DetSched::childStart(st->dth);
#endif
                    self->run();
#ifdef NATIVE_DEBUG_BUILD
                    if (DetSched::on() && st && st->dth) DetSched::finish(st->dth);
#endif
                    return nullptr;
                }, this);
            if (rc == 0) {
                s->started = true;
            }
        }

        void CThread::stopThread(bool waitStopped) {
            PthreadState* s = getState(this);
            if (!s || !s->started) return;
#ifdef NATIVE_DEBUG_BUILD
            if (DetSched::on()) {
                s->shouldStop = true;
                DetSched::wake(&s->queueCond, true);
                if (waitStopped) { DetSched::join(s->dth); pthread_join(s->thread, nullptr); s->started = false; }
                return;
            }
#endif
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
