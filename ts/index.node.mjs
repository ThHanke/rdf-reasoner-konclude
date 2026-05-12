// index.node.mjs — Node.js entry via "node" export condition
import { Worker as NodeWorker } from 'node:worker_threads';

class NodeWorkerShim {
  constructor(url, _opts) {
    const rawPath = url instanceof URL ? url.pathname : String(url);
    const path = rawPath.replace(/worker\.js$/, 'worker-node.mjs');
    this._w = new NodeWorker(path);
    this._map = new Map();
  }
  postMessage(msg) { this._w.postMessage(msg); }
  addEventListener(type, fn) {
    let wrapped;
    if (type === 'message') wrapped = (data) => fn({ data });
    else if (type === 'error') wrapped = (err) => fn({ message: err?.message ?? String(err) });
    else wrapped = fn;
    if (!this._map.has(fn)) this._map.set(fn, new Map());
    this._map.get(fn).set(type, wrapped);
    this._w.on(type, wrapped);
  }
  removeEventListener(type, fn) {
    const wrapped = this._map.get(fn)?.get(type);
    if (wrapped) { this._w.off(type, wrapped); this._map.get(fn).delete(type); }
  }
  terminate() { this._w.terminate(); }
}

if (typeof globalThis.Worker === 'undefined') {
  globalThis.Worker = NodeWorkerShim;
}

export * from './index.js';
