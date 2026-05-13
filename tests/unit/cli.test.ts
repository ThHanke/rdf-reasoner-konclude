/**
 * Unit tests for ts/cli.ts
 *
 * Strategy: mock RdfReasoner and node:fs so no real Worker/WASM is spun up.
 * The exported `run(argv)` function is called directly; tests inspect the
 * return value (exit code) and captured stdout/stderr writes.
 *
 * vi.hoisted() is used so mock state is available before vi.mock factories run.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Step 1: Hoist mock state
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
  const stdoutWrite = vi.fn<[string | Uint8Array], boolean>().mockReturnValue(true);
  const stderrWrite = vi.fn<[string | Uint8Array], boolean>().mockReturnValue(true);

  const reasonerReady = Promise.resolve();
  const reasonMock = vi.fn<[unknown], Promise<void>>().mockResolvedValue(undefined);
  const checkConsistencyMock = vi.fn<[unknown], Promise<boolean>>().mockResolvedValue(true);
  const terminateMock = vi.fn<[], void>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const RdfReasonerMock = vi.fn(function (this: any) {
    this.ready = reasonerReady;
    this.reason = reasonMock;
    this.checkConsistency = checkConsistencyMock;
    this.terminate = terminateMock;
  });

  const readFileSyncMock = vi.fn<[unknown, unknown], string>();
  const writeFileSyncMock = vi.fn<[unknown, unknown], void>();

  return {
    stdoutWrite,
    stderrWrite,
    reasonMock,
    checkConsistencyMock,
    terminateMock,
    RdfReasonerMock,
    readFileSyncMock,
    writeFileSyncMock,
  };
});

// ---------------------------------------------------------------------------
// Step 2: Mock dependencies
// ---------------------------------------------------------------------------

vi.mock("../../ts/index.js", () => ({
  RdfReasoner: mocks.RdfReasonerMock,
  INFERRED_GRAPH_IRI: "urn:konclude:inferred",
}));

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    readFileSync: mocks.readFileSyncMock,
    writeFileSync: mocks.writeFileSyncMock,
  };
});

// ---------------------------------------------------------------------------
// Step 3: Import module under test
// ---------------------------------------------------------------------------

import { run } from "../../ts/cli.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SIMPLE_NT = `<http://a> <http://b> <http://c> .
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("cli run()", () => {
  beforeEach(() => {
    vi.spyOn(process.stdout, "write").mockImplementation(mocks.stdoutWrite);
    vi.spyOn(process.stderr, "write").mockImplementation(mocks.stderrWrite);
    mocks.readFileSyncMock.mockReset();
    mocks.writeFileSyncMock.mockReset();
    mocks.reasonMock.mockReset();
    mocks.checkConsistencyMock.mockReset();
    mocks.terminateMock.mockReset();
    mocks.stdoutWrite.mockReset();
    mocks.stderrWrite.mockReset();
    mocks.reasonMock.mockResolvedValue(undefined);
    mocks.checkConsistencyMock.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("--help prints usage and returns 0", async () => {
    const code = await run(["--help"]);
    expect(code).toBe(0);
    const out = mocks.stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(out).toMatch(/owl-reason/);
    expect(out).toMatch(/--input/);
  });

  it("-h is alias for --help", async () => {
    const code = await run(["-h"]);
    expect(code).toBe(0);
    expect(mocks.stdoutWrite).toHaveBeenCalled();
  });

  it("--version prints a version string and returns 0", async () => {
    const code = await run(["--version"]);
    expect(code).toBe(0);
    const out = mocks.stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(out).toMatch(/\d+\.\d+\.\d+/);
  });

  it("classify: reads file, calls reason(), returns 0", async () => {
    mocks.readFileSyncMock.mockReturnValue(SIMPLE_NT);
    const code = await run(["--input", "ont.nt"]);
    expect(code).toBe(0);
    expect(mocks.readFileSyncMock).toHaveBeenCalledWith("ont.nt", "utf8");
    expect(mocks.RdfReasonerMock).toHaveBeenCalledOnce();
    expect(mocks.reasonMock).toHaveBeenCalledOnce();
    expect(mocks.terminateMock).toHaveBeenCalledOnce();
  });

  it("classify with --output writes to file instead of stdout", async () => {
    mocks.readFileSyncMock.mockReturnValue(SIMPLE_NT);
    const code = await run(["--input", "ont.nt", "--output", "out.nt"]);
    expect(code).toBe(0);
    expect(mocks.writeFileSyncMock).toHaveBeenCalledWith("out.nt", expect.any(String));
  });

  it("consistency: consistent → stdout 'consistent', returns 0", async () => {
    mocks.readFileSyncMock.mockReturnValue(SIMPLE_NT);
    mocks.checkConsistencyMock.mockResolvedValue(true);
    const code = await run(["--input", "ont.nt", "--mode", "consistency"]);
    expect(code).toBe(0);
    const out = mocks.stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(out).toContain("consistent");
    expect(out).not.toContain("inconsistent");
  });

  it("consistency: inconsistent → stdout 'inconsistent', returns 1", async () => {
    mocks.readFileSyncMock.mockReturnValue(SIMPLE_NT);
    mocks.checkConsistencyMock.mockResolvedValue(false);
    const code = await run(["--input", "ont.nt", "--mode", "consistency"]);
    expect(code).toBe(1);
    const out = mocks.stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(out).toContain("inconsistent");
  });

  it("nonexistent --input file → stderr message, returns 2", async () => {
    mocks.readFileSyncMock.mockImplementation(() => {
      const err = new Error("ENOENT: no such file or directory");
      (err as NodeJS.ErrnoException).code = "ENOENT";
      throw err;
    });
    const code = await run(["--input", "missing.nt"]);
    expect(code).toBe(2);
    const err = mocks.stderrWrite.mock.calls.map((c) => c[0]).join("");
    expect(err).toMatch(/cannot read/);
  });

  it("invalid --mode → stderr message, returns 2", async () => {
    const code = await run(["--input", "ont.nt", "--mode", "badmode"]);
    expect(code).toBe(2);
    const err = mocks.stderrWrite.mock.calls.map((c) => c[0]).join("");
    expect(err).toMatch(/--mode/);
  });

  it("parse error (invalid RDF content) → stderr message, returns 2", async () => {
    mocks.readFileSyncMock.mockReturnValue("this is not valid RDF @@@");
    const code = await run(["--input", "ont.nt"]);
    expect(code).toBe(2);
    const err = mocks.stderrWrite.mock.calls.map((c) => c[0]).join("");
    expect(err).toMatch(/parse failed/);
  });

  it("unknown flag → stderr message, returns 2", async () => {
    const code = await run(["--unknown-flag"]);
    expect(code).toBe(2);
    const err = mocks.stderrWrite.mock.calls.map((c) => c[0]).join("");
    expect(err).toMatch(/Error/);
  });

  it("reasoning failure → stderr message, terminate still called, returns 2", async () => {
    mocks.readFileSyncMock.mockReturnValue(SIMPLE_NT);
    mocks.reasonMock.mockRejectedValue(new Error("WASM crash"));
    const code = await run(["--input", "ont.nt"]);
    expect(code).toBe(2);
    const err = mocks.stderrWrite.mock.calls.map((c) => c[0]).join("");
    expect(err).toMatch(/reasoning failed/);
    expect(mocks.terminateMock).toHaveBeenCalledOnce();
  });

  it("detects Turtle format from .ttl extension (no parse error)", async () => {
    mocks.readFileSyncMock.mockReturnValue("@prefix : <http://x.org/> . :A a :Class .");
    const code = await run(["--input", "ont.ttl"]);
    expect(code).toBe(0);
  });
});
