export interface MediaPreviewStatus {
  source: string;
  state: 'original' | 'processing' | 'ready' | 'failed' | 'cancelled';
  videoCodec: string;
  progress: number;
  url?: string;
  message?: string;
}
export function needsCompatiblePlayback(codec: string, canPlayType: (type: string) => string) {
  if (!['hevc', 'h265'].includes(codec.toLowerCase())) return false;
  return !canPlayType('video/mp4; codecs="hvc1"') && !canPlayType('video/mp4; codecs="hev1"');
}
export const PREVIEW_REQUEST_TIMEOUT_MS = 25_000;
export const MAX_PREVIEW_STATUS_BYTES = 64 * 1024;
const unavailable = () => new Error('Playback preparation is unavailable.');

async function withPreviewDeadline<T>(signal: AbortSignal | undefined, timeoutMs: number, request: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    return await request(controller.signal);
  } catch (error) {
    if (timedOut) throw new Error('Playback preparation did not respond. Check progress or try again.');
    throw error;
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort);
    // Also stop a rejected/oversized body instead of leaving it downloading.
    controller.abort();
  }
}

async function readPreviewStatus(response: Response): Promise<Record<string, unknown>> {
  if (Number(response.headers.get('content-length')) > MAX_PREVIEW_STATUS_BYTES || !response.body) {
    void response.body?.cancel().catch(() => {});
    throw unavailable();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let complete = false;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) { complete = true; break; }
      length += chunk.value.byteLength;
      if (length > MAX_PREVIEW_STATUS_BYTES) throw unavailable();
      chunks.push(chunk.value);
    }
  } finally {
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw unavailable(); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw unavailable();
  return value as Record<string, unknown>;
}

function localPlaybackUrl(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 2048 && /^\/(?!\/)/.test(value) && !/[\\\u0000-\u001f\u007f]/.test(value);
}

/** HEAD renews the selected immutable generation, never whichever copy is latest. */
export async function checkMediaPreviewCopy(url: string, signal?: AbortSignal, timeoutMs = PREVIEW_REQUEST_TIMEOUT_MS): Promise<'available' | 'missing' | 'unavailable'> {
  if (!localPlaybackUrl(url)) throw unavailable();
  return withPreviewDeadline(signal, timeoutMs, async (ownedSignal) => {
    const response = await fetch(url, { method: 'HEAD', signal: ownedSignal, cache: 'no-store', redirect: 'error' });
    return response.ok ? 'available' : response.status === 404 || response.status === 410 ? 'missing' : 'unavailable';
  });
}

export async function requestMediaPreview(projectId: string, source: string, method: 'GET' | 'POST' | 'DELETE', signal?: AbortSignal, force = false, timeoutMs = PREVIEW_REQUEST_TIMEOUT_MS): Promise<MediaPreviewStatus> {
  return withPreviewDeadline(signal, timeoutMs, async (ownedSignal) => {
    const url = `/api/media-preview/${encodeURIComponent(projectId)}` + (method === 'GET' ? `?source=${encodeURIComponent(source)}` : '');
    const response = await fetch(url, {
      method, signal: ownedSignal, cache: 'no-store',
      ...(method === 'GET' ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source, ...(force ? { force: true } : {}) }) }),
    });
    // The same deadline covers headers AND a stalled response body.
    const value = await readPreviewStatus(response);
    if (!response.ok) throw new Error(typeof value.error === 'string' && value.error.length <= 4096 ? value.error : 'Playback preparation is unavailable.');
    if (typeof value.source !== 'string') throw unavailable();
    if (value.source !== source) throw new Error('The source media changed. Reopen this project.');
    if (!['original', 'processing', 'ready', 'failed', 'cancelled'].includes(value.state as string)
      || typeof value.videoCodec !== 'string' || value.videoCodec.length > 64
      || typeof value.progress !== 'number' || !Number.isFinite(value.progress) || value.progress < 0 || value.progress > 100
      || (value.message !== undefined && (typeof value.message !== 'string' || value.message.length > 4096))
      || (value.url !== undefined && !localPlaybackUrl(value.url))
      || (value.state === 'ready' && !localPlaybackUrl(value.url))) throw unavailable();
    return { source, state: value.state as MediaPreviewStatus['state'], videoCodec: value.videoCodec, progress: value.progress,
      ...(typeof value.url === 'string' ? { url: value.url } : {}), ...(typeof value.message === 'string' ? { message: value.message } : {}) };
  });
}
