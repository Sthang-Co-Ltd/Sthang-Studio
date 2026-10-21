// Test-only entry. Never import Studio until all state and vault paths are owned.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { guardNamespacedRequest, isolatedEnvironment, requireHarnessConfig, verifyOwnedStateRoot } from './harness-config.mjs';

if (!process.send || process.platform === 'darwin') throw new Error('Owned browser API requires IPC and an isolatable credential store.');
// Playwright can retire a worker before its afterAll finishes. This child owns
// no lifetime beyond that worker; register before any awaited app imports.
process.once('disconnect', () => process.exit(0));
if (!process.connected) process.exit(0);
const cfg = requireHarnessConfig();
const root = verifyOwnedStateRoot(process.env.STHANG_STUDIO_STATE_ROOT || '', cfg);
const expectedEnv = isolatedEnvironment(cfg, root);
for (const name of ['LOCALAPPDATA', 'APPDATA', 'XDG_CONFIG_HOME', 'TEMP', 'TMP', 'TMPDIR', 'PORT', 'WEB_ORIGIN', 'STHANG_STUDIO_ENV_FILE', 'STHANG_STUDIO_ACTIVATION_ID',
  'STHANG_STUDIO_WEB_ROOT', 'NODE_OPTIONS', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'STHANG_CONTRIBUTION_ENDPOINT', 'STHANG_ANALYTICS_ENDPOINT', 'LOCAL_TIMING_PYTHON']) {
  if (process.env[name] !== expectedEnv[name]) throw new Error(`Owned browser API environment is not isolated: ${name}.`);
}
const { config, stateRootDir } = await import('../../apps/server/src/config.js');
if (fs.realpathSync(stateRootDir) !== root || config.port !== cfg.apiPort || config.webOrigin !== cfg.webOrigin || config.geminiApiKey || config.contributionEndpoint || config.analyticsEndpoint) throw new Error('Owned browser API resolved configuration is not isolated.');
for (const name of ['uploadDir', 'workingDir', 'exportDir', 'dataFile', 'profileFile', 'cacheDir', 'userFontDir', 'historyDir', 'proposalDir', 'jobsFile',
  'analyticsIdentityFile', 'contributionDir', 'contributionStateFile', 'contributionTempDir', 'updateDir', 'versionsDir'] as const) {
  const candidate = path.resolve(config[name]);
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new Error(`Owned browser API storage escaped its root: ${name}.`);
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error(`Owned browser API storage contains a symlink: ${name}.`);
  }
}
const { profileStore } = await import('../../apps/server/src/services/profile-store.js');
await profileStore.patch({ preferences: { autosaveDelayMs: 60_000, privacyUpgradeNoticeVersion: '0.8' } });

const originalListen = http.Server.prototype.listen;
http.Server.prototype.listen = function (this: http.Server, ...args: unknown[]) {
  if (args[0] !== cfg.apiPort || args[1] !== '127.0.0.1') throw new Error('Owned browser API attempted an unexpected listener.');
  const listeners = this.listeners('request');
  if (listeners.length !== 1) throw new Error('Owned browser API request listener is unexpected.');
  this.removeAllListeners('request');
  this.on('request', guardNamespacedRequest(function (this: http.Server, request, response) { listeners[0].call(this, request, response); }, cfg));
  this.once('error', (error) => { console.error('Owned browser API bind failed:', error); process.exit(1); });
  this.once('listening', () => {
    const address = this.address();
    if (!address || typeof address === 'string' || address.address !== '127.0.0.1' || address.port !== cfg.apiPort) throw new Error('Owned browser API bound an unexpected address.');
    process.send!({ type: 'studio-browser-ready', pid: process.pid, marker: cfg.marker, root, address: address.address, port: address.port });
  });
  return Reflect.apply(originalListen, this, args);
} as typeof originalListen;
await import('../../apps/server/src/index.js');
