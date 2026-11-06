// The actual packaged Express entry, behind the same capability/port boundary
// as the dev frontend. Never bind or probe an ordinary user service.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { guardNamespacedRequest, isolatedEnvironment, requireHarnessConfig, verifyOwnedStateRoot } from './harness-config.mjs';
import { webSourceIdentity } from '../../scripts/web-runtime-identity.mjs';

const cfg = requireHarnessConfig();
const root = verifyOwnedStateRoot(process.env.STHANG_STUDIO_STATE_ROOT || '', cfg);
const expected = isolatedEnvironment(cfg, root);
for (const key of Object.keys(expected).filter((key) =>
  ['LOCALAPPDATA', 'APPDATA', 'XDG_CONFIG_HOME', 'TEMP', 'TMP', 'TMPDIR', 'PORT', 'WEB_ORIGIN', 'NODE_OPTIONS'].includes(key)
  || /^(STHANG_|GEMINI_|GOOGLE_|OPENAI_|ANTHROPIC_|LOCAL_TIMING_)/.test(key))) {
  if (process.env[key] !== expected[key]) throw new Error('Packaged browser environment is not isolated.');
}
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const webRoot = path.join(repo, 'apps/web/dist');
const identity = JSON.parse(fs.readFileSync(path.join(webRoot, 'studio-web-identity.json'), 'utf8'));
if (identity.buildId !== webSourceIdentity(repo).buildId) throw new Error('Packaged browser build is stale. Run npm run build.');
process.env.PORT = String(cfg.webPort);
process.env.STHANG_STUDIO_WEB_ROOT = webRoot;
const { config, stateRootDir } = await import('../../apps/server/dist/config.js');
if (fs.realpathSync(stateRootDir) !== root || config.port !== cfg.webPort || config.webOrigin !== cfg.webOrigin || config.geminiApiKey || config.contributionEndpoint || config.analyticsEndpoint) throw new Error('Packaged browser resolved configuration is not isolated.');
for (const key of ['uploadDir', 'workingDir', 'exportDir', 'dataFile', 'profileFile', 'cacheDir', 'userFontDir', 'historyDir', 'proposalDir', 'jobsFile',
  'analyticsIdentityFile', 'contributionDir', 'contributionStateFile', 'contributionTempDir', 'updateDir', 'versionsDir'] as const) {
  const relative = path.relative(root, path.resolve(config[key]));
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new Error('Packaged browser storage escaped its root.');
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('Packaged browser storage contains a symlink.');
  }
}
const listen = http.Server.prototype.listen;
http.Server.prototype.listen = function (this: http.Server, ...args: unknown[]) {
  if (args[0] !== cfg.webPort || args[1] !== '127.0.0.1') throw new Error('Packaged browser attempted an unexpected listener.');
  const listeners = this.listeners('request');
  if (listeners.length !== 1) throw new Error('Packaged browser request listener is unexpected.');
  this.removeAllListeners('request');
  this.on('request', guardNamespacedRequest(function (this: http.Server, request, response) { listeners[0].call(this, request, response); }, cfg));
  this.once('error', () => process.exit(1));
  this.once('listening', () => {
    const address = this.address();
    if (!address || typeof address === 'string' || address.address !== '127.0.0.1' || address.port !== cfg.webPort) throw new Error('Packaged browser bound an unexpected address.');
    console.log(`STUDIO_BROWSER_WEB_READY ${JSON.stringify({ marker: cfg.marker, pid: process.pid, root, address: address.address, port: address.port })}`);
  });
  return Reflect.apply(listen, this, args);
} as typeof listen;
await import('../../apps/server/dist/index.js');
