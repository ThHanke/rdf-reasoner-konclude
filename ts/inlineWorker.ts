/**
 * Inline Worker shim — runs the Konclude WASM module in the current thread
 * instead of spawning a nested Web Worker.
 *
 * Use this when the consumer already runs inside a Web Worker (nested workers
 * are fragile or unsupported under Vite dev server and some browsers).
 *
 * Usage:
 *   const worker = createInlineWorker(koncludeModuleUrl);
 *   const reasoner = new RdfReasoner({ worker });
 *
 * The returned object implements the subset of the Worker interface that
 * RdfReasoner relies on (addEventListener, removeEventListener, postMessage,
 * terminate).
 */

type Listener = (event: any) => void;

interface KoncludeModule {
  KoncludeReasoner: new () => KoncludeReasonerInstance;
  _malloc(bytes: number): number;
  _free(ptr: number): void;
  HEAPU8: Uint8Array;
}

interface KoncludeReasonerInstance {
  reset(): void;
  loadTripleBuffer(
    triplePtr: number, tripleCount: number,
    strPtr: number, strBytes: number,
    forRealization: boolean,
  ): void;
  classification(): void;
  realization(): void;
  consistency(): boolean;
  buildInferredTripleBuffer(): number;
  buildPropertyTripleBuffer(): number;
  getInferredTripleBufferPtr(): number;
  buildUnsatisfiableClassBuffer(): string;
  isSubClassOf(sub: string, sup: string): boolean;
  isInstanceOf(indi: string, cls: string): boolean;
  isSatisfiableClass(cls: string): boolean;
  getSubClassJustification(sub: string, sup: string): string;
  hasNativeJustification(sub: string, sup: string): boolean;
  getAxiomsForConceptTag(tag: number): string;
  getAxiomsForRoleTag(tag: number): string;
  getJustificationByType(sub: string, sup: string, type: number): string;
  hasJustificationByType(sub: string, sup: string, type: number): boolean;
  delete?(): void;
}

export function createInlineWorker(koncludeModuleUrl: string | URL): Worker {
  const listeners = new Map<string, Set<Listener>>();
  let mod: KoncludeModule | null = null;
  let reasoner: KoncludeReasonerInstance | null = null;

  function emit(type: string, event: any): void {
    for (const fn of listeners.get(type) ?? []) {
      try { fn(event); } catch (e) { console.error("[inlineWorker] listener threw", e); }
    }
  }

  console.debug("[inlineWorker] creating, url:", String(koncludeModuleUrl));

  const initPromise: Promise<KoncludeModule> = (async () => {
    console.debug("[inlineWorker] importing konclude.mjs…");
    const factory = await import(/* @vite-ignore */ String(koncludeModuleUrl));
    console.debug("[inlineWorker] factory loaded, calling create…");
    const create = factory.default ?? factory;
    const m = await create({ print: () => {}, printErr: (msg: string) => console.debug("[konclude]", msg) }) as KoncludeModule;
    mod = m;
    console.debug("[inlineWorker] WASM ready, emitting ready");
    queueMicrotask(() => emit("message", { data: { type: "ready" } }));
    return m;
  })();

  initPromise.catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[inlineWorker] init failed:", message);
    queueMicrotask(() => {
      emit("message", { data: { type: "error", error: message } });
      emit("error", { message });
    });
  });

  function getOrCreateReasoner(m: KoncludeModule): KoncludeReasonerInstance {
    if (!reasoner) reasoner = new m.KoncludeReasoner();
    return reasoner;
  }

  async function handleMessage(msg: any): Promise<void> {
    const { id, method, args } = msg;
    console.debug("[inlineWorker] handleMessage:", method, "id:", id);
    try {
      const m = await initPromise;
      const r = getOrCreateReasoner(m);
      let result: unknown;

      switch (method) {
        case "loadTripleBuffer": {
          r.reset();
          const tripleAB = args[0] as ArrayBuffer;
          const strTableAB = args[1] as ArrayBuffer;
          const forRealization = (args[2] as boolean) ?? false;
          const tripleCount = tripleAB.byteLength / 12;
          console.debug("[inlineWorker] loadTripleBuffer:", tripleCount, "triples, forRealization:", forRealization);
          const triplePtr = m._malloc(tripleAB.byteLength);
          const strTablePtr = m._malloc(strTableAB.byteLength);
          try {
            m.HEAPU8.set(new Uint8Array(tripleAB), triplePtr);
            m.HEAPU8.set(new Uint8Array(strTableAB), strTablePtr);
            r.loadTripleBuffer(triplePtr, tripleCount, strTablePtr, strTableAB.byteLength, forRealization);
          } finally {
            m._free(triplePtr);
            m._free(strTablePtr);
          }
          result = true;
          break;
        }
        case "classification":
          console.debug("[inlineWorker] classification start");
          result = r.classification();
          console.debug("[inlineWorker] classification done");
          break;
        case "realization":
          console.debug("[inlineWorker] realization start");
          result = r.realization();
          console.debug("[inlineWorker] realization done");
          break;
        case "consistency":
          result = r.consistency();
          break;
        case "getInferredTripleBuffer": {
          const len = r.buildInferredTripleBuffer();
          console.debug("[inlineWorker] getInferredTripleBuffer len:", len);
          if (len > 0) {
            const ptr = r.getInferredTripleBufferPtr();
            const copy = m.HEAPU8.slice(ptr, ptr + len);
            emit("message", { data: { id, result: copy.buffer } });
            return;
          }
          const empty = new ArrayBuffer(8);
          new DataView(empty).setUint32(0, 4, true);
          emit("message", { data: { id, result: empty } });
          return;
        }
        case "getPropertyTripleBuffer": {
          const len = r.buildPropertyTripleBuffer();
          if (len > 0) {
            const ptr = r.getInferredTripleBufferPtr();
            const copy = m.HEAPU8.slice(ptr, ptr + len);
            emit("message", { data: { id, result: copy.buffer } });
            return;
          }
          const empty = new ArrayBuffer(8);
          new DataView(empty).setUint32(0, 4, true);
          emit("message", { data: { id, result: empty } });
          return;
        }
        case "getUnsatisfiableClassBuffer":
          result = r.buildUnsatisfiableClassBuffer();
          break;
        case "isSubClassOf":
          result = r.isSubClassOf(args[0] as string, args[1] as string);
          break;
        case "isInstanceOf":
          result = r.isInstanceOf(args[0] as string, args[1] as string);
          break;
        case "isSatisfiableClass":
          result = r.isSatisfiableClass(args[0] as string);
          break;
        case "getSubClassJustification":
          result = r.getSubClassJustification(args[0] as string, args[1] as string);
          break;
        case "hasNativeJustification":
          result = r.hasNativeJustification(args[0] as string, args[1] as string);
          break;
        case "getAxiomsForConceptTag":
          result = r.getAxiomsForConceptTag(args[0] as number);
          break;
        case "getAxiomsForRoleTag":
          result = r.getAxiomsForRoleTag(args[0] as number);
          break;
        case "getJustificationByType":
          result = r.getJustificationByType(args[0] as string, args[1] as string, args[2] as number);
          break;
        case "hasJustificationByType":
          result = r.hasJustificationByType(args[0] as string, args[1] as string, args[2] as number);
          break;
        default:
          emit("message", { data: { id, error: `Unknown method: ${method}` } });
          return;
      }
      console.debug("[inlineWorker] response id:", id, "method:", method);
      emit("message", { data: { id, result } });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[inlineWorker] handleMessage error:", method, message);
      emit("message", { data: { id, error: message } });
    }
  }

  const shim = {
    addEventListener(type: string, fn: Listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener(type: string, fn: Listener) {
      listeners.get(type)?.delete(fn);
    },
    postMessage(msg: any, _transfer?: any) {
      handleMessage(msg);
    },
    terminate() {
      if (reasoner?.delete) reasoner.delete();
      reasoner = null;
      mod = null;
      listeners.clear();
    },
  };

  return shim as unknown as Worker;
}
