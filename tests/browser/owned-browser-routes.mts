import type { APIResponse, BrowserContext, Route } from '@playwright/test';
import http from 'node:http';
import { addTestNamespace, requireHarnessConfig, safeFrontendUrl, verifyOwnedStateRoot, type HarnessConfig } from './harness-config.mjs';

// Native anchor downloads may bypass Playwright routing; a cross-origin
// attachment's initial navigation may route. Its fixed fixture URL uses a
// continuously held listener in this same worker.
export function ownedNativeExportUrl(server: http.Server, root: string, cfg: HarnessConfig = requireHarnessConfig()): string {
  const canonical = requireHarnessConfig({ STHANG_BROWSER_API_PORT: String(cfg.apiPort), STHANG_BROWSER_WEB_PORT: String(cfg.webPort), STHANG_BROWSER_RUN_ROOT: cfg.runRoot, STHANG_BROWSER_RUN_MARKER: cfg.marker });
  if (cfg.apiOrigin !== canonical.apiOrigin || cfg.webOrigin !== canonical.webOrigin || cfg.namespace !== canonical.namespace || cfg.runRoot !== canonical.runRoot) throw new Error('Native export configuration does not match its owned run.');
  verifyOwnedStateRoot(root, canonical);
  const address = server.address();
  if (!(server instanceof http.Server) || !server.listening || !address || typeof address === 'string' || address.address !== '127.0.0.1' || address.port !== canonical.apiPort) throw new Error('Native export requires the live owned API listener.');
  return `${canonical.apiOrigin}${addTestNamespace('/exports/synthetic-captioned.mp4', canonical)}`;
}

export async function continueNativeExportRoute(route: Route, server: http.Server, root: string, cfg: HarnessConfig = requireHarnessConfig()): Promise<void> {
  try {
    const expectedUrl = ownedNativeExportUrl(server, root, cfg);
    const request = route.request();
    if (request.url() !== expectedUrl || !['GET', 'HEAD'].includes(request.method())) throw new Error('Native export request does not match its live owned capability.');
    await route.continue();
  } catch (error) {
    await route.abort('failed').catch(() => {});
    throw error;
  }
}
export async function installNativeExportGuard(context: BrowserContext, server: http.Server, root: string, cfg: HarnessConfig = requireHarnessConfig()): Promise<void> {
  const exportUrl = ownedNativeExportUrl(server, root, cfg);
  await context.route(exportUrl, (route) => continueNativeExportRoute(route, server, root, cfg));
}

// Preserve the browser's original URLs and mock matches while protecting the
// actual HTTP request, including after a frontend port is reused.
export async function fetchOwnedRoute(route: Route, cfg: HarnessConfig = requireHarnessConfig()): Promise<APIResponse> {
  const response = await route.fetch({ url: safeFrontendUrl(route.request().url(), cfg), maxRedirects: 0 });
  if (response.status() >= 300 && response.status() < 400) {
    await response.dispose();
    throw new Error('Synthetic browser forwarding rejected a redirect.');
  }
  return response;
}
export async function continueOwnedRoute(route: Route, cfg: HarnessConfig = requireHarnessConfig()): Promise<void> {
  const response = await fetchOwnedRoute(route, cfg);
  try { await route.fulfill({ response }); }
  finally { await response.dispose(); }
}
const installed = new WeakMap<BrowserContext, Promise<void>>();
export async function installBrowserNetworkGuard(context: BrowserContext, cfg: HarnessConfig = requireHarnessConfig()): Promise<void> {
  const existing = installed.get(context);
  if (existing) return existing;
  const installation = context.route('**/*', async (route) => {
    try { await continueOwnedRoute(route, cfg); }
    catch (error) { await route.abort('failed').catch(() => {}); throw error; }
  }).then(() => {});
  installed.set(context, installation);
  return installation;
}
