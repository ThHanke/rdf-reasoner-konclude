/**
 * Stall recovery in RdfReasoner._call: a blocking call without any sign of life is retried once
 * on a fresh Worker after replaying the current store's load and state calls.
 */
import { describe, expect, it } from "vitest";
import { RdfReasoner, ReasonerStalledError } from "../../ts/index.js";

type Handler = (e: { data: unknown }) => void;

class FakeWorker {
  static instances: FakeWorker[] = [];
  static heapBytes = 1024 ** 3;
  static syncResult: unknown = true;
  readonly received: string[] = [];
  private handlers = new Set<Handler>();
  terminated = false;
  constructor(private readonly stallOn: string | null) {
    FakeWorker.instances.push(this);
    setTimeout(() => this.emit({ type: "ready" }), 0);
  }
  addEventListener(type: string, h: Handler) { if (type === "message") this.handlers.add(h); }
  removeEventListener(type: string, h: Handler) { if (type === "message") this.handlers.delete(h); }
  terminate() { this.terminated = true; }
  postMessage(req: { id: number; method: string; args: unknown[] }) {
    this.received.push(req.method);
    if (req.method === this.stallOn) return; // never answers
    const heap = req.method === "realization" || req.method === "classification" ? FakeWorker.heapBytes : undefined;
    setTimeout(() => this.emit({ id: req.id, result: req.method === "sync" ? FakeWorker.syncResult : true, heapBytes: heap }), 0);
  }
  private emit(data: unknown) { for (const h of [...this.handlers]) h({ data }); }
}

function makeReasoner(stallOnFirst: string | null, stallTimeoutMs = 60) {
  FakeWorker.instances = [];
  let n = 0;
  const r = new RdfReasoner({
    workerFactory: () => new FakeWorker(n++ === 0 ? stallOnFirst : null) as unknown as Worker,
    stallTimeoutMs,
  });
  return r;
}

const bufs = () => [new ArrayBuffer(12), new ArrayBuffer(8), true, "fp"];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = (r: RdfReasoner, m: string, a: unknown[] = [], t?: Transferable[]) => (r as any)._call(m, a, t);

describe("RdfReasoner stall recovery", () => {
  it("retries a stalled realization on a fresh Worker after replaying load and state calls", async () => {
    const r = makeReasoner("realization");
    await r.ready;
    const b = bufs();
    await call(r, "sync", b, [b[0] as ArrayBuffer, b[1] as ArrayBuffer]);
    await call(r, "classification");
    await expect(call(r, "realization")).resolves.toBe(true);
    expect(FakeWorker.instances).toHaveLength(2);
    expect(FakeWorker.instances[0].terminated).toBe(true);
    expect(FakeWorker.instances[1].received).toEqual(["sync", "classification", "realization"]);
  });

  it("retries a stalled load itself without replay", async () => {
    const r = makeReasoner("sync");
    await r.ready;
    const b = bufs();
    await expect(call(r, "sync", b, [b[0] as ArrayBuffer, b[1] as ArrayBuffer])).resolves.toBe(true);
    expect(FakeWorker.instances[1].received).toEqual(["sync"]);
  });

  it("surfaces ReasonerStalledError when the retry stalls too", async () => {
    FakeWorker.instances = [];
    const r = new RdfReasoner({ workerFactory: () => new FakeWorker("realization") as unknown as Worker, stallTimeoutMs: 40 });
    await r.ready;
    const b = bufs();
    await call(r, "sync", b, [b[0] as ArrayBuffer, b[1] as ArrayBuffer]);
    await expect(call(r, "realization")).rejects.toBeInstanceOf(ReasonerStalledError);
    expect(FakeWorker.instances).toHaveLength(2);
  });

  it("does not watch non-blocking calls and can be disabled", async () => {
    const r = makeReasoner("getInferredTripleBuffer", 30);
    await r.ready;
    const p = call(r, "getInferredTripleBuffer");
    const winner = await Promise.race([p.then(() => "resolved", () => "rejected"), new Promise((res) => setTimeout(() => res("still-pending"), 150))]);
    expect(winner).toBe("still-pending");
    expect(FakeWorker.instances).toHaveLength(1);
  });

  it("keeps a call alive while the Worker keeps sending trace messages", async () => {
    FakeWorker.instances = [];
    const r = new RdfReasoner({ workerFactory: () => new FakeWorker("realization") as unknown as Worker, stallTimeoutMs: 80 });
    await r.ready;
    const w = FakeWorker.instances[0];
    const p = call(r, "realization");
    const beat = setInterval(() => (w as unknown as { emit: (d: unknown) => void }).emit({ type: "log", msg: "x" }), 20);
    setTimeout(() => { clearInterval(beat); (w as unknown as { emit: (d: unknown) => void }).emit({ id: 0, result: true }); }, 300);
    await expect(p).resolves.toBe(true);
    expect(FakeWorker.instances).toHaveLength(1);
  });

  it("recycles the Worker when changed content arrives after the heap grew past the threshold", async () => {
    FakeWorker.instances = [];
    FakeWorker.syncResult = { changed: true, generation: 1 };
    FakeWorker.heapBytes = 3 * 1024 ** 3;
    const r = new RdfReasoner({ workerFactory: () => new FakeWorker(null) as unknown as Worker, recycleHeapBytes: 2 * 1024 ** 3 });
    await r.ready;
    let b = bufs();
    await call(r, "sync", b, [b[0] as ArrayBuffer, b[1] as ArrayBuffer]);
    await call(r, "realization");
    expect(FakeWorker.instances).toHaveLength(1);
    b = bufs();
    await call(r, "sync", b, [b[0] as ArrayBuffer, b[1] as ArrayBuffer]);
    expect(FakeWorker.instances).toHaveLength(2);
    expect(FakeWorker.instances[0].terminated).toBe(true);
    expect(FakeWorker.instances[1].received).toEqual(["sync"]); // content re-synced into the fresh Worker
    FakeWorker.heapBytes = 1024 ** 3;
    FakeWorker.syncResult = true;
  });

  it("keeps the Worker when the content is unchanged, even with a large heap", async () => {
    FakeWorker.instances = [];
    FakeWorker.heapBytes = 3 * 1024 ** 3;
    FakeWorker.syncResult = { changed: false, generation: 1 };
    const r = new RdfReasoner({ workerFactory: () => new FakeWorker(null) as unknown as Worker, recycleHeapBytes: 2 * 1024 ** 3 });
    await r.ready;
    for (let i = 0; i < 2; i++) {
      const b = bufs();
      await call(r, "sync", b, [b[0] as ArrayBuffer, b[1] as ArrayBuffer]);
      await call(r, "realization");
    }
    expect(FakeWorker.instances).toHaveLength(1);
    FakeWorker.heapBytes = 1024 ** 3;
    FakeWorker.syncResult = true;
  });

  it("keeps the Worker while the heap stays small", async () => {
    FakeWorker.instances = [];
    FakeWorker.heapBytes = 1024 ** 3;
    const r = new RdfReasoner({ workerFactory: () => new FakeWorker(null) as unknown as Worker, recycleHeapBytes: 2 * 1024 ** 3 });
    await r.ready;
    for (let i = 0; i < 2; i++) {
      const b = bufs();
      await call(r, "sync", b, [b[0] as ArrayBuffer, b[1] as ArrayBuffer]);
      await call(r, "realization");
    }
    expect(FakeWorker.instances).toHaveLength(1);
  });
});
