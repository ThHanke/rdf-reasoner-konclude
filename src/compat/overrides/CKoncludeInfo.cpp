// WASM stub for CKoncludeInfo — replaces the vendor version which requires
// revision-git.h (a generated file absent from the WASM build).
#include "CKoncludeInfo.h"
#include "KoncludeSettings.h"

namespace Konclude {

    CKoncludeInfo::CKoncludeInfo() {}

    QString CKoncludeInfo::getKoncludeName()          { return KONCLUDE_NAME; }
    QString CKoncludeInfo::getKoncludeNameExtension() { return KONCLUDE_NAME_EXTENSION; }
    QString CKoncludeInfo::getKoncludeDescription()   { return KONCLUDE_DESCRIPTION; }
    QString CKoncludeInfo::getKoncludeVersionString()      { return QString("%1.%2.%3").arg(KONCLUDE_VERSION_MAJOR).arg(KONCLUDE_VERSION_MINOR).arg(KONCLUDE_VERSION_BUILD); }
    QString CKoncludeInfo::getKoncludeCompilationDateString() { return QString(__DATE__); }
    QString CKoncludeInfo::getKoncludeBitPlatformString()  { return QString("%1-bit").arg(sizeof(void*)*8); }

    int CKoncludeInfo::getKoncludeMajorVersionNumber()   { return KONCLUDE_VERSION_MAJOR; }
    int CKoncludeInfo::getKoncludeMinorVersionNumber()   { return KONCLUDE_VERSION_MINOR; }
    int CKoncludeInfo::getKoncludeBuildVersionNumber()   { return KONCLUDE_VERSION_BUILD; }
    int CKoncludeInfo::getKoncludeRevisionVersionNumber(){ return 0; }

}; // end namespace Konclude
