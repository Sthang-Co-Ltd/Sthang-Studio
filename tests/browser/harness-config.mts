import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';

export interface HarnessConfig {
  apiPort: number;
  webPort: number;
  apiOrigin: string;
  webOrigin: string;
  marker: string;
  namespace: string;
  runRoot: string;
}
const runMarkerFile = '.studio-browser-run.json';
const stateMarkerFile = '.studio-browser-state.json';
const samePath = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
function canonicalDirectory(value: string) {
  if (!path.isAbsolute(value) || fs.lstatSync(value).isSymbolicLink()) throw new Error('Browser isolation requires an absolute, non-symlink directory.');
  const canonical = fs.realpathSync(value);
  if (!fs.statSync(canonical).isDirectory()) throw new Error('Browser isolation directory is invalid.');
  return canonical;
}
function inside(parent: string, child: string) {
  const relative = path.relative(parent, child);
  return Boolean(relative) && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}
function readMarker(file: string) {
  if (fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > 4096) throw new Error('Browser isolation marker is invalid.');
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
}
function port(value: string | undefined, name: string) {
  if (!value || !/^\d+$/.test(value)) throw new Error(`${name} is required; start browser tests through scripts/run-browser-tests.mjs.`);
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) throw new Error(`${name} must be an explicit port from 1024 to 65535.`);
  return parsed;
}
export function requireHarnessConfig(env: NodeJS.ProcessEnv = process.env): HarnessConfig {
  const apiPort = port(env.STHANG_BROWSER_API_PORT, 'STHANG_BROWSER_API_PORT');
  const webPort = port(env.STHANG_BROWSER_WEB_PORT, 'STHANG_BROWSER_WEB_PORT');
  if (apiPort === webPort) throw new Error('Browser API and frontend ports must differ.');
  const marker = env.STHANG_BROWSER_RUN_MARKER;
  if (!marker || !/^[a-f0-9]{64}$/.test(marker)) throw new Error('A fresh browser run marker is required.');
  const runRoot = canonicalDirectory(env.STHANG_BROWSER_RUN_ROOT || '');
  const stored = readMarker(path.join(runRoot, runMarkerFile));
  if (stored.type !== 'studio-browser-run' || stored.marker !== marker || stored.apiPort !== apiPort || stored.webPort !== webPort || typeof stored.root !== 'string' || !samePath(stored.root, runRoot)) throw new Error('Browser run ownership does not match.');
  return { apiPort, webPort, apiOrigin: `http://127.0.0.1:${apiPort}`, webOrigin: `http://127.0.0.1:${webPort}`, marker, namespace: `/__studio_browser_${marker}`, runRoot };
}

export async function createHarnessRun(parentDir: string): Promise<HarnessConfig> {
  if (process.platform === 'darwin') throw new Error('Strict browser isolation does not support the macOS Keychain.');
  await fsp.mkdir(parentDir, { recursive: true });
  const runRoot = await fsp.realpath(await fsp.mkdtemp(path.join(parentDir, 'studio-browser-owned-')));
  const marker = crypto.randomBytes(32).toString('hex');
  const reservations: net.Server[] = [];
  try {
    const selected: number[] = [];
    for (let index = 0; index < 2; index++) {
      const reservation = net.createServer();
      reservations.push(reservation);
      await new Promise<void>((resolve, reject) => { reservation.once('error', reject); reservation.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve); });
      const address = reservation.address();
      if (!address || typeof address === 'string' || address.address !== '127.0.0.1' || address.port < 1024) throw new Error('Could not reserve an isolated loopback port.');
      selected.push(address.port);
    }
    await fsp.writeFile(path.join(runRoot, runMarkerFile), JSON.stringify({ type: 'studio-browser-run', marker, root: runRoot, apiPort: selected[0], webPort: selected[1] }), { flag: 'wx', mode: 0o600 });
    return requireHarnessConfig({ STHANG_BROWSER_API_PORT: String(selected[0]), STHANG_BROWSER_WEB_PORT: String(selected[1]), STHANG_BROWSER_RUN_ROOT: runRoot, STHANG_BROWSER_RUN_MARKER: marker });
  } finally {
    await Promise.all(reservations.map((reservation) => new Promise<void>((resolve) => { if (!reservation.listening) return resolve(); reservation.close(() => resolve()); })));
  }
}

export async function prepareOwnedStateRoot(cfg: HarnessConfig, prefix = 'state-'): Promise<string> {
  requireHarnessConfig({ STHANG_BROWSER_API_PORT: String(cfg.apiPort), STHANG_BROWSER_WEB_PORT: String(cfg.webPort), STHANG_BROWSER_RUN_ROOT: cfg.runRoot, STHANG_BROWSER_RUN_MARKER: cfg.marker });
  if (!/^[a-z0-9-]+$/i.test(prefix)) throw new Error('Invalid browser state prefix.');
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(cfg.runRoot, prefix)));
  await fsp.writeFile(path.join(root, stateMarkerFile), JSON.stringify({ type: 'studio-browser-state', marker: cfg.marker, runRoot: cfg.runRoot, root }), { flag: 'wx', mode: 0o600 });
  return verifyOwnedStateRoot(root, cfg);
}
export function verifyOwnedStateRoot(root: string, cfg: HarnessConfig): string {
  const canonical = canonicalDirectory(root);
  if (!inside(cfg.runRoot, canonical)) throw new Error('Browser state is outside its owned run root.');
  const stored = readMarker(path.join(canonical, stateMarkerFile));
  if (stored.type !== 'studio-browser-state' || stored.marker !== cfg.marker || typeof stored.root !== 'string' || typeof stored.runRoot !== 'string'
    || !samePath(stored.root, canonical) || !samePath(stored.runRoot, cfg.runRoot)) throw new Error('Browser state ownership does not match.');
  return canonical;
}
export function isolatedEnvironment(cfg: HarnessConfig, root: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (process.platform === 'darwin') throw new Error('Strict browser isolation does not support the macOS Keychain.');
  const stateRoot = verifyOwnedStateRoot(root, cfg);
  const directories = { LOCALAPPDATA: 'local-app-data', APPDATA: 'app-data', XDG_CONFIG_HOME: 'xdg-config', TEMP: 'tmp', TMP: 'tmp', TMPDIR: 'tmp' };
  const env = { ...base };
  for (const [name, relative] of Object.entries(directories)) {
    const directory = path.join(stateRoot, relative);
    fs.mkdirSync(directory, { recursive: true });
    if (!inside(stateRoot, canonicalDirectory(directory))) throw new Error('Browser vault path escaped its owned root.');
    env[name] = directory;
  }
  const absentEnv = path.join(stateRoot, 'absent.env');
  if (fs.existsSync(absentEnv)) throw new Error('Browser test environment file must remain absent.');
  Object.assign(env, {
    STHANG_BROWSER_API_PORT: String(cfg.apiPort), STHANG_BROWSER_WEB_PORT: String(cfg.webPort),
    STHANG_BROWSER_RUN_ROOT: cfg.runRoot, STHANG_BROWSER_RUN_MARKER: cfg.marker,
    STHANG_STUDIO_STATE_ROOT: stateRoot, STHANG_STUDIO_ENV_FILE: absentEnv,
    STHANG_STUDIO_ACTIVATION_ID: cfg.marker, STHANG_STUDIO_WEB_ROOT: '', STHANG_BROWSER_FIXTURE_PORT: '',
    PORT: String(cfg.apiPort), WEB_ORIGIN: cfg.webOrigin, NODE_OPTIONS: '',
    GEMINI_API_KEY: '', GOOGLE_API_KEY: '', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '',
    // A truthy invalid origin disables the config's public-default fallback.
    STHANG_CONTRIBUTION_ENDPOINT: 'disabled-for-synthetic-browser-tests', STHANG_ANALYTICS_ENDPOINT: 'disabled-for-synthetic-browser-tests', LOCAL_TIMING_PYTHON: path.join(stateRoot, 'missing-python.exe'),
  });
  return env;
}
export function addTestNamespace(url: string, cfg: HarnessConfig): string {
  if (!/^\/(api|media|exports)(?:\/|\?|$)/.test(url) || url.includes('\\') || /[\r\n]/.test(url) || /(?:^|\/)\.{1,2}(?:\/|\?|$)|%2e|%2f|%5c/i.test(url)) throw new Error('Only safe test API/media/export paths can be namespaced.');
  return `${cfg.namespace}${url}`;
}
export function safeFrontendUrl(url: string, cfg: HarnessConfig): string {
  const canonical = requireHarnessConfig({ STHANG_BROWSER_API_PORT: String(cfg.apiPort), STHANG_BROWSER_WEB_PORT: String(cfg.webPort), STHANG_BROWSER_RUN_ROOT: cfg.runRoot, STHANG_BROWSER_RUN_MARKER: cfg.marker });
  if (cfg.apiOrigin !== canonical.apiOrigin || cfg.webOrigin !== canonical.webOrigin || cfg.namespace !== canonical.namespace || cfg.runRoot !== canonical.runRoot) throw new Error('Browser frontend configuration does not match its owned run.');
  if (/[\\\x00-\x20\x7f]/.test(url) || /(?:^|\/)\.{1,2}(?:\/|\?|#|$)|%2e|%2f|%5c/i.test(url.split(/[?#]/)[0])) throw new Error('Unsafe browser frontend URL.');
  const parsed = new URL(url);
  if (parsed.origin !== cfg.webOrigin || parsed.username || parsed.password || parsed.hash) throw new Error('Browser requests must stay on their exact owned frontend origin.');
  if (parsed.pathname.startsWith('/__studio_browser_')) throw new Error('Browser frontend URL is already namespaced or belongs to another run.');
  const result = new URL(`${cfg.namespace}${parsed.pathname}${parsed.search}`, cfg.webOrigin);
  if (result.origin !== cfg.webOrigin || !result.pathname.startsWith(`${cfg.namespace}/`)) throw new Error('Browser frontend namespace was not preserved.');
  return result.href;
}
export function stripTestNamespace(url: string, cfg: HarnessConfig): string | null {
  const prefix = `${cfg.namespace}/`;
  return url.startsWith(prefix) ? url.slice(cfg.namespace.length) : null;
}
export function guardNamespacedRequest(listener: http.RequestListener, cfg: HarnessConfig): http.RequestListener {
  return function (this: http.Server, request, response) {
    const stripped = stripTestNamespace(request.url || '', cfg);
    if (stripped === null) { response.writeHead(404); response.end('Unknown synthetic test namespace.'); return; }
    request.url = stripped;
    return listener.call(this, request, response);
  };
}
