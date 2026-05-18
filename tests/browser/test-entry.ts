/**
 * Browser test entry point — loaded as a <script type="module"> by Vite.
 *
 * Imports RdfReasoner (from the TS source so Vite can bundle n3 and intern),
 * then exposes the classes on `window` for Playwright's page.evaluate() calls.
 */
import { RdfReasoner, INFERRED_GRAPH_IRI } from "../../ts/index.ts";
import { DataFactory, Store, Parser } from "n3";

declare global {
  interface Window {
    RdfReasoner: typeof RdfReasoner;
    INFERRED_GRAPH_IRI: string;
    DataFactory: typeof DataFactory;
    Store: typeof Store;
    Parser: typeof Parser;
  }
}

window.RdfReasoner = RdfReasoner;
window.INFERRED_GRAPH_IRI = INFERRED_GRAPH_IRI;
window.DataFactory = DataFactory;
window.Store = Store;
window.Parser = Parser;
