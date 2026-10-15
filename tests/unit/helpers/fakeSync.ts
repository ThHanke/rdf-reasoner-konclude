/**
 * Test double for the worker `sync` response: tracks the synced content like the C++ digest does
 * (order, duplicates and interned ids do not matter) and reports `{changed, added, removed, generation}`.
 */
export interface FakeSyncResult {
  changed: boolean;
  added: number;
  removed: number;
  generation: number;
}

function decodeTriples(tripleAB: ArrayBuffer, strAB: ArrayBuffer): Set<string> {
  const dv = new DataView(strAB);
  const count = strAB.byteLength >= 4 ? dv.getUint32(0, true) : 0;
  const headerBytes = 4 + 4 * count;
  const dataLen = strAB.byteLength - headerBytes;
  const bytes = new Uint8Array(strAB, Math.min(headerBytes, strAB.byteLength));
  const dec = new TextDecoder();
  const term = (id: number): string => {
    const tag = id >>> 30;
    const idx = id & 0x3fffffff;
    const start = dv.getUint32(4 + 4 * idx, true);
    const end = idx + 1 < count ? dv.getUint32(4 + 4 * (idx + 1), true) : dataLen;
    return `${tag}:${dec.decode(bytes.slice(start, end))}`;
  };
  const ids = new Uint32Array(tripleAB);
  const out = new Set<string>();
  for (let i = 0; i + 2 < ids.length; i += 3) out.add(`${term(ids[i])}|${term(ids[i + 1])}|${term(ids[i + 2])}`);
  return out;
}

export function createFakeSync(): (req: unknown) => FakeSyncResult {
  let generation = 0;
  let current: Set<string> | null = null;
  return (req: unknown): FakeSyncResult => {
    const args = (req as { args?: unknown[] }).args;
    if (!args || !(args[0] instanceof ArrayBuffer) || !(args[1] instanceof ArrayBuffer)) {
      return { changed: false, added: 0, removed: 0, generation };
    }
    const next = decodeTriples(args[0], args[1]);
    if (current === null) {
      current = next;
      return { changed: true, added: next.size, removed: 0, generation: ++generation };
    }
    let added = 0;
    for (const t of next) if (!current.has(t)) added++;
    const removed = current.size - (next.size - added);
    if (added === 0 && removed === 0) return { changed: false, added: 0, removed: 0, generation };
    current = next;
    return { changed: true, added, removed, generation: ++generation };
  };
}
