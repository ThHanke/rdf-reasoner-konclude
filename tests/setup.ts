import { Worker as NodeWorker } from 'node:worker_threads';

if (typeof globalThis.Worker === 'undefined') {
  class NodeWorkerShim {
    private _w: InstanceType<typeof NodeWorker>;
    private _map = new Map<Function, Map<string, Function>>();

    constructor(_url: URL | string, _opts?: unknown) {
      const path = new URL('../dist/worker-node.mjs', import.meta.url).pathname;
      this._w = new NodeWorker(path);
    }
    postMessage(msg: unknown) { this._w.postMessage(msg); }
    addEventListener(type: string, fn: Function) {
      let wrapped: Function;
      if (type === 'message') wrapped = (data: unknown) => fn({ data });
      else if (type === 'error') wrapped = (err: unknown) => fn({ message: (err as Error)?.message ?? String(err) });
      else wrapped = fn;
      if (!this._map.has(fn)) this._map.set(fn, new Map());
      this._map.get(fn)!.set(type, wrapped);
      (this._w as any).on(type, wrapped);
    }
    removeEventListener(type: string, fn: Function) {
      const wrapped = this._map.get(fn)?.get(type);
      if (wrapped) { (this._w as any).off(type, wrapped); this._map.get(fn)!.delete(type); }
    }
    terminate() { this._w.terminate(); }
  }
  (globalThis as any).Worker = NodeWorkerShim;
}
