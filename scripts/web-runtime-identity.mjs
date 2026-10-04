import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { exactVersion, HEX_64 } from './update-protocol.mjs';

export const WEB_IDENTITY_FILE = 'studio-web-identity.json';
export const WEB_IDENTITY_PATH = `/${WEB_IDENTITY_FILE}`;
export const ACTIVATION_HEADER = 'X-Sthang-Studio-Activation';

export function validateWebIdentity(value, expectedVersion) {
  if (value?.schemaVersion !== 1 || value.service !== 'sthang-studio-web'
    || !HEX_64.test(value.buildId) || exactVersion(value.version, 'Studio web version') !== expectedVersion) {
    throw new Error('The prepared Studio web identity is invalid.');
  }
  return value;
}

// This is a deterministic build-input identity owned by the frontend, never an
// echo of the API version or the updater's expected version. Hash paths and bytes
// in stable order; exclude output, caches and local state. The same inputs are
// available to the prepared Windows Vite runtime and its preceding build.
export function webSourceIdentity(sourceRoot) {
  const webRoot = path.join(sourceRoot, 'apps', 'web');
  const version = exactVersion(JSON.parse(fs.readFileSync(path.join(webRoot, 'package.json'), 'utf8')).version, 'Studio web version');
  const digest = crypto.createHash('sha256');
  const visit = (relative) => {
    const file = path.join(sourceRoot, ...relative.split('/'));
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error('Studio web identity inputs must not be symbolic links.');
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(file).sort()) visit(`${relative}/${entry}`);
    } else if (stat.isFile()) {
      const bytes = fs.readFileSync(file);
      digest.update(`${relative.length}:${relative}:${bytes.length}:`);
      digest.update(bytes);
    }
  };
  for (const relative of [
    'apps/web/package.json', 'apps/web/index.html', 'apps/web/vite.config.ts',
    'apps/web/tsconfig.json', 'apps/web/tsconfig.app.json',
    'apps/web/src', 'apps/web/public', 'packages/shared/src',
    'packages/shared/package.json', 'packages/shared/tsconfig.json',
    'package-lock.json', 'scripts/web-runtime-identity.mjs',
  ]) visit(relative);
  return { schemaVersion: 1, service: 'sthang-studio-web', version, buildId: digest.digest('hex') };
}

export function studioWebIdentityPlugin(sourceRoot) {
  const identity = webSourceIdentity(sourceRoot);
  const body = `${JSON.stringify(identity)}\n`;
  return {
    name: 'sthang-studio-web-identity',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] !== WEB_IDENTITY_PATH) return next();
        if (!['GET', 'HEAD'].includes(req.method || '')) { res.statusCode = 405; res.end(); return; }
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        const activationId = process.env.STHANG_STUDIO_ACTIVATION_ID;
        if (activationId) res.setHeader(ACTIVATION_HEADER, activationId);
        res.end(req.method === 'HEAD' ? undefined : body);
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: WEB_IDENTITY_FILE, source: body });
    },
  };
}
