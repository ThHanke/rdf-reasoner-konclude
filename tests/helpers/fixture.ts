import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Parser } from "n3";
import type { Quad } from "@rdfjs/types";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function loadFixture(name: string): Quad[] {
  const raw = readFileSync(join(__dirname, "../fixtures", name), "utf8");
  const cleaned = raw
    .split("\n")
    .filter((line) => line.trim() && !line.trim().startsWith("#"))
    .join("\n");

  const parser = new Parser({ format: "N-Triples" });
  const quads: Quad[] = [];
  parser.parse(cleaned, (err, quad) => {
    if (err) throw err;
    if (quad) quads.push(quad as Quad);
  });
  return quads;
}
