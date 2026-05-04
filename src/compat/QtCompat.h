#pragma once
#ifndef QTCOMPAT_H
#define QTCOMPAT_H

// QtCompat.h — Qt container type aliases backed by std:: equivalents,
// plus no-op stubs for Qt threading primitives (QThread, QMutex, etc.)
// for the WASM single-threaded Web Worker build.
//
// Purpose: Allow Konclude kernel sources to compile without Qt installed,
// by mapping Qt container types to their std:: counterparts.  This header
// is placed on the include path (src/compat/) so that patched sources can
// use  #include "QtCompat.h"  in place of individual Qt container headers.
//
// QRegExp is intentionally NOT provided here.  Konclude uses QRegExp only
// in the CLI/Control layer which is excluded from the WASM kernel build.
// If QRegExp appears in a retained kernel source, that file needs
// investigation before it can be compiled under WASM.

#include <unordered_map>
#include <vector>
#include <unordered_set>
#include <stack>
#include <string>
#include <string_view>
#include <list>
#include <map>
#include <utility>    // std::pair
#include <cstdint>    // UINT64_C, INT64_C
#include <climits>    // ULONG_MAX

// ---------------------------------------------------------------------------
// Container aliases
// ---------------------------------------------------------------------------

template<typename K, typename V> using QHash = std::unordered_map<K, V>;
template<typename T> using QList = std::vector<T>;
template<typename T> using QSet = std::unordered_set<T>;
template<typename T> using QStack = std::stack<T>;

// Forward declaration for QString::toUtf8()
struct QByteArray;

struct QString : public std::string {
    QString() = default;
    QString(const char* s) : std::string(s) {}
    QString(const char* s, std::size_t n) : std::string(s, n) {}
    explicit QString(const std::string& s) : std::string(s) {}
    // toUtf8() returns a QByteArray (which is also a std::string subclass)
    QByteArray toUtf8() const;
};

using QStringList = std::vector<QString>;

// QLinkedList wrapper: std::list doesn't have constBegin()/constEnd(),
// but Qt code expects them. Provide a thin struct wrapper.
template<typename T>
struct QLinkedList : public std::list<T> {
    using std::list<T>::list;
    typename std::list<T>::const_iterator constBegin() const { return this->cbegin(); }
    typename std::list<T>::const_iterator constEnd() const { return this->cend(); }
    typename std::list<T>::iterator begin() { return std::list<T>::begin(); }
    typename std::list<T>::iterator end() { return std::list<T>::end(); }
};

using QLatin1String = std::string_view;
template<typename A, typename B> using QPair = std::pair<A, B>;

// QMap → std::map (ordered; used less often than QHash in Konclude)
template<typename K, typename V> using QMap = std::map<K, V>;

// QVector → std::vector (common alias in older Qt code)
template<typename T> using QVector = std::vector<T>;

// ---------------------------------------------------------------------------
// Numeric literal macros
// ---------------------------------------------------------------------------

#define Q_UINT64_C(x) UINT64_C(x)
#define Q_INT64_C(x)  INT64_C(x)

// ---------------------------------------------------------------------------
// QString IS std::string in this shim.
// All std::string member functions (find, substr, size, c_str, …) are
// available directly.  Qt-specific QString methods (arg, toStdString, etc.)
// are NOT provided; if they appear in retained sources those call-sites need
// to be ported separately.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Qt keyword / macro compatibility
// ---------------------------------------------------------------------------

// foreach(var, container) — Qt keyword, map to range-based for.
#ifndef foreach
#  define foreach(var, container) for (var : container)
#endif

// ---------------------------------------------------------------------------
// QAtomicPointer stub — single-threaded: plain pointer is sufficient.
// ---------------------------------------------------------------------------

template<typename T>
struct QAtomicPointer {
    T* ptr = nullptr;
    QAtomicPointer() = default;
    explicit QAtomicPointer(T* p) : ptr(p) {}
    T* load() const { return ptr; }
    T* loadAcquire() const { return ptr; }
    void store(T* p) { ptr = p; }
    void storeRelaxed(T* p) { ptr = p; }
    bool testAndSetOrdered(T* expected, T* newVal) {
        if (ptr == expected) { ptr = newVal; return true; }
        return false;
    }
    operator T*() const { return ptr; }
    T* operator->() const { return ptr; }
};

// ---------------------------------------------------------------------------
// QTime stub — workload measurement is disabled in WASM build.
// ---------------------------------------------------------------------------

struct QTime {
    void start() {}
    int elapsed() const { return 0; }
    int restart() { return 0; }
    bool isValid() const { return false; }
};

// QDateTime stub — used only for watchdog timestamp recording.
struct QDateTime {
    static QDateTime currentDateTime() { return QDateTime{}; }
    bool isValid() const { return false; }
};

// ---------------------------------------------------------------------------
// Threading primitive stubs — no-ops for WASM single-threaded execution.
// In a Web Worker context there is only one thread; all locking reduces to
// straight-through execution.
// ---------------------------------------------------------------------------

struct QMutex {
    enum RecursionMode { NonRecursive = 0, Recursive = 1 };
    explicit QMutex(RecursionMode = NonRecursive) {}
    void lock() {}
    void unlock() {}
    bool tryLock(int = 0) { return true; }
};

struct QMutexLocker {
    explicit QMutexLocker(QMutex*) {}
};

struct QSemaphore {
    explicit QSemaphore(int = 0) {}
    void acquire(int = 1) {}
    void release(int = 1) {}
    bool tryAcquire(int = 1, int = 0) { return true; }
    int available() const { return 1; }
};

struct QReadWriteLock {
    void lockForRead() {}
    void lockForWrite() {}
    void unlock() {}
    bool tryLockForRead(int = 0) { return true; }
    bool tryLockForWrite(int = 0) { return true; }
};

struct QTimer {
    void start(int = 0) {}
    void stop() {}
    bool isActive() const { return false; }
};

struct QWaitCondition {
    void wait(QMutex*, unsigned long = ULONG_MAX) {}
    void wakeOne() {}
    void wakeAll() {}
};

// ---------------------------------------------------------------------------
// QThread stub — base class replacement for WASM.
// CThread previously inherited QThread; in the WASM build CThread is its
// own base.  This stub is kept for any remaining direct QThread references.
// ---------------------------------------------------------------------------

struct QThread {
    enum Priority {
        IdlePriority,
        LowestPriority,
        LowPriority,
        NormalPriority,
        HighPriority,
        HighestPriority,
        TimeCriticalPriority,
        InheritPriority
    };
    void start(Priority = InheritPriority) {}
    void quit() {}
    bool wait(unsigned long = ULONG_MAX) { return true; }
    void terminate() {}
    bool isRunning() const { return false; }
    bool isFinished() const { return true; }
    static void msleep(unsigned long) {}
    static void sleep(unsigned long) {}
    static void usleep(unsigned long) {}
    void moveToThread(QThread*) {}
    static QThread* currentThread() { return nullptr; }
};

// ---------------------------------------------------------------------------
// QObject stub — minimal surface used by CThread event dispatch.
// ---------------------------------------------------------------------------

#ifndef QOBJECT_STUB_DEFINED
#define QOBJECT_STUB_DEFINED
struct QObject {
    int startTimer(int) { return 0; }
    static void killTimer(int) {}
};
#endif

// ---------------------------------------------------------------------------
// QEvent / QTimerEvent stubs
// ---------------------------------------------------------------------------

#ifndef QEVENT_STUB_DEFINED
#define QEVENT_STUB_DEFINED
struct QEvent {
    enum Type {
        None = 0,
        Timer = 1,
        // Konclude custom event ranges:
        // 1200–1999 = control events, 2000+ = custom events
        User = 1000
    };
    explicit QEvent(Type t) : mType(t) {}
    virtual ~QEvent() {}
    Type type() const { return mType; }
private:
    Type mType;
};

struct QTimerEvent : public QEvent {
    explicit QTimerEvent(int id) : QEvent(QEvent::Timer), mTimerId(id) {}
    int timerId() const { return mTimerId; }
private:
    int mTimerId;
};
#endif

// ---------------------------------------------------------------------------
// Qt type aliases
// ---------------------------------------------------------------------------
using qint64  = int64_t;
using quint64 = uint64_t;
using qint32  = int32_t;
using quint32 = uint32_t;

namespace Qt {
    enum EventPriority { LowEventPriority = -1, NormalEventPriority = 0, HighEventPriority = 1 };
}

// ---------------------------------------------------------------------------
// QThreadPool stub — single-threaded WASM: tasks run synchronously.
// ---------------------------------------------------------------------------

#include <functional>

struct QThreadPool {
    static QThreadPool* globalInstance() {
        static QThreadPool instance;
        return &instance;
    }
    void start(std::function<void()> f) { f(); }
    void waitForDone(int = -1) {}
    int maxThreadCount() const { return 1; }
    void setMaxThreadCount(int) {}
};

// ---------------------------------------------------------------------------
// QtConcurrent stub — synchronous execution (WASM is single-threaded).
// The return value of run() is discarded at all current call-sites, so a
// void return is sufficient.  If a QFuture<T> is ever needed, add a minimal
// QFuture<T> struct and adjust the return type accordingly.
// ---------------------------------------------------------------------------

namespace QtConcurrent {
    // Overload accepting a QThreadPool* as first arg (ignored in WASM)
    template<typename F, typename... Args>
    void run(QThreadPool*, F&& f, Args&&... args) {
        f(std::forward<Args>(args)...);
    }

    // Plain overload without pool
    template<typename F, typename... Args>
    void run(F&& f, Args&&... args) {
        f(std::forward<Args>(args)...);
    }
}

// ---------------------------------------------------------------------------
// QByteArray stub — thin wrapper over std::string
// Used for byte buffer operations: .constData(), .toUtf8(), .size(), etc.
// Inherits from std::string to provide all container methods automatically.
// ---------------------------------------------------------------------------

struct QByteArray : public std::string {
    QByteArray() = default;
    QByteArray(const char* s) : std::string(s) {}
    QByteArray(const char* s, std::size_t n) : std::string(s, n) {}
    explicit QByteArray(const std::string& s) : std::string(s) {}
    const char* constData() const { return data(); }
    QByteArray toUtf8() const { return *this; }
};

// Implement QString::toUtf8() now that QByteArray is defined
inline QByteArray QString::toUtf8() const {
    return QByteArray(static_cast<const std::string&>(*this));
}

#endif // QTCOMPAT_H
