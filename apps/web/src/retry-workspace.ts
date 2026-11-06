type WorkspaceName = 'WaveformEditor' | 'ExportWorkspace' | 'CaptionAppearanceWorkspace' | 'RegenerationReviewDock';
type WorkspaceAsset = { entry: string; css: string[] };
declare const __STUDIO_WEB_BUILD_ID__: string;

function assetUrl(path: string, extension: 'js' | 'css') {
  const valid = import.meta.env.DEV
    ? extension === 'js' && /^\/src\/components\/[A-Za-z]+\.tsx$/.test(path)
    : new RegExp(`^/assets/[A-Za-z0-9_-]+\\.${extension}$`).test(path);
  if (!valid) throw new Error('Invalid tool download.');
  return new URL(path, location.origin);
}

const styles = new Map<string, Promise<void>>();
const styleState = new WeakMap<HTMLLinkElement, 'loaded' | 'failed'>();
// A failed link can still expose an empty CSSStyleSheet. Observe the actual
// download result before Vite starts any optional stylesheet requests.
for (const event of ['load', 'error'] as const) document.addEventListener(event, (value) => {
  if (value.target instanceof HTMLLinkElement && value.target.rel === 'stylesheet') {
    styleState.set(value.target, event === 'load' ? 'loaded' : 'failed');
  }
}, true);

function styleLoaded(link: HTMLLinkElement) {
  const state = styleState.get(link);
  if (state) return state === 'loaded';
  // The main stylesheet may have finished before this module executed.
  try { return Boolean(link.sheet?.cssRules.length); } catch { return false; }
}

function loadStyle(path: string, attempt: string): Promise<void> {
  const url = assetUrl(path, 'css');
  const pending = styles.get(path);
  if (pending) return pending;
  const existing = [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')]
    .find((link) => new URL(link.href).pathname === path);
  if (existing && styleLoaded(existing)) return Promise.resolve();
  const promise = new Promise<void>((resolve, reject) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet'; link.crossOrigin = '';
    url.searchParams.set('studio-retry', attempt); link.href = url.href;
    link.onload = () => { link.onload = null; link.onerror = null; resolve(); };
    link.onerror = () => {
      link.onload = null; link.onerror = null;
      // Retain the failed link's position for the next explicit attempt.
      styles.delete(path); reject(new Error('Tool styles could not load.'));
    };
    // Preserve the original cascade position, including a failed Vite preload.
    if (existing) existing.replaceWith(link); else document.head.appendChild(link);
  });
  styles.set(path, promise);
  return promise;
}

/** Called only after an explicit Retry; never reload or replace the editor. */
export async function retryWorkspace<T>(name: WorkspaceName): Promise<T> {
  const response = await fetch('/studio-workspaces.json', { cache: 'no-store', redirect: 'error' });
  if (!response.ok) throw new Error('Tool download is unavailable.');
  const manifest = await response.json() as { buildId: string; tools: Record<WorkspaceName, WorkspaceAsset> };
  if (manifest.buildId !== __STUDIO_WEB_BUILD_ID__) throw new Error('Tool download does not match this Studio session.');
  const asset = manifest.tools?.[name];
  if (!asset || !Array.isArray(asset.css) || asset.css.length > 20) throw new Error('Tool download is unavailable.');
  const url = assetUrl(asset.entry, 'js');
  const attempt = crypto.randomUUID();
  // Keep dependency order. A successful stylesheet is retained across retries.
  for (const css of asset.css) await loadStyle(css, attempt);
  url.searchParams.set('studio-retry', attempt);
  if (import.meta.env.DEV) url.searchParams.set('studio-tool', name);
  return import(/* @vite-ignore */ url.href) as Promise<T>;
}
