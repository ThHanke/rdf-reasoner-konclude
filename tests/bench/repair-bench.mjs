// tests/bench/repair-bench.mjs — repair() benchmark matrix: ontologies x clash types, one fresh process per case.
// usage: node tests/bench/repair-bench.mjs [--out results.jsonl] [--timeout ms] [--only substring]   (run), then
//        node tests/bench/repair-bench.mjs --report results.jsonl                                      (Markdown table)
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../..");
const FX = (f) => join(ROOT, "tests/fixtures", f);
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};

const BASES = [
  { name: "LUBM schema", files: ["lubm.nt"] },
  { name: "Roberts family", files: ["roberts-family.nt"] },
  { name: "PMDco", files: ["pmdco.nt"] },
  { name: "GALEN", files: ["galen.nt"] },
  { name: "LUBM schema + data", files: ["lubm.nt", "lubm-data.nt"] },
];
const CLASHES = ["disjoint", "unsat", "cardinality", "three"];

if (opt("--report")) {
  const all = readFileSync(opt("--report"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const meta = all.find((r) => r.meta)?.meta;
  const rows = all.filter((r) => !r.meta);
  const f = (v) => (v === undefined || v === null ? "-" : v);
  const lines = [
    "| Ontology | Quads | Clash | repair() s | checks | avg check ms | recycles | peak heap MB | justif. | repairs | verified | applied OK | status |",
    "|---|---:|---|---:|---:|---:|---:|---:|---|---|---|---|---|",
  ];
  for (const r of rows) {
    const status = r.error
      ? `ERROR ${r.error}`
      : r.timedOut
        ? "TIMEOUT (process)"
        : r.baseConsistent === false
          ? "INVALID: base inconsistent"
          : r.incomplete
            ? `incomplete: ${r.reason}`
            : "complete";
    lines.push(
      `| ${r.base} | ${f(r.quads)} | ${r.clash} | ${r.repairMs !== undefined ? (r.repairMs / 1000).toFixed(1) : "-"} | ${f(r.checks)} | ${f(r.avgCheckMs)} | ${f(r.recycles)} | ${f(r.maxHeapMB)} | ${f(r.justifications?.join("/"))} | ${f(r.repairs?.join("/"))} | ${f(r.allVerified)} | ${f(r.consistentAfterApply)} | ${status} |`,
    );
  }
  if (meta)
    console.log(
      [
        "```",
        ...Object.entries(meta).map(([k, v]) => `${k.padEnd(10)} ${v}`),
        "```",
        "",
      ].join("\n"),
    );
  console.log(lines.join("\n"));
  console.log(
    "\n`incomplete: solution-cap` = the `maxRepairs` cap (10) was reached, not a failure; `incomplete: deadline` = the call stopped at its wall-clock budget and returned what it had.",
  );
  process.exit(0);
}

const outFile = opt("--out", "/tmp/repair-bench.jsonl");
const timeout = Number(opt("--timeout", "240000"));
const only = opt("--only", "");
const sh = (cmd, a) =>
  spawnSync(cmd, a, { encoding: "utf8", cwd: ROOT }).stdout.trim();
const os = await import("node:os");
writeFileSync(
  outFile,
  JSON.stringify({
    meta: {
      Date: new Date().toISOString().slice(0, 10),
      Package: `rdf-reasoner-konclude ${JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version} (git ${sh("git", ["rev-parse", "--short", "HEAD"])}${sh("git", ["status", "--porcelain", "--", "ts"]) ? ", ts/ modified" : ""})`,
      Host: `${os.cpus()[0].model.trim()}, ${os.cpus().length} cores, ${Math.round(os.totalmem() / 2 ** 30)} GB; load average at start ${os
        .loadavg()
        .map((x) => x.toFixed(2))
        .join(" ")}`,
      Runtime: `Node ${process.version}`,
      Budget: `repair() timeout ${timeout} ms per case, maxRepairs 10, one fresh process per case`,
    },
  }) + "\n",
);
const cases = [
  ...BASES.flatMap((b) =>
    CLASHES.map((c) => ({ base: b.name, files: b.files, clash: c })),
  ),
  { base: "PMDco", files: ["pmdco.nt"], clash: "bfo" },
].filter((c) => `${c.base} ${c.clash}`.includes(only));
console.error(
  `load average at start: ${(await import("node:os"))
    .loadavg()
    .map((x) => x.toFixed(2))
    .join(" ")}; ${cases.length} cases; repair timeout ${timeout} ms`,
);
for (const c of cases) {
  const t0 = Date.now();
  const p = spawnSync(
    "node",
    [
      join(__dirname, "repair-case.mjs"),
      ROOT,
      c.files.map(FX).join(","),
      c.clash,
      String(timeout),
    ],
    { encoding: "utf8", timeout: timeout + 240000, maxBuffer: 1 << 28 },
  );
  const line = (p.stdout ?? "")
    .split("\n")
    .find((l) => l.startsWith("RESULT "));
  const rec = line
    ? JSON.parse(line.slice(7))
    : {
        clash: c.clash,
        error: `no result (exit ${p.status}, signal ${p.signal})`,
        timedOut: p.error?.code === "ETIMEDOUT",
      };
  rec.base = c.base;
  appendFileSync(outFile, JSON.stringify(rec) + "\n");
  console.error(
    `[${((Date.now() - t0) / 1000).toFixed(0)}s] ${c.base} / ${c.clash}: ${rec.error ?? (rec.incomplete ? "incomplete " + rec.reason : "ok")} repair=${rec.repairMs}ms checks=${rec.checks}`,
  );
}
console.error("done");
