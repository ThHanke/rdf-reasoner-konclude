// tests/bench/meta.mjs — run metadata so results can be judged and reproduced.
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { cpus, loadavg, totalmem } from 'node:os';
import { join } from 'node:path';

const git = (args, cwd) => { const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : 'unknown'; };
const dockerId = (image) => {
  const r = spawnSync('docker', ['image', 'inspect', '--format', '{{.Id}}', image], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim().replace('sha256:', '').slice(0, 12) : 'unavailable';
};

export function collectMeta(repoRoot) {
  const wasm = join(repoRoot, 'dist/konclude.wasm');
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  const cmake = existsSync(join(repoRoot, 'emscripten.cmake')) ? readFileSync(join(repoRoot, 'emscripten.cmake'), 'utf8') : '';
  const pool = /PTHREAD_POOL_SIZE=(\d+)/.exec(cmake)?.[1] ?? 'unknown';
  return {
    date: new Date().toISOString().slice(0, 10),
    package: `${pkg.name} ${pkg.version}`,
    gitSha: git(['rev-parse', '--short', 'HEAD'], repoRoot),
    gitDirty: git(['status', '--porcelain', '--untracked-files=no'], repoRoot) !== '',
    vendorSha: git(['rev-parse', '--short', 'HEAD'], join(repoRoot, 'vendor/konclude')),
    wasmSha: existsSync(wasm) ? createHash('sha256').update(readFileSync(wasm)).digest('hex').slice(0, 12) : 'missing',
    cpu: cpus()[0]?.model ?? 'unknown',
    cores: cpus().length,
    memGB: Math.round(totalmem() / 2 ** 30),
    loadAvgAtStart: loadavg()[0].toFixed(2),
    node: process.version,
    poolSize: pool,
    koncludeImage: dockerId('konclude/konclude:latest'),
    hermitImage: dockerId('obolibrary/odkfull:latest'),
  };
}

export function renderMeta(m, extra = {}) {
  const e = { ...m, ...extra };
  return [
    '```',
    `Date:      ${e.date}`,
    `Package:   ${e.package}  (git ${e.gitSha}${e.gitDirty ? ', dirty tree' : ''}; vendor/konclude ${e.vendorSha})`,
    `WASM:      dist/konclude.wasm sha256 ${e.wasmSha}; pthread pool ${e.poolSize}; Konclude processors ${e.processorCount ?? 'n/a'}`,
    `Native:    Konclude ${e.nativeVersion ?? 'unknown'} (image ${e.koncludeImage}); threads ${e.nativeThreads ?? 'unknown'} (-w AUTO)`,
    `HermiT:    ${e.robotVersion ?? 'unknown'} (image ${e.hermitImage})`,
    `Host:      ${e.cpu}, ${e.cores} cores, ${e.memGB} GB; load average at start ${e.loadAvgAtStart}`,
    `Runtime:   Node ${e.node}`,
    '```',
  ].join('\n');
}
