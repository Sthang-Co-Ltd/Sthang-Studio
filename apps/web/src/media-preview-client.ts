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
export async function requestMediaPreview(projectId: string, source: string, method: 'GET' | 'POST' | 'DELETE', signal?: AbortSignal, force = false): Promise<MediaPreviewStatus> {
  const url = `/api/media-preview/${encodeURIComponent(projectId)}` + (method === 'GET' ? `?source=${encodeURIComponent(source)}` : '');
  const response = await fetch(url, {
    method, signal, cache: 'no-store',
    ...(method === 'GET' ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source, ...(force ? { force: true } : {}) }) }),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(typeof value.error === 'string' ? value.error : 'Playback preparation is unavailable.');
  if (value.source !== source) throw new Error('The source media changed. Reopen this project.');
  return value;
}
