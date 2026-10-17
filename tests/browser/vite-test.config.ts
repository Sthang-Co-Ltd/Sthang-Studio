import { mergeConfig } from 'vite';
import original from '../../apps/web/vite.config';
import { addTestNamespace, requireHarnessConfig, stripTestNamespace } from './harness-config.mjs';

const cfg = requireHarnessConfig();
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
