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
#include <set>
#include <stack>
#include <string>
#include <string_view>
#include <list>
#include <map>
#include <utility>    // std::pair
#include <cstdint>    // UINT64_C, INT64_C
#include <climits>    // ULONG_MAX
#include <algorithm>  // std::max, std::min
#include <iostream>   // std::cerr for qDebug stubs
#include <regex>

// ---------------------------------------------------------------------------
// Container aliases (QList before QHash/QMap so they can use QList as return type)
// ---------------------------------------------------------------------------

// Forward declarations for cross-type methods
template<typename T> struct QSet;
struct QString;  // forward decl so QList::join() can use it before QString is fully defined
struct QRegularExpression;  // forward decl so QString::count(QRegularExpression) can be declared

template<typename T>
struct QList : public std::vector<T> {
    using Base = std::vector<T>;
    using Base::Base;
    bool contains(const T& v) const {
        return std::find(this->begin(), this->end(), v) != this->end();
    }
    void append(const T& v) { this->push_back(v); }
    void append(const QList<T>& other) { Base::insert(this->end(), other.begin(), other.end()); }
    void prepend(const T& v) { this->insert(this->begin(), v); }
    void removeAll(const T& v) {
        this->erase(std::remove(this->begin(), this->end(), v), this->end());
    }
    bool removeOne(const T& v) {
        auto it = std::find(this->begin(), this->end(), v);
        if (it == this->end()) return false;
        this->erase(it); return true;
    }
    T& first() { return this->front(); }
    const T& first() const { return this->front(); }
    T& last() { return this->back(); }
    const T& last() const { return this->back(); }
    int count() const { return static_cast<int>(this->size()); }
    int count(const T& v) const {
        return static_cast<int>(std::count(this->begin(), this->end(), v));
    }
    void push_front(const T& v) { this->insert(this->begin(), v); }
    int indexOf(const T& v, int from = 0) const {
        for (int i = from; i < (int)this->size(); ++i)
            if ((*this)[i] == v) return i;
        return -1;
    }
    QList<T> mid(int pos, int len = -1) const {
        QList<T> r;
        int end = (len < 0) ? (int)this->size() : pos + len;
        for (int i = pos; i < end && i < (int)this->size(); ++i)
            r.push_back((*this)[i]);
        return r;
    }
    typename Base::const_iterator constBegin() const { return this->cbegin(); }
    typename Base::const_iterator constEnd()   const { return this->cend(); }
    bool isEmpty() const { return this->empty(); }
    QList<T>& operator<<(const T& v) { this->push_back(v); return *this; }
    QList<T>& operator<<(const QList<T>& o) { Base::insert(this->end(), o.begin(), o.end()); return *this; }
    T takeFirst() { T v = this->front(); this->erase(this->begin()); return v; }
    T takeLast()  { T v = this->back(); this->pop_back(); return v; }
    T takeAt(int i) { T v = (*this)[i]; this->erase(this->begin()+i); return v; }
    void removeFirst() { if (!this->empty()) this->erase(this->begin()); }
    void removeLast()  { if (!this->empty()) this->pop_back(); }
    void removeAt(int i) { this->erase(this->begin()+i); }
    void replace(int i, const T& v) { (*this)[i] = v; }
    void insert(int i, const T& v) { Base::insert(this->begin() + i, v); }
    typename Base::iterator insert(typename Base::iterator pos, const T& v) { return Base::insert(pos, v); }
    bool isDetached() const { return true; } // no COW in this shim
    void detach() {} // Qt COW no-op
    int size() const { return static_cast<int>(Base::size()); }
    QSet<T> toSet() const; // defined after QSet is complete
    QList<T>& operator+=(const T& v) { this->push_back(v); return *this; }
    QList<T>& operator+=(const QList<T>& o) { Base::insert(this->end(), o.begin(), o.end()); return *this; }
    QList<T>  operator+(const QList<T>& o) const {
        QList<T> r(*this); r.Base::insert(r.end(), o.begin(), o.end()); return r;
    }
    // join() — only instantiated for QList<QString> (T must be string-convertible).
    // Body is defined out-of-line after QString is fully declared (see below).
    template<typename U = T>
    auto join(const QString& sep) const
        -> std::enable_if_t<std::is_convertible<U, std::string>::value, QString>;
};

// Forward declaration of generic qHash so QHasherFn can call it before full definition.
// ADL will also find per-type qHash overloads defined in Konclude namespaces.
using uint = unsigned int;
template<typename T>
uint qHash(const T& key, uint seed = 0);

// QHasherFn: calls qHash(key) via ADL + the generic fallback above.
template<typename K>
struct QHasherFn {
    std::size_t operator()(const K& k) const {
        return static_cast<std::size_t>(qHash(k, 0u));
    }
};

// QHash non-const iterator wrapper — *it gives value (Qt convention)
template<typename K, typename V>
struct QHashIterator {
    typename std::unordered_map<K,V,QHasherFn<K>>::iterator it;
    QHashIterator() = default;
    explicit QHashIterator(typename std::unordered_map<K,V,QHasherFn<K>>::iterator i) : it(i) {}
    const K& key()   const { return it->first; }
    V& value()       const { return it->second; }
    QHashIterator& operator++() { ++it; return *this; }
    bool operator==(const QHashIterator& o) const { return it == o.it; }
    bool operator!=(const QHashIterator& o) const { return it != o.it; }
    V& operator*() const { return it->second; }
    V* operator->() const { return &it->second; }
};

// QHash const iterator wrapper — *it gives value (Qt convention)
template<typename K, typename V>
struct QHashConstIterator {
    typename std::unordered_map<K,V,QHasherFn<K>>::const_iterator it;
    QHashConstIterator() = default;
    explicit QHashConstIterator(typename std::unordered_map<K,V,QHasherFn<K>>::const_iterator i) : it(i) {}
    // Allow non-const → const conversion
    QHashConstIterator(const QHashIterator<K,V>& o) : it(o.it) {}
    const K& key()   const { return it->first; }
    const V& value() const { return it->second; }
    QHashConstIterator& operator++() { ++it; return *this; }
    bool operator==(const QHashConstIterator& o) const { return it == o.it; }
    bool operator!=(const QHashConstIterator& o) const { return it != o.it; }
    const V& operator*() const { return it->second; }
    const V* operator->() const { return &it->second; }
};

template<typename K, typename V>
struct QHash : public std::unordered_map<K, V, QHasherFn<K>> {
    using Base = std::unordered_map<K, V, QHasherFn<K>>;
    using Base::Base;
    using const_iterator = QHashConstIterator<K,V>;
    using iterator       = QHashIterator<K,V>;
    bool contains(const K& k) const { return Base::count(k) > 0; }
    V value(const K& k, const V& def = V{}) const {
        auto it = Base::find(k);
        return it != Base::end() ? it->second : def;
    }
    QList<V> values() const {
        QList<V> r; r.reserve(Base::size());
        for (auto it = Base::cbegin(); it != Base::cend(); ++it) r.push_back(it->second);
        return r;
    }
    QList<K> keys() const {
        QList<K> r; r.reserve(Base::size());
        for (auto it = Base::cbegin(); it != Base::cend(); ++it) r.push_back(it->first);
        return r;
    }
    void insert(const K& k, const V& v) { Base::insert_or_assign(k, v); }
    void insertMulti(const K& k, const V& v) { Base::insert_or_assign(k, v); }
    void remove(const K& k) { Base::erase(k); }
    int count(const K& k) const { return Base::count(k) > 0 ? 1 : 0; }
    int count() const { return static_cast<int>(Base::size()); }
    int size() const { return static_cast<int>(Base::size()); }
    bool isEmpty() const { return Base::empty(); }
    void detach() {} // Qt COW no-op
    // values(key): return list of values for key (single-value hash returns 0 or 1 elements)
    QList<V> values(const K& k) const {
        QList<V> r;
        auto it = Base::find(k);
        if (it != Base::end()) r.push_back(it->second);
        return r;
    }
    const_iterator constBegin() const { return const_iterator(Base::cbegin()); }
    const_iterator constEnd()   const { return const_iterator(Base::cend()); }
    const_iterator begin()  const { return constBegin(); }
    const_iterator end()    const { return constEnd(); }
    iterator begin() { return iterator(Base::begin()); }
    iterator end()   { return iterator(Base::end()); }
    iterator erase(iterator pos) { return iterator(Base::erase(pos.it)); }
    // find / constFind returning our iterator type
    const_iterator find(const K& k) const { return const_iterator(Base::find(k)); }
    iterator find(const K& k)       { return iterator(Base::find(k)); }
    const_iterator constFind(const K& k) const { return const_iterator(Base::find(k)); }
    // uniqueKeys: in this single-value map all keys are already unique
    QList<K> uniqueKeys() const { return keys(); }
    void unite(const QHash<K,V>& o) {
        for (auto it = o.Base::cbegin(); it != o.Base::cend(); ++it)
            Base::insert_or_assign(it->first, it->second);
    }
};

// QSet backed by std::unordered_set (matches Qt's hash-based QSet semantics).
// Requires T to have qHash(T) + operator== (or operator< for fallback types).
template<typename T>
struct QSet : public std::unordered_set<T, QHasherFn<T>> {
    using Base = std::unordered_set<T, QHasherFn<T>>;
    using Base::Base;
    bool contains(const T& v) const { return Base::count(v) > 0; }
    void insert(const T& v) { Base::insert(v); }
    bool remove(const T& v) { return Base::erase(v) > 0; }
    int count() const { return static_cast<int>(Base::size()); }
    bool isEmpty() const { return this->empty(); }
    void detach() {}
    QList<T> values() const {
        QList<T> r;
        for (auto& v : *this) r.push_back(v);
        return r;
    }
    typename Base::const_iterator constBegin() const { return this->cbegin(); }
    typename Base::const_iterator constEnd()   const { return this->cend(); }
    QList<T> toList() const { return values(); }
    QSet<T>& operator<<(const T& v) { Base::insert(v); return *this; }
    QSet<T>& operator+=(const QSet<T>& o) {
        for (const auto& v : o) Base::insert(v);
        return *this;
    }
    QSet<T> operator|(const QSet<T>& o) const {
        QSet<T> r(*this);
        for (const auto& v : o) r.Base::insert(v);
        return r;
    }
    QSet<T>& operator|=(const QSet<T>& o) { return operator+=(o); }
    QSet<T>& unite(const QSet<T>& o) { return operator+=(o); }
    QSet<T>  intersect(const QSet<T>& o) const {
        QSet<T> r;
        for (const auto& v : o) if (Base::count(v)) r.Base::insert(v);
        return r;
    }
    bool intersects(const QSet<T>& o) const {
        for (const auto& v : o) if (Base::count(v)) return true;
        return false;
    }
    QSet<T>  subtract(const QSet<T>& o) const {
        QSet<T> r(*this);
        for (const auto& v : o) r.Base::erase(v);
        return r;
    }
    int count(const T& v) const { return Base::count(v) > 0 ? 1 : 0; }
    int capacity() const { return static_cast<int>(Base::size()); }
    bool contains(const QSet<T>& o) const {
        for (const auto& v : o) if (!Base::count(v)) return false;
        return true;
    }
};

// QList::toSet() out-of-line definition (after QSet is complete)
template<typename T>
QSet<T> QList<T>::toSet() const {
    QSet<T> s;
    for (const T& v : *this) s.insert(v);
    return s;
}

template<typename T>
struct QStack : public std::stack<T> {
    using std::stack<T>::stack;
    bool isEmpty() const { return std::stack<T>::empty(); }
    int count() const { return static_cast<int>(std::stack<T>::size()); }
    T& top() { return std::stack<T>::top(); }
    const T& top() const { return std::stack<T>::top(); }
    void push(const T& v) { std::stack<T>::push(v); }
    T pop() { T v = std::stack<T>::top(); std::stack<T>::pop(); return v; }
};

// qSort — deprecated Qt sort, maps to std::sort
template<typename Container>
void qSort(Container& c) { std::sort(c.begin(), c.end()); }
template<typename Container, typename Compare>
void qSort(Container& c, Compare comp) { std::sort(c.begin(), c.end(), comp); }
template<typename It>
void qSort(It begin, It end) { std::sort(begin, end); }
template<typename It, typename Compare>
void qSort(It begin, It end, Compare comp) { std::sort(begin, end, comp); }

// Forward declarations for types used in QString
struct QByteArray;
struct QStringList;
struct QChar;
struct QString;  // forward for QStringRef

// QStringRef: lightweight non-owning substring view (defined before QString so
// QString can declare midRef() returning QStringRef by value)
struct QStringRef {
    const std::string* mData = nullptr;
    int mStart = 0, mLen = 0;
    QStringRef() = default;
    // defined after QString is complete:
    QStringRef(const QString* s);
    bool isNull()  const { return mData == nullptr; }
    bool isEmpty() const { return mLen == 0; }
    int  length()  const { return mLen; }
    // defined after QString is complete:
    operator QString() const;
    QString toString() const;
    bool operator==(const QStringRef& o) const {
        if (!mData && !o.mData) return true;
        if (!mData || !o.mData) return false;
        return mData->substr(mStart,mLen) == o.mData->substr(o.mStart,o.mLen);
    }
    bool startsWith(const char* s) const {
        if (!mData || !s) return false;
        std::string_view sv(mData->data() + mStart, mLen);
        std::string_view pat(s);
        return sv.size() >= pat.size() && sv.substr(0, pat.size()) == pat;
    }
    bool startsWith(const std::string& s) const { return startsWith(s.c_str()); }
    // Compare QStringRef with std::string / QString (forward-declared)
    bool operator==(const std::string& s) const {
        if (!mData) return s.empty();
        return mData->substr(mStart, mLen) == s;
    }
    bool operator!=(const std::string& s) const { return !(*this == s); }
    QStringRef mid(int pos, int len = -1) const {
        if (!mData) return {};
        int newStart = mStart + pos;
        int newLen = (len < 0) ? (mLen - pos) : len;
        QStringRef r; r.mData = mData; r.mStart = newStart; r.mLen = newLen;
        return r;
    }
};

struct QString : public std::string {
    QString() = default;
    QString(const char* s) : std::string(s ? s : "") {}
    QString(const char* s, std::size_t n) : std::string(s, n) {}
    QString(const std::string& s) : std::string(s) {}   // implicit: allows std::string -> QString
    QString(std::string&& s) : std::string(std::move(s)) {}
    QString(char c) : std::string(1, c) {}
    // operator+ must return QString (not std::string) for assignment to work
    QString operator+(const QString& o) const { return QString(std::string(*this) + std::string(o)); }
    QString operator+(const char* s) const { return QString(std::string(*this) + s); }
    QString& operator+=(const QString& o) { std::string::operator+=(o); return *this; }
    QString& operator+=(const char* s) { std::string::operator+=(s); return *this; }
    QString& operator+=(char c) { std::string::operator+=(c); return *this; }
    const char* constData() const { return c_str(); }
    QString(int n, char c) : std::string(n > 0 ? n : 0, c) {}
    QString(int64_t n, char c) : std::string(n > 0 ? (size_t)n : 0, c) {}

    QByteArray toUtf8() const;
    void detach() {} // copy-on-write nop for WASM

    // arg(): substitute %1, %2 ... or just append for simple format strings
    QString arg(const QString& a) const { return _subst(*this, a); }
    QString arg(int n) const { return _subst(*this, std::to_string(n)); }
    QString arg(long long n) const { return _subst(*this, std::to_string(n)); }
    QString arg(unsigned long long n) const { return _subst(*this, std::to_string(n)); }
    QString arg(unsigned int n) const { return _subst(*this, std::to_string(n)); }
    QString arg(unsigned long n) const { return _subst(*this, std::to_string(n)); }
    QString arg(long n) const { return _subst(*this, std::to_string(n)); }
    QString arg(double n) const { return _subst(*this, std::to_string(n)); }
    QString arg(const char* s) const { return _subst(*this, s); }
    QString(QChar c);  // defined after QChar
    QString arg(QChar c) const;  // defined after QChar
    QString& operator+=(QChar c);  // defined after QChar
    QString(const QChar* data, int len);  // defined after QChar
    // Two-arg overload
    template<typename A, typename B>
    QString arg(const A& a, const B& b) const { return arg(a).arg(b); }
    // Three-arg overload
    template<typename A, typename B, typename C>
    QString arg(const A& a, const B& b, const C& c) const { return arg(a).arg(b).arg(c); }
    // Four and five-arg overloads
    template<typename A, typename B, typename C, typename D>
    QString arg(const A& a, const B& b, const C& c, const D& d) const { return arg(a).arg(b).arg(c).arg(d); }
    template<typename A, typename B, typename C, typename D, typename E>
    QString arg(const A& a, const B& b, const C& c, const D& d, const E& e) const { return arg(a).arg(b).arg(c).arg(d).arg(e); }

    int toInt(bool* ok = nullptr) const {
        try { int v = std::stoi(*this); if(ok)*ok=true; return v; }
        catch(...) { if(ok)*ok=false; return 0; }
    }
    double toDouble(bool* ok = nullptr) const {
        try { double v = std::stod(*this); if(ok)*ok=true; return v; }
        catch(...) { if(ok)*ok=false; return 0.0; }
    }
    long long toLongLong(bool* ok = nullptr) const {
        try { long long v = std::stoll(*this); if(ok)*ok=true; return v; }
        catch(...) { if(ok)*ok=false; return 0LL; }
    }
    QByteArray toLocal8Bit() const;  // defined after QByteArray
    QByteArray toLatin1() const;
    const char* toStdString() const { return this->c_str(); }
    bool contains(const QString& s) const { return this->find(s) != std::string::npos; }
    bool contains(char c) const { return this->find(c) != std::string::npos; }
    int length() const { return static_cast<int>(this->size()); }
    QString& replace(const QString& before, const QString& after) {
        size_t pos = 0;
        while ((pos = this->std::string::find(before, pos)) != std::string::npos) {
            std::string::replace(pos, before.size(), after);
            pos += after.size();
        }
        return *this;
    }
    bool startsWith(const QString& s) const { return this->substr(0, s.size()) == s; }
    bool startsWith(char c) const { return !empty() && front() == c; }
    bool endsWith(const QString& s) const {
        return size() >= s.size() && this->substr(size() - s.size()) == s;
    }
    bool endsWith(char c) const { return !empty() && back() == c; }
    // compare with optional case sensitivity (Qt::CaseSensitive is the default)
    int compare(const QString& o, int cs = 1 /*Qt::CaseSensitive*/) const {
        if (cs == 0) { // CaseInsensitive
            std::string a(*this), b(o);
            for (auto& c : a) c = std::tolower((unsigned char)c);
            for (auto& c : b) c = std::tolower((unsigned char)c);
            return a.compare(b);
        }
        return std::string::compare(o);
    }
    bool isEmpty() const { return this->empty(); }
    // mid(pos, len=-1): substring from pos
    QString mid(int pos, int len = -1) const {
        if (pos < 0 || pos >= (int)size()) return {};
        if (len < 0) return QString(substr(pos));
        return QString(substr(pos, (size_t)len));
    }
    // left/right
    QString left(int n) const { return (n >= (int)size()) ? *this : QString(substr(0, n)); }
    QString right(int n) const { return (n >= (int)size()) ? *this : QString(substr(size() - n)); }
    // indexOf / lastIndexOf
    int indexOf(const QString& s, int from = 0) const {
        auto pos = this->std::string::find(s, from);
        return pos == std::string::npos ? -1 : (int)pos;
    }
    int indexOf(char c, int from = 0) const {
        auto pos = this->std::string::find(c, from);
        return pos == std::string::npos ? -1 : (int)pos;
    }
    int lastIndexOf(const QString& s, int from = -1) const {
        size_t start = (from < 0) ? std::string::npos : (size_t)from;
        auto pos = this->rfind(s, start);
        return pos == std::string::npos ? -1 : (int)pos;
    }
    int lastIndexOf(char c, int from = -1) const {
        size_t start = (from < 0) ? std::string::npos : (size_t)from;
        auto pos = this->rfind(c, start);
        return pos == std::string::npos ? -1 : (int)pos;
    }
    // remove(str): remove all occurrences
    QString& insert(int pos, const QString& s) {
        std::string::insert(static_cast<size_t>(pos), static_cast<const std::string&>(s));
        return *this;
    }
    QString& insert(int pos, char c) {
        std::string::insert(static_cast<size_t>(pos), 1, c);
        return *this;
    }
    QString& insert(int pos, QChar c);  // defined after QChar
    QString& remove(const QString& s) {
        size_t pos;
        while ((pos = this->std::string::find(s)) != std::string::npos)
            std::string::erase(pos, s.size());
        return *this;
    }
    QString& remove(char c) {
        this->erase(std::remove(this->begin(), this->end(), c), this->end());
        return *this;
    }
    QString& remove(int pos, int n) {
        if (pos >= 0 && n > 0 && pos < (int)size())
            this->erase(static_cast<size_t>(pos), static_cast<size_t>(n));
        return *this;
    }
    QString toLower() const {
        QString r(*this);
        for (auto& c : r) c = static_cast<char>(tolower(static_cast<unsigned char>(c)));
        return r;
    }
    QString toUpper() const {
        QString r(*this);
        for (auto& c : r) c = static_cast<char>(toupper(static_cast<unsigned char>(c)));
        return r;
    }
    static QString fromUtf8(const char* s, int len = -1) {
        if (!s) return {};
        return len < 0 ? QString(s) : QString(s, static_cast<std::size_t>(len));
    }
    static QString fromUtf8(const QByteArray& ba);  // defined after QByteArray
    static QString fromLatin1(const char* s, int len = -1) { return fromUtf8(s, len); }
    static QString fromStdString(const std::string& s) { return QString(s); }
    static QString number(int n) { return QString(std::to_string(n)); }
    static QString number(unsigned int n) { return QString(std::to_string(n)); }
    static QString number(long n) { return QString(std::to_string(n)); }
    static QString number(unsigned long n) { return QString(std::to_string(n)); }
    static QString number(long long n) { return QString(std::to_string(n)); }
    static QString number(unsigned long long n) { return QString(std::to_string(n)); }
    static QString number(double n, char fmt = 'g', int prec = 6) {
        char buf[64]; std::snprintf(buf, sizeof(buf), fmt == 'f' ? "%.*f" : "%.*g", prec, n);
        return QString(buf);
    }
    static QString fromRawData(const QChar* data, int len);  // defined after QChar
    float toFloat(bool* ok = nullptr) const {
        try { float v = std::stof(*this); if(ok)*ok=true; return v; }
        catch(...) { if(ok)*ok=false; return 0.0f; }
    }
    unsigned long long toULongLong(bool* ok = nullptr) const {
        try { unsigned long long v = std::stoull(*this); if(ok)*ok=true; return v; }
        catch(...) { if(ok)*ok=false; return 0ULL; }
    }
    QString& setNum(int n)         { std::string::operator=(std::to_string(n)); return *this; }
    QString& setNum(long long n)   { std::string::operator=(std::to_string(n)); return *this; }
    QString& setNum(double n, char fmt = 'g', int prec = 6) {
        char buf[64];
        const char* spec = (fmt == 'f') ? "%.*f" : (fmt == 'e') ? "%.*e" : "%.*g";
        std::snprintf(buf, sizeof(buf), spec, prec, n);
        std::string::operator=(buf); return *this;
    }
    QString trimmed() const {
        auto s = find_first_not_of(" \t\n\r");
        if (s == std::string::npos) return QString{};
        auto e = find_last_not_of(" \t\n\r");
        return QString(this->substr(s, e - s + 1));
    }
    // Qt::SplitBehavior is declared in Qt namespace below; forward-declare for split()
    QStringList split(const QString& sep, int skipEmpty = 0) const;
    QStringRef midRef(int pos, int len = -1) const;  // defined after QStringRef
    int count(const QRegularExpression& re) const;   // defined after QRegularExpression
    // Qt 5 compat: QString::SkipEmptyParts
    static constexpr int SkipEmptyParts = 1;
    static constexpr int KeepEmptyParts = 0;
    QStringRef leftRef(int n) const;   // defined after QStringRef
    QStringRef rightRef(int n) const;  // defined after QStringRef

private:
    static QString _subst(const std::string& templ, const std::string& val) {
        // Substitute lowest-numbered %N placeholder
        std::string result = templ;
        for (int i = 1; i <= 9; ++i) {
            std::string ph = "%" + std::to_string(i);
            auto pos = result.find(ph);
            if (pos != std::string::npos) {
                result.replace(pos, ph.size(), val);
                return QString(result);
            }
        }
        return QString(result + val); // fallback: append
    }
};

struct QStringList : public std::vector<QString> {
    using Base = std::vector<QString>;
    using Base::Base;
    explicit QStringList(const QString& s) { push_back(s); }
    QStringList(const QList<QString>& l) : Base(l.begin(), l.end()) {}
    QStringList(QList<QString>&& l) : Base(std::make_move_iterator(l.begin()), std::make_move_iterator(l.end())) {}
    QString join(const QString& sep) const {
        std::string r;
        for (size_t i = 0; i < size(); ++i) {
            if (i > 0) r += sep;
            r += (*this)[i];
        }
        return QString(r);
    }
    bool contains(const QString& s) const {
        return std::find(begin(), end(), s) != end();
    }
    bool isEmpty() const { return empty(); }
    void append(const QString& s) { push_back(s); }
    QStringList operator+(const QStringList& o) const {
        QStringList r(*this); r.Base::insert(r.end(), o.begin(), o.end()); return r;
    }
    QStringList& operator+=(const QStringList& o) {
        Base::insert(end(), o.begin(), o.end()); return *this;
    }
    QStringList& operator+=(const QString& s) { push_back(s); return *this; }
    QStringList& operator<<(const QString& s) { push_back(s); return *this; }
    QStringList& operator<<(const QStringList& o) { *this += o; return *this; }
    int count() const { return static_cast<int>(size()); }
    int length() const { return static_cast<int>(Base::size()); }
    int size() const { return static_cast<int>(Base::size()); }
    typename Base::const_iterator constBegin() const { return cbegin(); }
    typename Base::const_iterator constEnd()   const { return cend(); }
    // value(i): safe indexed access (returns empty QString on out-of-bounds)
    QString value(int i) const {
        if (i < 0 || i >= (int)Base::size()) return {};
        return (*this)[i];
    }
    // replace(i, str): replace element at index i
    void replace(int i, const QString& s) {
        if (i >= 0 && i < (int)Base::size()) (*this)[i] = s;
    }
    void insert(int i, const QString& s) { Base::insert(begin() + i, s); }
    typename Base::iterator insert(typename Base::const_iterator pos, const QString& s) {
        return Base::insert(pos, s);
    }
    QString first() const { return front(); }
    QString last()  const { return back(); }
    QString takeFirst() {
        QString v = front(); Base::erase(begin()); return v;
    }
    QString takeLast() {
        QString v = back(); Base::erase(--end()); return v;
    }
    void removeFirst() { if (!empty()) Base::erase(begin()); }
    void removeLast()  { if (!empty()) Base::erase(--end()); }
    void removeAt(int i) { Base::erase(begin() + i); }
    void removeAll(const QString& s) {
        Base::erase(std::remove(begin(), end(), s), end());
    }
    void removeDuplicates() {
        QStringList seen; QStringList result;
        for (auto& s : *this) { if (!seen.contains(s)) { seen.push_back(s); result.push_back(s); } }
        *this = result;
    }
    void prepend(const QString& s) { Base::insert(begin(), s); }
    void push_front(const QString& s) { Base::insert(begin(), s); }
    QSet<QString> toSet() const;  // defined after QSet<QString> is complete
};

// QStringList::toSet() — defined here after both QSet and QStringList are complete
inline QSet<QString> QStringList::toSet() const {
    QSet<QString> s;
    for (const QString& v : *this) s.insert(v);
    return s;
}

// Now QString::split can be defined (QStringList is complete)
inline QStringList QString::split(const QString& sep, int skipEmpty) const {
    QStringList result;
    if (sep.empty()) { result.push_back(*this); return result; }
    size_t start = 0, pos;
    while ((pos = this->find(sep, start)) != std::string::npos) {
        QString part(this->substr(start, pos - start));
        if (!skipEmpty || !part.empty()) result.push_back(part);
        start = pos + sep.size();
    }
    QString last(this->substr(start));
    if (!skipEmpty || !last.empty()) result.push_back(last);
    return result;
}

// QList::join() out-of-line definition (after QString is fully defined)
template<typename T>
template<typename U>
auto QList<T>::join(const QString& sep) const
    -> std::enable_if_t<std::is_convertible<U, std::string>::value, QString> {
    std::string r;
    bool first = true;
    for (const auto& v : *this) {
        if (!first) r += static_cast<const std::string&>(sep);
        r += static_cast<std::string>(v);
        first = false;
    }
    return QString(r);
}

// QRegExp stub — minimal regex support for language-tag matching in CParsingUtilities
struct QRegExp {
    std::regex mRe;
    std::string mPattern;
    mutable int mMatchedLen = 0;
    explicit QRegExp(const char* pat) : mRe(pat), mPattern(pat) {}
    explicit QRegExp(const std::string& pat) : mRe(pat), mPattern(pat) {}
    bool exactMatch(const std::string& s) const {
        std::smatch m;
        bool ok = std::regex_search(s, m, mRe);
        mMatchedLen = ok ? static_cast<int>(m[0].length()) : 0;
        return ok;
    }
    int matchedLength() const { return mMatchedLen; }
};

// QLinkedList wrapper: std::list doesn't have constBegin()/constEnd(),
// but Qt code expects them. Provide a thin struct wrapper.
template<typename T>
struct QLinkedList : public std::list<T> {
    using std::list<T>::list;
    typename std::list<T>::const_iterator constBegin() const { return this->cbegin(); }
    typename std::list<T>::const_iterator constEnd() const { return this->cend(); }
    typename std::list<T>::iterator begin() { return std::list<T>::begin(); }
    typename std::list<T>::iterator end() { return std::list<T>::end(); }
    typename std::list<T>::const_iterator begin() const { return this->cbegin(); }
    typename std::list<T>::const_iterator end() const { return this->cend(); }
    void append(const T& v) { this->push_back(v); }
    void prepend(const T& v) { this->push_front(v); }
    int count() const { return static_cast<int>(this->size()); }
    bool contains(const T& v) const {
        return std::find(this->begin(), this->end(), v) != this->end();
    }
    void removeAll(const T& v) { this->remove(v); }
    bool removeOne(const T& v) {
        auto it = std::find(this->begin(), this->end(), v);
        if (it == this->end()) return false;
        this->erase(it); return true;
    }
    QLinkedList<T>& operator+=(const QLinkedList<T>& o) {
        this->insert(this->end(), o.begin(), o.end()); return *this;
    }
    T takeFirst() { T v = this->front(); this->pop_front(); return v; }
    T takeLast()  { T v = this->back();  this->pop_back();  return v; }
    T& first() { return this->front(); }
    T& last()  { return this->back(); }
    const T& first() const { return this->front(); }
    const T& last()  const { return this->back(); }
    int size() const { return static_cast<int>(std::list<T>::size()); }
    bool isEmpty() const { return std::list<T>::empty(); }
};

using QLatin1String = std::string_view;

// QStringRef out-of-line definitions (QString is now complete)
inline QStringRef::QStringRef(const QString* s)
    : mData(s), mStart(0), mLen(s ? static_cast<int>(s->size()) : 0) {}
inline QStringRef::operator QString() const {
    if (!mData) return {};
    return QString(mData->substr(mStart, mLen));
}
inline QString QStringRef::toString() const { return operator QString(); }
// QString::midRef / leftRef / rightRef — out-of-line (after QStringRef is complete)
inline QStringRef QString::midRef(int pos, int len) const {
    QStringRef r(this);
    r.mStart = pos;
    r.mLen = (len < 0) ? (static_cast<int>(this->size()) - pos) : len;
    return r;
}
inline QStringRef QString::leftRef(int n) const {
    QStringRef r(this);
    r.mStart = 0;
    r.mLen = (n < 0) ? static_cast<int>(this->size()) : std::min(n, static_cast<int>(this->size()));
    return r;
}
inline QStringRef QString::rightRef(int n) const {
    int sz = static_cast<int>(this->size());
    QStringRef r(this);
    r.mLen = (n < 0) ? sz : std::min(n, sz);
    r.mStart = sz - r.mLen;
    return r;
}

template<typename A, typename B> using QPair = std::pair<A, B>;

// QMap iterator wrapper adding .key() / .value() Qt API
template<typename K, typename V, typename InnerIt>
struct QMapIteratorBase {
    InnerIt it;
    QMapIteratorBase() = default;
    explicit QMapIteratorBase(InnerIt i) : it(i) {}
    // Allow non-const → const iterator conversion (std::map::iterator → const_iterator)
    template<typename OtherIt,
             typename = std::enable_if_t<std::is_constructible<InnerIt, OtherIt>::value>>
    QMapIteratorBase(const QMapIteratorBase<K,V,OtherIt>& o) : it(o.it) {}
    const K& key()   const { return it->first; }
    V& value()       const { return const_cast<V&>(it->second); }
    QMapIteratorBase& operator++() { ++it; return *this; }
    QMapIteratorBase& operator--() { --it; return *this; }
    bool operator==(const QMapIteratorBase& o) const { return it == o.it; }
    bool operator!=(const QMapIteratorBase& o) const { return it != o.it; }
    auto operator->() const { return it.operator->(); }
    // Qt convention: *iterator returns value, not pair
    V& operator*() const { return const_cast<V&>(it->second); }
};

template<typename K, typename V>
struct QMap : public std::map<K, V> {
    using Base = std::map<K, V>;
    using Base::Base;
    using const_iterator = QMapIteratorBase<K, V, typename Base::const_iterator>;
    using iterator       = QMapIteratorBase<K, V, typename Base::iterator>;
    bool contains(const K& k) const { return Base::count(k) > 0; }
    V value(const K& k, const V& def = V{}) const {
        auto it = Base::find(k);
        return it != Base::end() ? it->second : def;
    }
    QList<V> values() const {
        QList<V> r; r.reserve(Base::size());
        for (auto it = Base::cbegin(); it != Base::cend(); ++it) r.push_back(it->second);
        return r;
    }
    QList<K> keys() const {
        QList<K> r; r.reserve(Base::size());
        for (auto it = Base::cbegin(); it != Base::cend(); ++it) r.push_back(it->first);
        return r;
    }
    void insert(const K& k, const V& v) { Base::insert_or_assign(k, v); }
    void insertMulti(const K& k, const V& v) { Base::insert_or_assign(k, v); }
    void remove(const K& k) { Base::erase(k); }
    int size() const { return static_cast<int>(Base::size()); }
    int count() const { return static_cast<int>(Base::size()); }
    int count(const K& k) const { return Base::count(k) > 0 ? 1 : 0; }
    bool isEmpty() const { return Base::empty(); }
    void detach() {}
    const_iterator constBegin() const { return const_iterator(Base::cbegin()); }
    const_iterator constEnd()   const { return const_iterator(Base::cend()); }
    const_iterator begin()  const { return constBegin(); }
    const_iterator end()    const { return constEnd(); }
    iterator begin() { return iterator(Base::begin()); }
    iterator end()   { return iterator(Base::end()); }
    iterator erase(iterator pos) { return iterator(Base::erase(pos.it)); }
    const_iterator find(const K& k) const { return const_iterator(Base::find(k)); }
    iterator find(const K& k)       { return iterator(Base::find(k)); }
    const_iterator constFind(const K& k) const { return const_iterator(Base::find(k)); }
    // lowerBound: returns first iterator >= key
    const_iterator lowerBound(const K& k) const { return const_iterator(Base::lower_bound(k)); }
    iterator lowerBound(const K& k) { return iterator(Base::lower_bound(k)); }
    const_iterator upperBound(const K& k) const { return const_iterator(Base::upper_bound(k)); }
    iterator upperBound(const K& k) { return iterator(Base::upper_bound(k)); }
    // operator==: compare key via strict-weak-order equivalence (avoids requiring K::operator==)
    bool operator==(const QMap<K,V>& o) const {
        if (Base::size() != o.Base::size()) return false;
        auto it1 = Base::cbegin(), it2 = o.Base::cbegin();
        for (; it1 != Base::cend(); ++it1, ++it2) {
            const K& k1 = it1->first; const K& k2 = it2->first;
            if (k1 < k2 || k2 < k1) return false;
            if (!(it1->second == it2->second)) return false;
        }
        return true;
    }
    bool operator!=(const QMap<K,V>& o) const { return !(*this == o); }
};

template<typename T> using QVector = QList<T>;

// QMapIterator<K,V> — Java-style bidirectional iterator for QMap
// Usage: QMapIterator<K,V> it(map); it.toBack(); while(it.hasPrevious()) { it.previous().key(); }
template<typename K, typename V>
struct QMapIterator {
    const QMap<K,V>& c;
    typename QMap<K,V>::const_iterator it;
    explicit QMapIterator(const QMap<K,V>& m) : c(m), it(m.begin()) {}
    bool hasNext()     const { return it != c.end(); }
    bool hasPrevious() const { return it != c.begin(); }
    const QMapIteratorBase<K,V,typename std::map<K,V>::const_iterator>& next() { return *(it++), --it, *reinterpret_cast<const QMapIteratorBase<K,V,typename std::map<K,V>::const_iterator>*>(nullptr); }
    // previous(): decrement then return iterator wrapper
    QMapIteratorBase<K,V,typename std::map<K,V>::const_iterator> previous() {
        --it; return QMapIteratorBase<K,V,typename std::map<K,V>::const_iterator>(it);
    }
    QMapIteratorBase<K,V,typename std::map<K,V>::const_iterator> peekNext() const {
        return QMapIteratorBase<K,V,typename std::map<K,V>::const_iterator>(it);
    }
    QMapIteratorBase<K,V,typename std::map<K,V>::const_iterator> peekPrevious() const {
        auto tmp = it; --tmp;
        return QMapIteratorBase<K,V,typename std::map<K,V>::const_iterator>(tmp);
    }
    void toFront() { it = c.begin(); }
    void toBack()  { it = c.end(); }
};

// ---------------------------------------------------------------------------
// Numeric literal macros
// ---------------------------------------------------------------------------

#define Q_UINT64_C(x) UINT64_C(x)
#define Q_INT64_C(x)  INT64_C(x)

// ---------------------------------------------------------------------------
// Qt primitive types
// ---------------------------------------------------------------------------
// uint already declared above (before QHasherFn)
using uchar    = unsigned char;
using ushort   = unsigned short;
using ulong    = unsigned long;
using qreal    = double;
using qptrdiff = std::ptrdiff_t;
using quintptr = std::uintptr_t;
using qintptr  = std::intptr_t;
using qsizetype = std::ptrdiff_t;

struct QChar {
    char16_t uc = 0;
    QChar() = default;
    QChar(char c) : uc(static_cast<char16_t>(c)) {}
    explicit QChar(unsigned short c) : uc(c) {}
    explicit QChar(int c) : uc(static_cast<char16_t>(c)) {}
    char toLatin1() const { return uc < 128 ? static_cast<char>(uc) : '?'; }
    unsigned short unicode() const { return uc; }
    bool isDigit()  const { return uc >= '0' && uc <= '9'; }
    bool isLetter() const { return (uc>='a'&&uc<='z')||(uc>='A'&&uc<='Z'); }
    bool isLetterOrNumber() const { return isLetter() || isDigit(); }
    bool isSpace()  const { return uc==' '||uc=='\t'||uc=='\n'||uc=='\r'; }
    bool isNull()   const { return uc == 0; }
    bool operator==(QChar o) const { return uc == o.uc; }
    bool operator!=(QChar o) const { return uc != o.uc; }
    bool operator<(QChar o) const { return uc < o.uc; }
    bool operator==(char c) const { return uc == static_cast<char16_t>(c); }
    bool operator!=(char c) const { return uc != static_cast<char16_t>(c); }
};
inline bool operator==(char c, QChar q) { return q == c; }
inline bool operator!=(char c, QChar q) { return q != c; }
// QChar vs string literal (e.g. textChar == "\n")
inline bool operator==(QChar q, const char* s) { return s && s[1]=='\0' && q==s[0]; }
inline bool operator!=(QChar q, const char* s) { return !(q==s); }
inline bool operator==(const char* s, QChar q) { return q==s; }
inline bool operator!=(const char* s, QChar q) { return !(q==s); }

// QString(QChar) constructor — defined after QChar is complete
inline QString::QString(QChar c) {
    if (c.uc < 0x80) { std::string::push_back(static_cast<char>(c.uc)); }
    else if (c.uc < 0x800) {
        std::string::push_back(static_cast<char>(0xC0 | (c.uc >> 6)));
        std::string::push_back(static_cast<char>(0x80 | (c.uc & 0x3F)));
    } else {
        std::string::push_back(static_cast<char>(0xE0 | (c.uc >> 12)));
        std::string::push_back(static_cast<char>(0x80 | ((c.uc >> 6) & 0x3F)));
        std::string::push_back(static_cast<char>(0x80 | (c.uc & 0x3F)));
    }
}

// QString::insert(int, QChar) — defined after QChar is complete
inline QString& QString::insert(int pos, QChar c) {
    char buf[5] = {};
    int len = 0;
    if (c.uc < 0x80) { buf[0] = static_cast<char>(c.uc); len = 1; }
    else if (c.uc < 0x800) {
        buf[0] = static_cast<char>(0xC0|(c.uc>>6)); buf[1] = static_cast<char>(0x80|(c.uc&0x3F)); len = 2;
    } else {
        buf[0] = static_cast<char>(0xE0|(c.uc>>12));
        buf[1] = static_cast<char>(0x80|((c.uc>>6)&0x3F));
        buf[2] = static_cast<char>(0x80|(c.uc&0x3F)); len = 3;
    }
    std::string::insert(static_cast<size_t>(pos), buf, len);
    return *this;
}

// QString + QChar — defined after QChar is complete
inline QString operator+(const QString& s, QChar c) { QString r(s); r += c; return r; }
inline QString operator+(QChar c, const QString& s) { QString r; r += c; r += s; return r; }

// QString == QChar: single-character equality
inline bool operator==(const QString& s, QChar c) { return s.size()==1 && (unsigned char)s[0]==c.toLatin1(); }
inline bool operator!=(const QString& s, QChar c) { return !(s == c); }
inline bool operator==(QChar c, const QString& s) { return s == c; }
inline bool operator!=(QChar c, const QString& s) { return !(s == c); }

// QString::arg(QChar) — defined here after QChar is complete
inline QString QString::arg(QChar c) const {
    char buf[5] = {};
    if (c.uc < 0x80) {
        buf[0] = static_cast<char>(c.uc);
    } else if (c.uc < 0x800) {
        buf[0] = static_cast<char>(0xC0 | (c.uc >> 6));
        buf[1] = static_cast<char>(0x80 | (c.uc & 0x3F));
    } else {
        buf[0] = static_cast<char>(0xE0 | (c.uc >> 12));
        buf[1] = static_cast<char>(0x80 | ((c.uc >> 6) & 0x3F));
        buf[2] = static_cast<char>(0x80 | (c.uc & 0x3F));
    }
    return _subst(*this, buf);
}

// QString::fromRawData — create from QChar array (same as QString(data, len) in this shim)
inline QString QString::fromRawData(const QChar* data, int len) { return QString(data, len); }

// QString(const QChar*, int) — build from UTF-16 QChar array (Latin-1 range assumed)
inline QString _qcharArrayToString(const QChar* data, int len) {
    std::string r;
    for (int i = 0; i < len; ++i) {
        unsigned short uc = data[i].uc;
        if (uc < 0x80) r += static_cast<char>(uc);
        else if (uc < 0x800) {
            r += static_cast<char>(0xC0 | (uc >> 6));
            r += static_cast<char>(0x80 | (uc & 0x3F));
        } else {
            r += static_cast<char>(0xE0 | (uc >> 12));
            r += static_cast<char>(0x80 | ((uc >> 6) & 0x3F));
            r += static_cast<char>(0x80 | (uc & 0x3F));
        }
    }
    return r;
}

// QString(const QChar*, int) constructor — defined after QChar is complete
inline QString::QString(const QChar* data, int len) : std::string(_qcharArrayToString(data, len)) {}

// QString::operator+=(QChar) — UTF-8 encode the character and append
inline QString& QString::operator+=(QChar c) {
    if (c.uc < 0x80) {
        std::string::operator+=(static_cast<char>(c.uc));
    } else if (c.uc < 0x800) {
        std::string::operator+=(static_cast<char>(0xC0 | (c.uc >> 6)));
        std::string::operator+=(static_cast<char>(0x80 | (c.uc & 0x3F)));
    } else {
        std::string::operator+=(static_cast<char>(0xE0 | (c.uc >> 12)));
        std::string::operator+=(static_cast<char>(0x80 | ((c.uc >> 6) & 0x3F)));
        std::string::operator+=(static_cast<char>(0x80 | (c.uc & 0x3F)));
    }
    return *this;
}

// ---------------------------------------------------------------------------
// Qt meta-type macros
// ---------------------------------------------------------------------------
#define Q_INLINE_TEMPLATE inline
#define Q_OUTOFLINE_TEMPLATE
#define Q_TYPENAME typename

// QTypeInfo: basic type traits (Qt containers use this for optimization hints)
template<typename T>
struct QTypeInfo {
    static constexpr bool isPointer      = false;
    static constexpr bool isIntegral     = false;
    static constexpr bool isComplex      = true;
    static constexpr bool isStatic       = true;
    static constexpr bool isRelocatable  = false;
    static constexpr bool isLarge        = (sizeof(T) > sizeof(void*));
    static constexpr bool isDummy        = false;
};
template<typename T>
struct QTypeInfo<T*> {
    static constexpr bool isPointer      = true;
    static constexpr bool isIntegral     = false;
    static constexpr bool isComplex      = false;
    static constexpr bool isStatic       = false;
    static constexpr bool isRelocatable  = true;
    static constexpr bool isLarge        = false;
    static constexpr bool isDummy        = false;
};

// std::hash specializations for Qt string types
namespace std {
template<> struct hash<QString> {
    size_t operator()(const QString& s) const noexcept {
        return std::hash<std::string>{}(static_cast<const std::string&>(s));
    }
};
template<> struct hash<QStringRef> {
    size_t operator()(const QStringRef& r) const noexcept {
        if (!r.mData) return 0;
        return std::hash<std::string>{}(r.mData->substr(r.mStart, r.mLen));
    }
};
} // namespace std

// Type trait: detect whether std::hash<T> is usable
template<typename T, typename = void>
struct _has_std_hash : std::false_type {};
template<typename T>
struct _has_std_hash<T, std::void_t<decltype(std::declval<std::hash<T>>()(std::declval<const T&>()))>>
    : std::true_type {};

// qHash — generic hash: use std::hash<T> if available, byte hash otherwise
template<typename T>
uint qHash(const T& key, uint seed) {
    if constexpr (_has_std_hash<T>::value) {
        return static_cast<uint>(std::hash<T>{}(key) ^ static_cast<size_t>(seed));
    } else {
        // Byte hash for plain-old-data types without std::hash
        const unsigned char* bytes = reinterpret_cast<const unsigned char*>(&key);
        size_t h = static_cast<size_t>(seed);
        for (size_t i = 0; i < sizeof(T); ++i)
            h = h * 131u + bytes[i];
        return static_cast<uint>(h);
    }
}
// Specializations for pointer types
template<typename T>
uint qHash(T* key, uint seed = 0) {
    return static_cast<uint>(std::hash<void*>{}(static_cast<void*>(key)) ^ static_cast<size_t>(seed));
}
inline uint qHash(const std::string& key, uint seed = 0) {
    return static_cast<uint>(std::hash<std::string>{}(key) ^ static_cast<size_t>(seed));
}
template<typename A, typename B>
uint qHash(const std::pair<A, B>& p, uint seed = 0) {
    return qHash(p.first, seed) ^ qHash(p.second, seed + 1);
}
inline uint qHash(bool b, uint seed = 0) {
    return static_cast<uint>(b) ^ seed;
}


// ---------------------------------------------------------------------------
// Qt aligned memory helpers (SIMD path — map to standard aligned_alloc/free)
// ---------------------------------------------------------------------------
#include <cstdlib>
#include <cstring>
inline void* qMallocAligned(std::size_t size, std::size_t alignment) {
    return aligned_alloc(alignment, (size + alignment - 1) & ~(alignment - 1));
}
inline void* qReallocAligned(void* old_ptr, std::size_t new_size, std::size_t /*old_size*/, std::size_t alignment) {
    std::size_t aligned_size = (new_size + alignment - 1) & ~(alignment - 1);
    void* new_ptr = aligned_alloc(alignment, aligned_size);
    if (new_ptr && old_ptr) std::memcpy(new_ptr, old_ptr, new_size);
    free(old_ptr);
    return new_ptr;
}
inline void qFreeAligned(void* ptr) { free(ptr); }

// ---------------------------------------------------------------------------
// Qt global utility functions
// ---------------------------------------------------------------------------
template<typename T> T qMax(T a, T b) { return a > b ? a : b; }
template<typename T> T qMin(T a, T b) { return a < b ? a : b; }
template<typename T> T qAbs(T a) { return a < T(0) ? -a : a; }
template<typename T> T qBound(T lo, T val, T hi) { return qMax(lo, qMin(val, hi)); }
inline int qRound(double d) { return static_cast<int>(d + 0.5); }

// QDebug no-op sink — absorbs any << operator or function-call usage
struct _QDebugSink {
    template<typename T> const _QDebugSink& operator<<(const T&) const { return *this; }
};
inline _QDebugSink _qNoopSink;
// Variadic macros swallow both qDebug() and qDebug(expr) patterns
#define qDebug(...)   (_qNoopSink)
#define qWarning(...) (_qNoopSink)
#define qInfo(...)    (_qNoopSink)

#define Q_ASSERT(x) ((void)(x))
#define Q_ASSERT_X(cond, where, what) ((void)(cond))
#define Q_UNUSED(x) ((void)(x))
#define Q_CHECK_PTR(p) ((void)(p))
#define Q_DECL_UNUSED __attribute__((unused))

// Exception-handling macros: no-op versions (WASM runs without exceptions for perf)
#define QT_TRY         if (true)
#define QT_CATCH(A)    else if (false)
#define QT_RETHROW
#define QT_THROW(A)    qt_noop()
inline void qt_noop() {}

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
// Qt meta-object system macros — no-ops in the WASM build (no moc).
// ---------------------------------------------------------------------------
#ifndef Q_OBJECT
#  define Q_OBJECT
#endif
// signals: and slots: are Qt access-specifiers.
// Map to public/empty so the class syntax stays valid without moc.
#ifndef signals
#  define signals public
#endif
#ifndef slots
#  define slots
#endif
#ifndef emit
#  define emit
#endif
#define Q_SIGNALS public
#define Q_SLOTS
#define Q_EMIT emit
#define Q_DISABLE_COPY(Class)
#define Q_DECLARE_METATYPE(Type)
#define Q_PROPERTY(...)
#define Q_ENUMS(...)
#define Q_FLAGS(...)
#define Q_INVOKABLE
#define Q_SLOT
#define Q_SIGNAL
#define Q_CLASSINFO(name, value)

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
    bool testAndSetRelaxed(T* expected, T* newVal) { return testAndSetOrdered(expected, newVal); }
    // fetchAndAddRelaxed(0) is the Qt idiom for an atomic load
    T* fetchAndAddRelaxed(std::ptrdiff_t) { return ptr; }
    // fetchAndStoreOrdered: atomically set to newVal and return old value
    T* fetchAndStoreOrdered(T* newVal) { T* old = ptr; ptr = newVal; return old; }
    T* fetchAndStoreRelaxed(T* newVal) { return fetchAndStoreOrdered(newVal); }
    operator T*() const { return ptr; }
    T* operator->() const { return ptr; }
    QAtomicPointer& operator=(T* p) { ptr = p; return *this; }
    QAtomicPointer& operator=(std::nullptr_t) { ptr = nullptr; return *this; }
};

// ---------------------------------------------------------------------------
// QTime stub — workload measurement is disabled in WASM build.
// ---------------------------------------------------------------------------

struct QTime {
    void start() {}
    int elapsed() const { return 0; }
    int restart() { return 0; }
    bool isValid() const { return false; }
    int msec() const { return 0; }
    int second() const { return 0; }
    int minute() const { return 0; }
    int hour() const { return 0; }
    static QTime currentTime() { return {}; }
};

inline int qrand() { return rand(); }
inline void qsrand(unsigned int seed) { srand(seed); }

// qDeleteAll: delete all pointers in a container
template<typename Container>
void qDeleteAll(const Container& c) {
    for (const auto& ptr : c) delete ptr;
}

// Qt TimeSpec / DateFormat enums needed by QDateTime (full Qt namespace defined below)
namespace Qt {
    enum TimeSpec { LocalTime = 0, UTC = 1, OffsetFromUTC = 2, TimeZone = 3 };
    enum DateFormat { ISODate = 1, TextDate = 0, SystemLocaleDate = 2, LocalDate = 2 };
    enum CaseSensitivity { CaseInsensitive = 0, CaseSensitive = 1 };
}

// QDate stub — minimal for date/time literal parsing
struct QDate {
    int mYear = 0, mMonth = 0, mDay = 0;
    QDate() = default;
    QDate(int y, int m, int d) : mYear(y), mMonth(m), mDay(d) {}
    bool isValid() const { return mMonth >= 1 && mMonth <= 12 && mDay >= 1; }
    int year()  const { return mYear; }
    int month() const { return mMonth; }
    int day()   const { return mDay; }
};

// QDateTime stub — used for watchdog timestamp recording and date-time value-space arithmetic.
struct QDateTime {
    long long mSecs = 0;
    bool mValid = false;
    Qt::TimeSpec mSpec = Qt::LocalTime;
    QDateTime() = default;
    // Constructor from QDate + QTime + TimeSpec (stub: ignores date/time, stores spec)
    QDateTime(const QDate&, const QTime&, Qt::TimeSpec spec = Qt::LocalTime) : mValid(true), mSpec(spec) {}
    static QDateTime currentDateTime() { return QDateTime{}; }
    bool isValid() const { return mValid; }
    long long secsTo(const QDateTime& other) const { return other.mSecs - mSecs; }
    QDateTime addSecs(long long s) const { QDateTime r; r.mSecs = mSecs + s; r.mValid = mValid; r.mSpec = mSpec; return r; }
    Qt::TimeSpec timeSpec() const { return mSpec; }
    QDate date() const { return QDate{}; }
    QTime time() const { return QTime{}; }
    QDateTime toUTC() const { QDateTime r(*this); r.mSpec = Qt::UTC; return r; }
    static QDateTime fromString(const QString&, Qt::DateFormat = Qt::ISODate) { return QDateTime{}; }
    QString toString(Qt::DateFormat = Qt::ISODate) const { return QString("1970-01-01T00:00:00"); }
    QString toString(const QString&) const { return QString("00:00:00:000"); }
    bool operator==(const QDateTime& o) const { return mSecs == o.mSecs; }
    bool operator!=(const QDateTime& o) const { return mSecs != o.mSecs; }
    bool operator<(const QDateTime& o) const { return mSecs < o.mSecs; }
    bool operator<=(const QDateTime& o) const { return mSecs <= o.mSecs; }
    bool operator>(const QDateTime& o) const { return mSecs > o.mSecs; }
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
    static int idealThreadCount() { return 1; }
};

// ---------------------------------------------------------------------------
// QObject stub — minimal surface used by CThread event dispatch.
// ---------------------------------------------------------------------------

#ifndef QOBJECT_STUB_DEFINED
#define QOBJECT_STUB_DEFINED
struct QObject {
    int startTimer(int) { return 0; }
    static void killTimer(int) {}
    static QString tr(const char* s, const char* = nullptr, int = -1) { return QString(s); }
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
    // TimeSpec and DateFormat are declared earlier (before QDateTime)
    enum SplitBehavior { KeepEmptyParts = 0, SkipEmptyParts = 1 };
    enum ConnectionType { AutoConnection=0, DirectConnection=1, QueuedConnection=2, BlockingQueuedConnection=3, UniqueConnection=0x80 };
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

    // blockingMap: synchronous iteration (WASM is single-threaded)
    template<typename Container, typename F>
    void blockingMap(Container& c, F f) {
        for (auto& item : c) f(item);
    }
    template<typename Container, typename F>
    void blockingMap(QThreadPool*, Container& c, F f) {
        for (auto& item : c) f(item);
    }

    // blockingMapped: synchronous map returning QVector of results
    // Overload 1: return type inferred
    template<typename Container, typename MapFn>
    auto blockingMapped(const Container& c, MapFn fn)
        -> QVector<decltype(fn(*c.begin()))> {
        QVector<decltype(fn(*c.begin()))> result;
        for (const auto& item : c) result.push_back(fn(item));
        return result;
    }
    // Overload 2: explicit OutputSequence template arg — QtConcurrent::blockingMapped<QVector<T>>(seq, fn)
    template<typename OutputSequence, typename InputSequence, typename MapFn>
    OutputSequence blockingMapped(const InputSequence& c, MapFn fn) {
        OutputSequence result;
        for (const auto& item : c) result.push_back(fn(item));
        return result;
    }
    template<typename Container, typename MapFn>
    auto blockingMapped(QThreadPool*, const Container& c, MapFn fn)
        -> QVector<decltype(fn(*c.begin()))> {
        return blockingMapped(c, fn);
    }

    // blockingMappedReduced: synchronous map-reduce (WASM is single-threaded)
    template<typename Result, typename Container, typename MapFn, typename ReduceFn>
    Result blockingMappedReduced(const Container& c, MapFn mapFn, ReduceFn reduceFn) {
        Result result{};
        for (const auto& item : c) {
            auto partial = mapFn(item);
            reduceFn(result, partial);
        }
        return result;
    }
}

// ---------------------------------------------------------------------------
// QCache<K,V> — LRU eviction cache; stub stores raw pointers, no eviction.
// Qt's QCache is hash-backed (uses QHash), so K needs operator== + qHash(),
// not operator<. Use unordered_map with a qHash-based hasher.
// ---------------------------------------------------------------------------
template<typename K>
struct QCacheHasher {
    size_t operator()(const K& k) const { return static_cast<size_t>(qHash(k)); }
};
template<typename K, typename V>
struct QCache {
    std::unordered_map<K, V*, QCacheHasher<K>> mData;
    int mMaxCost;
    explicit QCache(int maxCost = 100) : mMaxCost(maxCost) {}
    ~QCache() { clear(); }
    bool insert(const K& k, V* v, int /*cost*/ = 1) {
        auto it = mData.find(k);
        if (it != mData.end()) { delete it->second; it->second = v; }
        else mData[k] = v;
        return true;
    }
    V* object(const K& k) const {
        auto it = mData.find(k);
        return it != mData.end() ? it->second : nullptr;
    }
    bool contains(const K& k) const { return mData.count(k) > 0; }
    void remove(const K& k) {
        auto it = mData.find(k);
        if (it != mData.end()) { delete it->second; mData.erase(it); }
    }
    void clear() { for (auto& p : mData) delete p.second; mData.clear(); }
    int size() const { return static_cast<int>(mData.size()); }
    bool isEmpty() const { return mData.empty(); }
    void setMaxCost(int n) { mMaxCost = n; }
    int maxCost() const { return mMaxCost; }
};

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
    QByteArray trimmed() const {
        auto s = find_first_not_of(" \t\n\r");
        if (s == std::string::npos) return {};
        auto e = find_last_not_of(" \t\n\r");
        return QByteArray(substr(s, e - s + 1));
    }
    bool isEmpty() const { return empty(); }
    int size() const { return static_cast<int>(std::string::size()); }
    static QByteArray number(qint64 n) { return QByteArray(std::to_string(n)); }
    static QByteArray number(quint64 n) { return QByteArray(std::to_string(n)); }
    static QByteArray number(int n) { return QByteArray(std::to_string(n)); }
    static QByteArray number(double n, char fmt = 'g', int prec = 6) {
        char buf[64]; std::snprintf(buf, sizeof(buf), fmt == 'f' ? "%.*f" : "%.*g", prec, n);
        return QByteArray(buf);
    }
    QByteArray& setNum(qint64 n) { std::string::operator=(std::to_string(n)); return *this; }
    QByteArray& setNum(quint64 n) { std::string::operator=(std::to_string(n)); return *this; }
    QByteArray& setNum(int n) { std::string::operator=(std::to_string(n)); return *this; }
    QByteArray& setNum(double n, char fmt = 'g', int prec = 6) {
        char buf[64]; std::snprintf(buf, sizeof(buf), fmt == 'f' ? "%.*f" : "%.*g", prec, n);
        std::string::operator=(buf); return *this;
    }
};

// Implement QString methods that need QByteArray (now QByteArray is defined)
inline QString QString::fromUtf8(const QByteArray& ba) { return QString(static_cast<const std::string&>(ba)); }

// Implement QString methods that return QByteArray (now QByteArray is defined)
inline QByteArray QString::toUtf8() const {
    return QByteArray(static_cast<const std::string&>(*this));
}
inline QByteArray QString::toLocal8Bit() const { return toUtf8(); }
inline QByteArray QString::toLatin1() const { return toUtf8(); }

// ---------------------------------------------------------------------------
// QThread additions
// ---------------------------------------------------------------------------
// (QThread struct is defined further below; this extends it — add as free function)
inline int QThread_idealThreadCount() { return 1; }

// ---------------------------------------------------------------------------
// QIODevice / QFile / QTextStream stubs — file I/O not available in WASM kernel
// ---------------------------------------------------------------------------
struct QIODevice {
    enum OpenModeFlag { NotOpen=0, ReadOnly=1, WriteOnly=2, ReadWrite=3,
                        Append=4, Truncate=8, Text=16, Unbuffered=32 };
    using OpenMode = int;
    virtual ~QIODevice() {}
    virtual bool open(OpenMode) { return false; }
    virtual void close() {}
    virtual bool isOpen() const { return false; }
    virtual qint64 write(const char*, qint64) { return -1; }
    virtual qint64 write(const QByteArray& ba) { return -1; }
    virtual bool atEnd() const { return true; }
    virtual QByteArray readLine(qint64 = 0) { return {}; }
    virtual QByteArray readAll() { return {}; }
    virtual qint64 read(char*, qint64) { return -1; }
    virtual bool reset() { return true; }
    virtual qint64 pos() const { return 0; }
    virtual qint64 size() const { return 0; }
    virtual bool seek(qint64) { return false; }
    virtual bool isSequential() const { return true; }
    virtual qint64 bytesAvailable() const { return 0; }
    virtual bool canReadLine() const { return false; }
};

struct QFile : public QIODevice {
    explicit QFile(const QString& name) {}
    bool open(OpenMode m) override { return false; }
    void close() override {}
    bool isOpen() const override { return false; }
    qint64 write(const char* d, qint64 n) override { return -1; }
    qint64 write(const QByteArray& ba) override { return -1; }
    static bool exists(const QString&) { return false; }
    static bool remove(const QString&) { return false; }
    bool atEnd() const override { return true; }
    QByteArray readLine(qint64 = 0) override { return {}; }
    QByteArray readAll() override { return {}; }
    qint64 read(char*, qint64) override { return -1; }
};

struct QTextStream {
    explicit QTextStream(QIODevice*) {}
    explicit QTextStream(QString*) {}
    QTextStream& operator<<(const QString&) { return *this; }
    QTextStream& operator<<(const char*) { return *this; }
    QTextStream& operator<<(int) { return *this; }
    QTextStream& operator<<(double) { return *this; }
    void flush() {}
};

// QXmlAttributes — SAX-style attributes (QXmlSimpleReader API); all lookups return empty
struct QXmlAttributes {
    int count() const { return 0; }
    QString value(const QString&) const { return {}; }
    QString value(const QString&, const QString&) const { return {}; }
    QString localName(int) const { return {}; }
    QString uri(int) const { return {}; }
    bool isEmpty() const { return true; }
};

// QRegularExpression — stub; WASM reasoner never executes SPARQL text-search paths
struct QRegularExpression {
    explicit QRegularExpression(const QString& /*pattern*/) {}
    QRegularExpression() = default;
    static QString escape(const QString& s) { return s; }
};

// QXmlStreamAttributes — list of name/value pairs; all lookups return empty
struct QXmlStreamAttributes {
    QString value(const QString&, const QString&) const { return {}; }
    QString value(const QString&) const { return {}; }
    bool hasAttribute(const QString&) const { return false; }
    bool hasAttribute(const QString&, const QString&) const { return false; }
    bool isEmpty() const { return true; }
};

// QString::count(QRegularExpression) — always returns 0 in WASM (regex never executes)
inline int QString::count(const QRegularExpression&) const { return 0; }

// QXmlStreamReader — no-op XML reader stub
struct QXmlStreamReader {
    enum TokenType { NoToken=0, Invalid=1, StartDocument=2, EndDocument=3,
                     StartElement=4, EndElement=5, Characters=6, Comment=7,
                     DTD=8, EntityReference=9, ProcessingInstruction=10 };
    explicit QXmlStreamReader(QIODevice*) {}
    explicit QXmlStreamReader(const QString&) {}
    explicit QXmlStreamReader(const QByteArray&) {}
    QXmlStreamReader() = default;
    bool atEnd() const { return true; }
    bool hasError() const { return false; }
    TokenType readNext() { return NoToken; }
    TokenType tokenType() const { return NoToken; }
    QString name() const { return {}; }
    QString namespaceUri() const { return {}; }
    QString text() const { return {}; }
    QString errorString() const { return {}; }
    bool isStartElement() const { return false; }
    bool isEndElement() const { return false; }
    bool isCharacters() const { return false; }
    bool isWhitespace() const { return false; }
    void skipCurrentElement() {}
    QXmlStreamAttributes attributes() const { return {}; }
    void addData(const QByteArray&) {}
    void addData(const QString&) {}
    void setDevice(QIODevice*) {}
};

// QXmlStreamWriter — no-op XML writer stub
struct QXmlStreamWriter {
    explicit QXmlStreamWriter(QIODevice*) {}
    explicit QXmlStreamWriter(QString*) {}
    QXmlStreamWriter() = default;
    void setAutoFormatting(bool) {}
    void writeStartDocument() {}
    void writeStartDocument(const QString&) {}
    void writeEndDocument() {}
    void writeStartElement(const QString&) {}
    void writeStartElement(const QString&, const QString&) {}
    void writeEndElement() {}
    void writeEmptyElement(const QString&) {}
    void writeAttribute(const QString&, const QString&) {}
    void writeAttribute(const QString&, const QString&, const QString&) {}
    void writeCharacters(const QString&) {}
    void writeTextElement(const QString&, const QString&) {}
    void writeComment(const QString&) {}
    void writeProcessingInstruction(const QString&, const QString& = {}) {}
    void writeDTD(const QString&) {}
    bool hasError() const { return false; }
};

// ---------------------------------------------------------------------------
// QAtomicInteger / QAtomicInt — single-threaded WASM: plain value suffices
// ---------------------------------------------------------------------------
template<typename T>
struct QAtomicInteger {
    T val = 0;
    QAtomicInteger() = default;
    QAtomicInteger(T v) : val(v) {}
    T load() const { return val; }
    T loadAcquire() const { return val; }
    T loadRelaxed() const { return val; }
    void store(T v) { val = v; }
    void storeRelaxed(T v) { val = v; }
    void storeRelease(T v) { val = v; }
    bool testAndSetOrdered(T expected, T newVal) {
        if (val == expected) { val = newVal; return true; } return false;
    }
    bool testAndSetRelaxed(T expected, T newVal) { return testAndSetOrdered(expected, newVal); }
    T fetchAndAddOrdered(T a)  { T old = val; val += a; return old; }
    T fetchAndAddAcquire(T a)  { return fetchAndAddOrdered(a); }
    T fetchAndAddRelease(T a)  { return fetchAndAddOrdered(a); }
    T fetchAndAddRelaxed(T a)  { return fetchAndAddOrdered(a); }
    T operator++()    { return ++val; }
    T operator++(int) { return val++; }
    T operator--()    { return --val; }
    T operator--(int) { return val--; }
    operator T() const { return val; }
    // Qt ref/deref for intrusive reference counting
    bool ref()  { return ++val != T(0); }
    bool deref() { return --val != T(0); }
};
using QAtomicInt = QAtomicInteger<int>;

// ---------------------------------------------------------------------------
// QVariant stub — minimal variant for Config module (string/int/double/bool)
// ---------------------------------------------------------------------------
struct QVariant {
    enum Type { Invalid=0, Bool=1, Int=2, UInt=3, LongLong=4, Double=6, String=10, StringList=11 };
    Type mType = Invalid;
    std::string mStr;
    union { bool bval; int ival; double dval; long long llval; } mVal = {};

    QVariant() = default;
    QVariant(bool b) : mType(Bool) { mVal.bval = b; }
    QVariant(int i) : mType(Int) { mVal.ival = i; }
    QVariant(long long n) : mType(LongLong) { mVal.llval = n; }
    QVariant(unsigned long long n) : mType(LongLong) { mVal.llval = static_cast<long long>(n); }
    QVariant(double d) : mType(Double) { mVal.dval = d; }
    QVariant(const QString& s) : mType(String), mStr(s) {}
    QVariant(const char* s) : mType(String), mStr(s ? s : "") {}

    bool isValid() const { return mType != Invalid; }
    Type type() const { return mType; }
    bool toBool() const { return mType==Bool ? mVal.bval : mType==Int ? mVal.ival!=0 : !mStr.empty(); }
    int toInt(bool* ok=nullptr) const { if(ok) *ok=(mType==Int||mType==Double); return mType==Int?mVal.ival:(int)mVal.dval; }
    double toDouble(bool* ok=nullptr) const { if(ok) *ok=(mType==Double||mType==Int); return mType==Double?mVal.dval:(double)mVal.ival; }
    QString toString() const { return mType==String ? QString(mStr) : QString(); }
};

// ---------------------------------------------------------------------------
// Java-style iterators (QSetIterator, QListIterator, QLinkedListIterator)
// ---------------------------------------------------------------------------
template<typename Container>
struct QIterator {
    const Container& c;
    typename Container::const_iterator it;
    explicit QIterator(const Container& cont) : c(cont), it(cont.begin()) {}
    bool hasNext() const { return it != c.end(); }
    bool hasPrevious() const { return it != c.begin(); }
    typename Container::value_type next() { return *it++; }
    typename Container::value_type previous() { return *--it; }
    typename Container::value_type peekNext() const { return *it; }
    typename Container::value_type peekPrevious() const { auto tmp = it; return *--tmp; }
    void toFront() { it = c.begin(); }
    void toBack()  { it = c.end(); }
};

template<typename T> using QSetIterator  = QIterator<QSet<T>>;
template<typename T> using QListIterator = QIterator<QList<T>>;
template<typename T> using QLinkedListIterator = QIterator<QLinkedList<T>>;
template<typename T> using QVectorIterator = QIterator<QList<T>>;

// ---------------------------------------------------------------------------
// QDom stubs — XML DOM is unsupported in WASM kernel; all ops are no-ops
// ---------------------------------------------------------------------------
struct QDomNode;
struct QDomElement;

struct QDomNode {
    QDomNode() = default;
    bool isNull() const { return true; }
    bool isElement() const { return false; }
    QString nodeName() const { return {}; }
    QString nodeValue() const { return {}; }
    int nodeType() const { return 0; }
    QDomElement toElement() const;  // defined after QDomElement
    QDomNode firstChild() const { return {}; }
    QDomNode lastChild() const { return {}; }
    QDomNode nextSibling() const { return {}; }
    QDomNode previousSibling() const { return {}; }
    QDomNode parentNode() const { return {}; }
    QDomNode appendChild(const QDomNode&) { return {}; }
    QDomNode insertBefore(const QDomNode&, const QDomNode&) { return {}; }
    QDomNode removeChild(const QDomNode&) { return {}; }
    bool hasChildNodes() const { return false; }
    QDomNode cloneNode(bool = true) const { return {}; }
};

struct QDomElement : public QDomNode {
    QDomElement() = default;
    QString tagName() const { return {}; }
    QString attribute(const QString&, const QString& def = {}) const { return def; }
    void setAttribute(const QString&, const QString&) {}
    void setAttribute(const QString&, int) {}
    void setAttribute(const QString&, double) {}
    bool hasAttribute(const QString&) const { return false; }
    QString text() const { return {}; }
    bool isNull() const { return true; }
    bool isElement() const { return true; }
    QDomNode firstChild() const { return {}; }
    QDomNode firstChildElement(const QString& = {}) const { return {}; }
    QDomNode nextSiblingElement(const QString& = {}) const { return {}; }
    QDomElement appendChild(const QDomNode&) { return {}; }
};

inline QDomElement QDomNode::toElement() const { return QDomElement{}; }

struct QDomProcessingInstruction : public QDomNode {
    QDomProcessingInstruction() = default;
    QString target() const { return {}; }
    QString data() const { return {}; }
};

struct QDomDocument {
    bool setContent(const QString&, bool = false) { return false; }
    bool setContent(const QString&, QString*, int* = nullptr, int* = nullptr) { return false; }
    QString toString(int = 1) const { return {}; }
    QDomElement documentElement() const { return {}; }
    QDomElement createElement(const QString&) { return {}; }
    QDomNode createTextNode(const QString&) { return {}; }
    QDomProcessingInstruction createProcessingInstruction(const QString&, const QString&) { return {}; }
    QDomNode appendChild(const QDomNode&) { return {}; }
    QDomNode importNode(const QDomNode&, bool) { return {}; }
};

// ---------------------------------------------------------------------------
// QDir stub — filesystem operations are no-ops in WASM kernel
// ---------------------------------------------------------------------------
struct QDir {
    QString mPath;
    QDir() = default;
    explicit QDir(const QString& path) : mPath(path) {}
    QString path() const { return mPath; }
    QString absolutePath() const { return mPath; }
    bool exists() const { return false; }
    bool exists(const QString&) const { return false; }
    bool mkpath(const QString&) const { return true; }
    bool mkdir(const QString&) const { return true; }
    static QChar separator() { return QChar('/'); }
    static QString currentPath() { return QString("."); }
    static bool setCurrent(const QString&) { return true; }
    QString filePath(const QString& f) const { return mPath + "/" + f; }
    QString absoluteFilePath(const QString& f) const { return filePath(f); }
    static QString fromNativeSeparators(const QString& p) { return p; }
    static QString toNativeSeparators(const QString& p) { return p; }
    // Filters enum (subset of QDir::Filters)
    enum Filters { Files = 0x2, Dirs = 0x4, AllEntries = 0x7, NoDotAndDotDot = 0x1000 };
    // entryList — filesystem is not available in WASM
    QStringList entryList(int /*filters*/ = AllEntries, int /*sort*/ = 0) const { return {}; }
    QStringList entryList(const QStringList& /*nameFilters*/, int /*filters*/ = AllEntries, int /*sort*/ = 0) const { return {}; }
};

// ---------------------------------------------------------------------------
// QUrl stub — URL handling not available in WASM kernel
// ---------------------------------------------------------------------------
struct QUrl {
    QUrl() = default;
    explicit QUrl(const QString& s) : mStr(s) {}
    QString toString() const { return mStr; }
    QString host() const { return {}; }
    int port(int def = -1) const { return def; }
    QString path() const { return {}; }
    QString scheme() const { return {}; }
    bool isValid() const { return false; }
    bool isEmpty() const { return mStr.empty(); }
    static QUrl fromLocalFile(const QString& s) { return QUrl(s); }
    static QString toPercentEncoding(const QString& s,
        const QString& /*exclude*/ = {},
        const QString& /*include*/ = {}) { return s; }
private:
    QString mStr;
};

// ---------------------------------------------------------------------------
// QNetworkRequest / QNetworkReply stubs — network not available in WASM
// ---------------------------------------------------------------------------
struct QNetworkRequest {
    enum KnownHeaders { ContentTypeHeader=0, ContentLengthHeader=1, LocationHeader=2,
                        LastModifiedHeader=3, CookieHeader=4, SetCookieHeader=5 };
    QNetworkRequest() = default;
    explicit QNetworkRequest(const QUrl& url) : mUrl(url) {}
    QUrl url() const { return mUrl; }
    void setUrl(const QUrl& url) { mUrl = url; }
    void setHeader(KnownHeaders, const QVariant&) {}
    void setRawHeader(const QByteArray&, const QByteArray&) {}
private:
    QUrl mUrl;
};

struct QNetworkReply : public QObject {
    enum NetworkError { NoError=0, ConnectionRefusedError=1, RemoteHostClosedError=2,
                        HostNotFoundError=3, TimeoutError=4, OperationCanceledError=5 };
    NetworkError error() const { return ConnectionRefusedError; }
    QString errorString() const { return QString("not available in WASM"); }
    bool isFinished() const { return true; }
    QByteArray readAll() { return {}; }
    void abort() {}
    void deleteLater() { delete this; }
};

struct QNetworkAccessManager : public QObject {
    QNetworkReply* get(const QNetworkRequest&) { return new QNetworkReply(); }
    QNetworkReply* post(const QNetworkRequest&, const QByteArray&) { return new QNetworkReply(); }
};

#endif // QTCOMPAT_H
