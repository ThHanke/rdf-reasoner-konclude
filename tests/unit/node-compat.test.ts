import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Inline NodeWorkerShim logic for unit testing (mirrors ts/index.node.mjs)
import { Worker as NodeWorker } from 'node:worker_threads';

class NodeWorkerShim {
  _w: InstanceType<typeof NodeWorker>;
  _map: Map<Function, Map<string, Function>>;

  constructor(url: URL | string, _opts?: unknown) {
    const rawPath = url instanceof URL ? url.pathname : String(url);
    const path = rawPath.replace(/worker\.js$/, 'worker-node.mjs');
    this._w = new NodeWorker(path);
    this._map = new Map();
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

describe('NodeWorkerShim', () => {
  it('wraps message events as { data }', () => {
    const received: unknown[] = [];
    const shim = { _map: new Map<Function, Map<string, Function>>() } as unknown as NodeWorkerShim;
    shim._w = { on: (_t: string, cb: Function) => { received.push(cb); }, off: () => {}, terminate: () => {} } as unknown as InstanceType<typeof NodeWorker>;

    const fn = vi.fn();
    NodeWorkerShim.prototype.addEventListener.call(shim, 'message', fn);
    const [wrapped] = received as Function[];
    wrapped('hello');
    expect(fn).toHaveBeenCalledWith({ data: 'hello' });
  });

  it('wraps error events as { message }', () => {
    const received: unknown[] = [];
    const shim = { _map: new Map<Function, Map<string, Function>>() } as unknown as NodeWorkerShim;
    shim._w = { on: (_t: string, cb: Function) => { received.push(cb); }, off: () => {}, terminate: () => {} } as unknown as InstanceType<typeof NodeWorker>;

    const fn = vi.fn();
    NodeWorkerShim.prototype.addEventListener.call(shim, 'error', fn);
    const [wrapped] = received as Function[];
    wrapped(new Error('boom'));
    expect(fn).toHaveBeenCalledWith({ message: 'boom' });
  });

  it('removeEventListener removes the correct wrapper', () => {
    const registered: Array<[string, Function]> = [];
    const removed: Array<[string, Function]> = [];
    const shim = { _map: new Map<Function, Map<string, Function>>() } as unknown as NodeWorkerShim;
    shim._w = {
      on: (t: string, cb: Function) => registered.push([t, cb]),
      off: (t: string, cb: Function) => removed.push([t, cb]),
      terminate: () => {},
    } as unknown as InstanceType<typeof NodeWorker>;

    const fn = vi.fn();
    NodeWorkerShim.prototype.addEventListener.call(shim, 'message', fn);
    NodeWorkerShim.prototype.removeEventListener.call(shim, 'message', fn);

    expect(removed.length).toBe(1);
    expect(removed[0][0]).toBe('message');
    expect(removed[0][1]).toBe(registered[0][1]);
  });
});

describe('globalThis.Worker guard', () => {
  it('does not overwrite Worker if already defined', () => {
    const original = (globalThis as any).Worker;
    const sentinel = {};
    (globalThis as any).Worker = sentinel;

    // Simulate the guard from index.node.mjs
    if (typeof globalThis.Worker === 'undefined') {
      (globalThis as any).Worker = NodeWorkerShim;
    }

    expect((globalThis as any).Worker).toBe(sentinel);
    (globalThis as any).Worker = original;
  });
});
