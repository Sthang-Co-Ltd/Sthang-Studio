import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { mergeConfig } from 'vite';
import original from '../../apps/web/vite.config';
import { addTestNamespace, requireHarnessConfig, stripTestNamespace } from './harness-config.mjs';

const cfg = requireHarnessConfig();
const interfaceFont = readFileSync(new URL('./fonts/PlusJakartaSans[wght].ttf', import.meta.url));
if (createHash('sha256').update(interfaceFont).digest('hex') !== '89b3fb38aa0d275d7a731d0d817a4f1622b316b4d7fbdedcf02ee9099ff68bc8') {
  throw new Error('Pinned interface test font checksum mismatch.');
}
if (process.env.STHANG_STUDIO_ACTIVATION_ID !== cfg.marker) throw new Error('Browser frontend activation marker is missing.');
// This must precede identity, static files and the API proxy. The frontend
// listener never accepts ordinary paths from a browser or a Node health probe.
const namespacePlugin = {
  name: 'studio-owned-browser-namespace',
  enforce: 'pre' as const,
  configureServer(server: import('vite').ViteDevServer) {
    server.middlewares.use((request, response, next) => {
      const stripped = stripTestNamespace(request.url || '', cfg);
      if (stripped === null) { response.statusCode = 404; response.end('Unknown synthetic frontend namespace.'); return; }
      // Test-only bytes are available only after the same capability namespace
      // check as every frontend request. Never proxy or fetch a hosted font.
      if (stripped === '/__interface-font/plus-jakarta-sans.ttf') {
        if (!['GET', 'HEAD'].includes(request.method || '')) { response.statusCode = 405; response.end(); return; }
        response.writeHead(200, { 'Content-Type': 'font/ttf', 'Content-Length': interfaceFont.length, 'Cache-Control': 'no-store' });
        response.end(request.method === 'HEAD' ? undefined : interfaceFont);
        return;
      }
      request.url = stripped;
      next();
    });
  },
};
export default mergeConfig({ ...original, plugins: [namespacePlugin, ...(original.plugins || [])] }, {
  server: {
    host: '127.0.0.1', port: cfg.webPort, strictPort: true, hmr: false,
    proxy: Object.fromEntries(['/api', '/media', '/exports'].map((route) => [route, { target: cfg.apiOrigin, rewrite: (url: string) => addTestNamespace(url, cfg) }])),
  },
});
