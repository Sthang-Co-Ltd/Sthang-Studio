// Serve only the current production build through the existing owned namespace.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { preview } from 'vite';
import { addTestNamespace, requireHarnessConfig, stripTestNamespace, verifyOwnedStateRoot } from '../../tests/browser/harness-config.mjs';
import { webSourceIdentity } from '../../scripts/web-runtime-identity.mjs';

const cfg = requireHarnessConfig();
const root = verifyOwnedStateRoot(process.env.STHANG_STUDIO_STATE_ROOT || '', cfg);
if (process.env.STHANG_STUDIO_ACTIVATION_ID !== cfg.marker) throw new Error('Missing owned frontend activation.');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const built = JSON.parse(fs.readFileSync(path.join(repo, 'apps/web/dist/studio-web-identity.json'), 'utf8'));
if (built.buildId !== webSourceIdentity(repo).buildId) throw new Error('Production build is stale; run npm run build.');
const font = fs.readFileSync(path.join(repo, 'tests/browser/fonts/PlusJakartaSans[wght].ttf'));
if (createHash('sha256').update(font).digest('hex') !== '89b3fb38aa0d275d7a731d0d817a4f1622b316b4d7fbdedcf02ee9099ff68bc8') throw new Error('Pinned font checksum mismatch.');
const server = await preview({
  root: path.join(repo, 'apps/web'), configFile: false,
  plugins: [{ name: 'owned-production-benchmark', configurePreviewServer(server) {
    server.middlewares.use((request, response, next) => {
      const stripped = stripTestNamespace(request.url || '', cfg);
      if (stripped === null) { response.writeHead(404); response.end(); return; }
      response.setHeader('X-Sthang-Studio-Activation', cfg.marker);
      if (stripped === '/__interface-font/plus-jakarta-sans.ttf') {
        if (!['GET', 'HEAD'].includes(request.method || '')) { response.writeHead(405); response.end(); return; }
        response.writeHead(200, { 'Content-Type': 'font/ttf', 'Content-Length': font.length });
        response.end(request.method === 'HEAD' ? undefined : font); return;
      }
      request.url = stripped; next();
    });
  } }],
  preview: { host: '127.0.0.1', port: cfg.webPort, strictPort: true,
    proxy: Object.fromEntries(['/api', '/media', '/exports'].map((route) => [route, { target: cfg.apiOrigin, rewrite: (url: string) => addTestNamespace(url, cfg) }])) },
});
const address = server.httpServer.address();
if (!address || typeof address === 'string' || address.address !== '127.0.0.1' || address.port !== cfg.webPort) {
  server.httpServer.close(); throw new Error('Unexpected production listener.');
}
console.log(`STUDIO_BROWSER_WEB_READY ${JSON.stringify({ marker: cfg.marker, pid: process.pid, root, address: address.address, port: address.port })}`);
