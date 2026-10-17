/** Controlled adversarial fixture. It never imports or starts Studio. */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  requireHarnessConfig, verifyOwnedStateRoot, stripTestNamespace,
} from '../browser/harness-config.mjs';

const config = requireHarnessConfig();
const root = verifyOwnedStateRoot(process.env.STHANG_STUDIO_STATE_ROOT || '', config);
interface FakeOptions {
  ready?: 'wrong-marker' | 'wrong-pid' | 'wrong-root' | 'wrong-port' | 'wrong-address';
  earlyExit?: boolean;
  health?: 'wrong-marker' | 'redirect' | 'hang';
  redirectTarget?: string;
}
const options = await fs.readFile(path.join(root, 'fake-options.json'), 'utf8')
  .then((text) => JSON.parse(text) as FakeOptions).catch(() => ({} as FakeOptions));
const events = path.join(root, 'fake-events.ndjson');
const record = (event: Record<string, unknown>) => fs.appendFile(events, `${JSON.stringify({ pid: process.pid, ...event })}\n`);
await record({ type: 'started', marker: config.marker, root });
if (options.earlyExit) process.exit(31);

const server = http.createServer(async (request, response) => {
  await record({ type: 'http', method: request.method, url: request.url });
  response.setHeader('Connection', 'close');
  const url = stripTestNamespace(request.url || '/', config);
  if (!url) { response.writeHead(404).end(); return; }
  if (url === '/api/health') {
    if (options.health === 'hang') return;
    if (options.health === 'redirect') {
      response.writeHead(302, { location: options.redirectTarget || 'http://127.0.0.1:1/never-follow' }).end();
      return;
    }
    response.setHeader('X-Sthang-Studio-Activation', options.health === 'wrong-marker' ? 'wrong-owned-marker' : config.marker);
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }));
    return;
  }
  if (url === '/api/profile' && request.method === 'PATCH') {
    await record({ type: 'profile-mutation' });
    response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    return;
  }
  response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
});
server.once('error', async (error) => {
  await record({ type: 'bind-failed', code: (error as NodeJS.ErrnoException).code });
  process.exit(32);
});
server.listen(config.apiPort, '127.0.0.1', async () => {
  const ready = {
    type: 'studio-browser-ready', pid: process.pid, marker: config.marker,
    root, address: '127.0.0.1', port: config.apiPort,
  };
  if (options.ready === 'wrong-marker') ready.marker = '0'.repeat(64);
  if (options.ready === 'wrong-pid') ready.pid++;
  if (options.ready === 'wrong-root') ready.root = path.join(root, 'unowned');
  if (options.ready === 'wrong-port') ready.port++;
  if (options.ready === 'wrong-address') ready.address = '0.0.0.0';
  await record({ type: 'ready-sent', ready });
  process.send?.(ready);
});
process.on('message', (message: unknown) => {
  const value = message as { type?: string };
  if (value?.type === 'fake-exit') process.exit(33);
  if (value?.type === 'fake-close-listener') {
    server.closeAllConnections();
    server.close(() => process.send?.({ type: 'fake-listener-closed', pid: process.pid }));
  }
});
