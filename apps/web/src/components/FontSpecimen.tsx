import { useEffect, useRef, useState } from 'react';
import type { CaptionPreviewResult } from '@kcs/shared';
import { useI18n } from '../i18n';

interface Props {
  projectId: string;
  family: string;
  bold: boolean;
  text: string;
}

// The same local renderer resolves Studio-imported and installed faces for export.
export function FontSpecimen({ projectId, family, bold, text }: Props) {
  const { t } = useI18n();
  const canvas = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<'pending' | 'ready' | 'unavailable'>('pending');
  useEffect(() => {
    const controller = new AbortController();
    let busyRetries = 0;
    let timer: number;
    async function render() {
      try {
        const response = await fetch('/api/video-export/' + encodeURIComponent(projectId) + '/preview', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
          body: JSON.stringify({
            captions: [{ text, startMs: 0, endMs: 1000 }], timesMs: [500], resolution: '720p',
            appearance: { fontFamily: family, bold, fontSize1080: 48, outlineWidth1080: 0, shadowWidth1080: 0 },
          }),
        });
        if (controller.signal.aborted) return;
        if (response.status === 429 && busyRetries < 3) {
          busyRetries += 1;
          timer = window.setTimeout(() => void render(), 300 * busyRetries);
          return;
        }
        if (!response.ok) throw new Error();
        const result: CaptionPreviewResult = await response.json();
        const frame = result.frames[0];
        if (!frame?.bounds || !frame.png) throw new Error();
        const image = new Image();
        image.src = 'data:image/png;base64,' + frame.png;
        await image.decode();
        if (controller.signal.aborted || !canvas.current) return;
        const { x, y, width, height } = frame.bounds;
        if (width < 1 || height < 1 || x < 0 || y < 0 || x + width > image.naturalWidth || y + height > image.naturalHeight) throw new Error();
        const surface = canvas.current;
        surface.width = width;
        surface.height = height;
        const context = surface.getContext('2d');
        if (!context) throw new Error();
        context.drawImage(image, x, y, width, height, 0, 0, width, height);
        setStatus('ready');
      } catch {
        if (!controller.signal.aborted) setStatus('unavailable');
      }
    }
    // Arrowing past a result should not start a native render for every keypress.
    timer = window.setTimeout(() => void render(), 220);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [projectId, family, bold, text]);

  return <figure className="font-specimen" aria-label={t('appearance.fontSearch.preview')} aria-busy={status === 'pending'}>
    <figcaption>{family}</figcaption>
    <canvas ref={canvas} hidden={status !== 'ready'} role="img" aria-label={text}/>
    {status === 'unavailable' && <span role="status">{t('appearance.fontSearch.previewUnavailable')}</span>}
  </figure>;
}
