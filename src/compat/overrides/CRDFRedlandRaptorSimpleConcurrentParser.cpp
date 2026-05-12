/*
 *		Copyright (C) 2013-2015, 2019 by the Konclude Developer Team.
 *		LGPLv3 — see vendor/konclude/ for full license text.
 *
 *		WASM override: replaces vendor/konclude/Source/Parser/CRDFRedlandRaptorSimpleConcurrentParser.cpp.
 *		Concurrent parsing removed — WASM is single-threaded; delegates directly to parent.
 */
#ifdef KONCLUDE_REDLAND_INTEGRATION

#include "Parser/CRDFRedlandRaptorSimpleConcurrentParser.h"


namespace Konclude {

	namespace Parser {



		CRDFRedlandRaptorSimpleConcurrentParser::CRDFRedlandRaptorSimpleConcurrentParser(COntologyBuilder* ontologyBuilder, CTRIPLES_DATA_UPDATE_TYPE updateType, QString redlandParsingFormat, CConfiguration* configuration) : CRDFRedlandRaptorParser(ontologyBuilder, updateType, redlandParsingFormat, configuration) {
		}


		CRDFRedlandRaptorSimpleConcurrentParser::~CRDFRedlandRaptorSimpleConcurrentParser() {
		}


		bool CRDFRedlandRaptorSimpleConcurrentParser::parseTriples(const std::string& ntriplesData, const std::string& baseUri) {
			return CRDFRedlandRaptorParser::parseTriples(ntriplesData, baseUri);
		}



	}; // end namespace Parser

}; // end namespace Konclude

#endif // !KONCLUDE_REDLAND_INTEGRATION
