// owl-reason CLI — file/stdin OWL-DL reasoning via the Konclude WASM kernel.
//
// NOTE: The './index.js' import below resolves to ./index.ts at compile time.
// The postbuild script rewrites it to './index.node.mjs' so the Node.js
// worker_threads polyfill is active at runtime.
import { RdfReasoner, INFERRED_GRAPH_IRI } from "./index.js";

import { readFileSync, writeFileSync } from "node:fs";
import { extname } from "node:path";
import { parseArgs } from "node:util";
import { createRequire } from "node:module";
import { DataFactory, Parser, Store, Writer } from "n3";
import type { Quad } from "@rdfjs/types";

const _require = createRequire(import.meta.url);
const PKG_VERSION = (_require("../package.json") as { version: string }).version;

const USAGE = `\
Usage: owl-reason [options]

Options:
  -i, --input <file>    Input RDF file (.nt .ttl .nq .trig); reads stdin if omitted
  -o, --output <file>   Output file; writes to stdout if omitted
  -m, --mode <mode>     classify | consistency  (default: classify)
  -f, --format <fmt>    Output format: nt | ttl | nq | trig  (default: auto from --input, else nt)
  -v, --version         Print version
  -h, --help            Show this help

Note: --mode consistency is a known incomplete feature (always returns "consistent").
`;

type CliValues = {
  input?: string;
  output?: string;
  mode?: string;
  format?: string;
  version?: boolean;
  help?: boolean;
};

const N3_FORMAT: Record<string, string> = {
  nt: "N-Triples",
  ttl: "Turtle",
  n3: "Turtle",
  nq: "N-Quads",
  trig: "TriG",
};

const N3_MIME: Record<string, string> = {
  "N-Triples": "application/n-triples",
  Turtle: "text/turtle",
  "N-Quads": "application/n-quads",
  TriG: "application/trig",
};

function formatFromExt(filePath: string): string {
  const ext = extname(filePath).replace(".", "").toLowerCase();
  return N3_FORMAT[ext] ?? "N-Triples";
}

function parseRdf(text: string, format: string): Promise<Store> {
  return new Promise((resolve, reject) => {
    const store = new Store();
    const parser = new Parser({ format });
    parser.parse(text, (err, quad) => {
      if (err) return reject(err);
      if (quad) store.addQuad(quad as Quad);
      else resolve(store);
    });
  });
}

function writeRdf(quads: Quad[], format: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const writer = new Writer({ format: N3_MIME[format] ?? "application/n-triples" });
    for (const q of quads) writer.addQuad(q.subject, q.predicate, q.object);
    writer.end((err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function run(argv: string[]): Promise<number> {
  let values!: CliValues;

  try {
    const result = parseArgs({
      args: argv,
      options: {
        input:   { type: "string",  short: "i" },
        output:  { type: "string",  short: "o" },
        mode:    { type: "string",  short: "m" },
        format:  { type: "string",  short: "f" },
        version: { type: "boolean", short: "v" },
        help:    { type: "boolean", short: "h" },
      },
      allowPositionals: false,
    });
    values = result.values as unknown as CliValues;
  } catch (e) {
    process.stderr.write(`Error: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }

  if (values.version) {
    process.stdout.write(PKG_VERSION + "\n");
    return 0;
  }

  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const mode = values.mode ?? "classify";
  if (mode !== "classify" && mode !== "consistency") {
    process.stderr.write(`Error: --mode must be "classify" or "consistency", got "${mode}"\n`);
    return 2;
  }

  // Read input
  let inputText: string;
  if (values.input) {
    try {
      inputText = readFileSync(values.input, "utf8");
    } catch (e) {
      process.stderr.write(
        `Error: cannot read "${values.input}": ${e instanceof Error ? e.message : String(e)}\n`,
      );
      return 2;
    }
  } else if ((process.stdin as NodeJS.ReadStream).isTTY) {
    process.stderr.write(
      "Error: no --input given and stdin is a TTY. Pipe a file or use --input.\n",
    );
    return 2;
  } else {
    try {
      inputText = await readStdin();
    } catch (e) {
      process.stderr.write(
        `Error: reading stdin: ${e instanceof Error ? e.message : String(e)}\n`,
      );
      return 2;
    }
  }

  // Detect format: --format overrides; else auto-detect from --input extension; else N-Triples
  const fmt = values.format
    ? (N3_FORMAT[values.format.toLowerCase()] ?? "N-Triples")
    : values.input
      ? formatFromExt(values.input)
      : "N-Triples";

  // Parse RDF
  let store: Store;
  try {
    store = await parseRdf(inputText, fmt);
  } catch (e) {
    process.stderr.write(
      `Error: parse failed (format=${fmt}): ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return 2;
  }

  const reasoner = new RdfReasoner();
  try {
    await reasoner.ready;

    if (mode === "consistency") {
      const consistent = await reasoner.checkConsistency(store);
      process.stdout.write(consistent ? "consistent\n" : "inconsistent\n");
      return consistent ? 0 : 1;
    }

    await reasoner.reason(store);
    const inferred = store.getQuads(
      null,
      null,
      null,
      DataFactory.namedNode(INFERRED_GRAPH_IRI),
    ) as Quad[];
    const outputText = await writeRdf(inferred, fmt);

    if (values.output) {
      try {
        writeFileSync(values.output, outputText);
      } catch (e) {
        process.stderr.write(
          `Error: cannot write "${values.output}": ${e instanceof Error ? e.message : String(e)}\n`,
        );
        return 2;
      }
    } else {
      process.stdout.write(outputText);
    }
    return 0;
  } catch (e) {
    process.stderr.write(
      `Error: reasoning failed: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return 2;
  } finally {
    reasoner.terminate();
  }
}

run(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((e) => {
    process.stderr.write(`Unexpected error: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(2);
  });
