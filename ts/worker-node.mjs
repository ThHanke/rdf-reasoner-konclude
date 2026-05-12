// worker-node.mjs — Node.js worker_threads polyfill for dist/worker.js
import { parentPort } from 'node:worker_threads';

globalThis.self = {
  postMessage: (data) => parentPort.postMessage(data),
  set onmessage(handler) {
    parentPort.on('message', (data) => handler({ data }));
  },
};

await import('./worker.js');
