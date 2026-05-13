/**
 * Unit tests for ts/worker.ts
 *
 * Strategy: `./konclude.mjs` does not contain a real WASM build at test time,
 * so we mock it with `vi.mock`.  Because `vi.mock` factories are hoisted to
 * the top of the file by Vitest's transform, all mock variables and global
 * setup must be created via `vi.hoisted()` so they are available at hoist-time.
 *
 * We test the exported `handleMessage` function directly rather than spinning
 * up a real Worker thread.  `self.postMessage` is patched on `globalThis`
 * (which equals `self` in Node) before the module is imported.
 */

import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// ---------------------------------------------------------------------------
// Step 1: Hoist all mock state + global Worker shim setup.
// vi.hoisted runs BEFORE vi.mock factories AND before module imports.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
  // --- Web Worker global shim ---
  // Node has no `self`; set it up here so worker.ts module initialisation
  // (which calls `self.postMessage` and `self.onmessage = ...`) doesn't throw.
  const postMessage = vi.fn<[unknown], void>();
  (globalThis as Record<string, unknown>).postMessage = postMessage;
  (globalThis as Record<string, unknown>).self = globalThis;

  // --- WASM module mock state ---
  const loadNTriples = vi.fn<[string], void>();
  const loadTripleBuffer = vi.fn<[number, number, number, number], void>();
  const classify = vi.fn<[], boolean>().mockReturnValue(true);
  const isConsistent = vi.fn<[], boolean>().mockReturnValue(true);
  const getInferredNTriples = vi
    .fn<[], string>()
    .mockReturnValue("<http://a> <http://b> <http://c> .\n");
  const buildInferredTripleBuffer = vi.fn<[], number>().mockReturnValue(0);
  const getInferredTripleBufferPtr = vi.fn<[], number>().mockReturnValue(0);
  const reset = vi.fn<[], void>();
  const del = vi.fn<[], void>();

  // Must use a regular function (not arrow) so it can be called with `new`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const KoncludeReasoner = vi.fn(function (this: any) {
    this.loadNTriples = loadNTriples;
    this.loadTripleBuffer = loadTripleBuffer;
    this.classify = classify;
    this.isConsistent = isConsistent;
    this.getInferredNTriples = getInferredNTriples;
    this.buildInferredTripleBuffer = buildInferredTripleBuffer;
    this.getInferredTripleBufferPtr = getInferredTripleBufferPtr;
    this.reset = reset;
    this.delete = del;
  });

  // Minimal heap mock: HEAPU8.set() must not throw.
  const heapu8 = new Uint8Array(4096);
  const malloc = vi.fn<[number], number>().mockReturnValue(0);
  const free = vi.fn<[number], void>();

  const createModule = vi.fn().mockResolvedValue({
    KoncludeReasoner,
    HEAPU8: heapu8,
    _malloc: malloc,
    _free: free,
  });

  return {
    postMessage,
    loadNTriples,
    loadTripleBuffer,
    classify,
    isConsistent,
    getInferredNTriples,
    buildInferredTripleBuffer,
    getInferredTripleBufferPtr,
    heapu8,
    reset,
    del,
    malloc,
    free,
    KoncludeReasoner,
    createModule,
  };
});

// ---------------------------------------------------------------------------
// Step 2: Mock the WASM module.
// Path is relative to the source file: ts/worker.ts imports './konclude.mjs'.
// From the test file (tests/unit/) that resolves to ../../ts/konclude.mjs.
// ---------------------------------------------------------------------------

vi.mock("../../ts/konclude.mjs", () => ({
  default: mocks.createModule,
}));

// ---------------------------------------------------------------------------
// Step 3: Import the module under test.
// By now globalThis.self and the WASM mock are both in place.
// ---------------------------------------------------------------------------

import { handleMessage } from "../../ts/worker.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(
  id: number,
  method: string,
  args: unknown[] = [],
): MessageEvent<{ id: number; method: string; args: unknown[] }> {
  return { data: { id, method, args } } as MessageEvent<{
    id: number;
    method: string;
    args: unknown[];
  }>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("worker handleMessage", () => {
  beforeEach(() => {
    mocks.postMessage.mockClear();
    mocks.loadNTriples.mockClear();
    mocks.loadTripleBuffer.mockClear();
    mocks.classify.mockClear();
    mocks.isConsistent.mockClear();
    mocks.getInferredNTriples.mockClear();
    mocks.buildInferredTripleBuffer.mockClear();
    mocks.getInferredTripleBufferPtr.mockClear();
    mocks.reset.mockClear();
    mocks.del.mockClear();
    mocks.malloc.mockClear();
    mocks.free.mockClear();
  });

  it("happy path: loadTripleBuffer → calls C++ loadTripleBuffer with ptr/count", async () => {
    const tripleBuffer = new ArrayBuffer(36); // 3 triples × 12 bytes each
    const strTableBuffer = new ArrayBuffer(8);
    await handleMessage(makeEvent(10, "loadTripleBuffer", [tripleBuffer, strTableBuffer]));

    expect(mocks.loadTripleBuffer).toHaveBeenCalledWith(
      expect.any(Number), // triplePtr
      3,                  // tripleCount = 36 / 12
      expect.any(Number), // strTablePtr
      8,                  // strTableLen
    );
    expect(mocks.malloc).toHaveBeenCalledTimes(2);
    expect(mocks.free).toHaveBeenCalledTimes(2);
    expect(mocks.postMessage).toHaveBeenCalledWith({ id: 10, result: true });
  });

  it("happy path: loadNTriples → posts {id, result: true}", async () => {
    const ntriples = "<http://a> <http://b> <http://c> .\n";
    await handleMessage(makeEvent(1, "loadNTriples", [ntriples]));

    expect(mocks.loadNTriples).toHaveBeenCalledWith(ntriples);
    expect(mocks.postMessage).toHaveBeenCalledWith({ id: 1, result: true });
  });

  it("happy path: classify → posts {id, result: true}", async () => {
    mocks.classify.mockReturnValueOnce(true);
    await handleMessage(makeEvent(2, "classify"));

    expect(mocks.classify).toHaveBeenCalledOnce();
    expect(mocks.postMessage).toHaveBeenCalledWith({ id: 2, result: true });
  });

  it("happy path: isConsistent → posts {id, result: true}", async () => {
    mocks.isConsistent.mockReturnValueOnce(true);
    await handleMessage(makeEvent(3, "isConsistent"));

    expect(mocks.isConsistent).toHaveBeenCalledOnce();
    expect(mocks.postMessage).toHaveBeenCalledWith({ id: 3, result: true });
  });

  it("happy path: getInferredNTriples → posts {id, result: ntriplesString}", async () => {
    const expected = "<http://a> <http://b> <http://c> .\n";
    mocks.getInferredNTriples.mockReturnValueOnce(expected);
    await handleMessage(makeEvent(4, "getInferredNTriples"));

    expect(mocks.getInferredNTriples).toHaveBeenCalledOnce();
    expect(mocks.postMessage).toHaveBeenCalledWith({ id: 4, result: expected });
  });

  it("happy path: getInferredTripleBuffer → calls build/ptr, posts {id, result: ArrayBuffer}", async () => {
    // Write a minimal valid combined buffer into heapu8 at offset 0 (ptr returned by mock).
    // Combined: [strTableLen=4:u32][count=0:u32]  — 8 bytes total, 0 triples.
    const len = 8;
    const tmp = new DataView(mocks.heapu8.buffer, 0, len);
    tmp.setUint32(0, 4, true);  // strTableLen = 4
    tmp.setUint32(4, 0, true);  // count = 0

    mocks.buildInferredTripleBuffer.mockReturnValueOnce(len);
    mocks.getInferredTripleBufferPtr.mockReturnValueOnce(0);

    await handleMessage(makeEvent(11, "getInferredTripleBuffer"));

    expect(mocks.buildInferredTripleBuffer).toHaveBeenCalledOnce();
    expect(mocks.getInferredTripleBufferPtr).toHaveBeenCalledOnce();

    // postMessage called with transferred ArrayBuffer
    expect(mocks.postMessage).toHaveBeenCalledOnce();
    const [msgArg, transferArg] = mocks.postMessage.mock.calls[0] as [unknown, unknown[]];
    const response = msgArg as { id: number; result: ArrayBuffer };
    expect(response.id).toBe(11);
    expect(response.result).toBeInstanceOf(ArrayBuffer);
    expect(response.result.byteLength).toBe(len);
    expect(transferArg).toEqual([response.result]);
  });

  it("error path: unknown method → posts {id, error: 'Unknown method: X'}", async () => {
    await handleMessage(makeEvent(5, "nonExistentMethod"));

    expect(mocks.postMessage).toHaveBeenCalledWith({
      id: 5,
      error: "Unknown method: nonExistentMethod",
    });
  });

  it("edge path: awaiting initPromise before dispatch works correctly", async () => {
    // The module-level initPromise was already resolved when the module was
    // imported (mockResolvedValue resolves immediately via microtask).
    // Calling handleMessage here exercises the `await initPromise` code path.
    mocks.classify.mockReturnValueOnce(false);
    await handleMessage(makeEvent(6, "classify"));

    expect(mocks.postMessage).toHaveBeenCalledWith({ id: 6, result: false });
  });

  it("error path: C++ method throws → posts {id, error}", async () => {
    mocks.loadNTriples.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    await handleMessage(makeEvent(9, "loadNTriples", ["<http://a> <http://b> <http://c> .\n"]));

    expect(mocks.postMessage).toHaveBeenCalledWith({ id: 9, error: "boom" });
  });

  it("reset: calls delete() on the current reasoner instance", async () => {
    // Ensure an instance exists by calling loadNTriples first.
    await handleMessage(makeEvent(7, "loadNTriples", [""]));
    mocks.del.mockClear();
    mocks.postMessage.mockClear();

    await handleMessage(makeEvent(8, "reset"));

    expect(mocks.del).toHaveBeenCalledOnce();
    expect(mocks.postMessage).toHaveBeenCalledWith({ id: 8, result: true });
  });
});
