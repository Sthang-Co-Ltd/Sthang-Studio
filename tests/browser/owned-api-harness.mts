import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addTestNamespace, isolatedEnvironment, requireHarnessConfig, safeFrontendUrl, verifyOwnedStateRoot, type HarnessConfig } from './harness-config.mjs';

export interface OwnedApiExpected { pid: number; marker: string; root: string; port: number }
export interface OwnedReady extends OwnedApiExpected { type: 'studio-browser-ready'; address: '127.0.0.1' }
export interface OwnedApi { child: ChildProcess; ready: OwnedReady; assertAlive(): void; close(): Promise<void> }
const proofs = new WeakMap<ChildProcess, { ready: OwnedReady; controller: AbortController; invalid: Error | null }>();
export function assertOwnedReady(message: unknown, expected: OwnedApiExpected): asserts message is OwnedReady {
  const value = message as Partial<OwnedReady> | null;
  if (!value || value.type !== 'studio-browser-ready' || value.pid !== expected.pid || value.marker !== expected.marker
    || value.root !== expected.root || value.port !== expected.port || value.address !== '127.0.0.1') throw new Error('Owned browser API readiness identity does not match.');
}
function alive(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null || child.killed) throw new Error('The owned browser API child is no longer alive.');
  const proof = proofs.get(child);
  if (proof?.invalid) throw proof.invalid;
}
export function waitForOwnedReady(child: ChildProcess, expected: OwnedApiExpected, timeoutMs = 60_000): Promise<OwnedReady> {
  if (child.pid !== expected.pid) return Promise.reject(new Error('Owned browser API child PID does not match.'));
  try { alive(child); } catch (error) { return Promise.reject(error); }
  return new Promise((resolve, reject) => {
    let settled = false;
    const controller = new AbortController();
    const fail = (reason: Error) => {
      const proof = proofs.get(child);
      if (proof) proof.invalid = reason;
      controller.abort(reason);
      if (!settled) { settled = true; clearTimeout(timer); child.off('message', onMessage); reject(reason); }
    };
    const onMessage = (message: unknown) => {
      try { assertOwnedReady(message, expected); }
      catch (error) { fail(error as Error); return; }
      try { alive(child); } catch (error) { fail(error as Error); return; }
      settled = true;
      clearTimeout(timer);
      child.off('message', onMessage);
      proofs.set(child, { ready: message, controller, invalid: null });
      resolve(message);
    };
    const timer = setTimeout(() => fail(new Error('Timed out waiting for owned browser API listening proof.')), timeoutMs);
    child.on('message', onMessage);
    child.once('error', (error) => fail(error));
    child.once('exit', () => fail(new Error('Owned browser API exited; readiness is invalid.')));
  });
}
export async function verifyOwnedHealth(child: ChildProcess, expected: OwnedApiExpected, cfg: HarnessConfig, fetcher: typeof fetch = fetch): Promise<void> {
  const proof = proofs.get(child);
  if (!proof) throw new Error('Owned listening proof is required before any browser API HTTP request.');
  assertOwnedReady(proof.ready, expected);
  const canonical = requireHarnessConfig({ STHANG_BROWSER_API_PORT: String(cfg.apiPort), STHANG_BROWSER_WEB_PORT: String(cfg.webPort), STHANG_BROWSER_RUN_ROOT: cfg.runRoot, STHANG_BROWSER_RUN_MARKER: cfg.marker });
  if (cfg.apiOrigin !== canonical.apiOrigin || cfg.webOrigin !== canonical.webOrigin || cfg.namespace !== canonical.namespace || expected.pid !== child.pid
    || expected.marker !== cfg.marker || expected.port !== cfg.apiPort || expected.root !== verifyOwnedStateRoot(expected.root, cfg)) throw new Error('Owned browser health configuration does not match its listening proof.');
  const probes = [
    { url: `${cfg.apiOrigin}${addTestNamespace('/api/health', cfg)}`, frontend: false },
    { url: safeFrontendUrl(`${cfg.webOrigin}/api/health`, cfg), frontend: false },
    { url: safeFrontendUrl(`${cfg.webOrigin}/studio-web-identity.json`, cfg), frontend: true },
  ];
  for (const probe of probes) {
    alive(child);
    const response = await fetcher(probe.url, { redirect: 'error', signal: AbortSignal.any([proof.controller.signal, AbortSignal.timeout(1000)]) });
    alive(child);
    if (!response.ok || response.headers.get('X-Sthang-Studio-Activation') !== cfg.marker) throw new Error('Owned browser API/frontend health identity does not match.');
    const body = await response.json();
    alive(child);
    if (probe.frontend ? body.schemaVersion !== 1 || body.service !== 'sthang-studio-web' || !/^[a-f0-9]{64}$/.test(body.buildId) : body.ok !== true) throw new Error('Owned browser API/frontend health payload is invalid.');
  }
}
async function closeChild(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Owned browser API child did not exit; its state was retained.')), 5000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill();
  });
}
export async function startOwnedApi(root: string, options: { config?: HarnessConfig; entry?: string; timeoutMs?: number } = {}): Promise<OwnedApi> {
  const cfg = options.config || requireHarnessConfig();
  const ownedRoot = verifyOwnedStateRoot(root, cfg);
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const entry = options.entry || path.join(repoRoot, 'tests', 'browser', 'owned-api-child.mts');
  const child = spawn(process.execPath, ['--import', 'tsx', entry], { cwd: repoRoot, env: isolatedEnvironment(cfg, ownedRoot), stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  let output = '';
  child.stdout?.on('data', (chunk) => { output = (output + String(chunk)).slice(-16_000); });
  child.stderr?.on('data', (chunk) => { output = (output + String(chunk)).slice(-16_000); });
  try {
    if (!child.pid) throw new Error('Owned browser API could not spawn.');
    const expected = { pid: child.pid, marker: cfg.marker, root: ownedRoot, port: cfg.apiPort };
    const ready = await waitForOwnedReady(child, expected, options.timeoutMs);
    await verifyOwnedHealth(child, expected, cfg);
    return { child, ready, assertAlive: () => alive(child), close: () => closeChild(child) };
  } catch (error) {
    await closeChild(child);
    throw new Error(`${error instanceof Error ? error.message : 'Owned API startup failed.'}\n${output}`);
  }
}
export async function stopOwnedApi(handle: OwnedApi): Promise<void> { await handle.close(); }
