// Playwright waits on this owned stdout pipe, never a pre-start HTTP probe.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { requireHarnessConfig, verifyOwnedStateRoot } from './harness-config.mjs';

const cfg = requireHarnessConfig();
const root = verifyOwnedStateRoot(process.env.STHANG_STUDIO_STATE_ROOT || '', cfg);
if (process.env.STHANG_STUDIO_ACTIVATION_ID !== cfg.marker) throw new Error('Owned browser frontend activation is missing.');
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const server = await createServer({ root: path.join(repoRoot, 'apps/web'), configFile: path.join(repoRoot, 'tests/browser/vite-test.config.ts') });
try {
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string' || address.address !== '127.0.0.1' || address.port !== cfg.webPort) throw new Error('Owned browser frontend bound an unexpected address.');
  console.log(`STUDIO_BROWSER_WEB_READY ${JSON.stringify({ marker: cfg.marker, pid: process.pid, root, address: address.address, port: address.port })}`);
} catch (error) {
  await server.close();
  throw error;
}
