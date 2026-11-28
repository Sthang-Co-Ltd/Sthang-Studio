// A Home visit never starts a media decoder. Keep only previews from this tab.
export type RecentStill = { updatedAt: string; image?: string; audio: boolean };

export function captureRecentStill(media: HTMLMediaElement | null, updatedAt: string): RecentStill | undefined {
  if (!media) return;
  if (media instanceof HTMLAudioElement) return { updatedAt, audio: true };
  if (!(media instanceof HTMLVideoElement) || media.error || media.seeking || !media.videoWidth || !media.videoHeight
      || media.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
  try {
    const canvas = document.createElement('canvas');
    const scale = Math.min(112 / media.videoWidth, 84 / media.videoHeight);
    canvas.width = Math.max(1, Math.round(media.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(media.videoHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) return;
    context.drawImage(media, 0, 0, canvas.width, canvas.height);
    return { updatedAt, audio: false, image: canvas.toDataURL('image/jpeg', .72) };
  } catch { return; }
}
