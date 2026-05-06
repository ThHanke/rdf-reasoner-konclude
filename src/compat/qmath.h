#pragma once
// qmath.h stub — Qt math helpers mapped to std equivalents
#include <cmath>
inline double qSqrt(double x) { return std::sqrt(x); }
inline double qPow(double x, double y) { return std::pow(x, y); }
inline double qLog(double x) { return std::log(x); }
inline double qExp(double x) { return std::exp(x); }
inline double qSin(double x) { return std::sin(x); }
inline double qCos(double x) { return std::cos(x); }
inline double qAtan2(double y, double x) { return std::atan2(y, x); }
inline double qAbs(double x) { return std::abs(x); }
inline float qSqrt(float x) { return std::sqrt(x); }
inline float qPow(float x, float y) { return std::pow(x, y); }
#ifndef M_PI
#  define M_PI 3.14159265358979323846
#endif
#define Q_PI M_PI
