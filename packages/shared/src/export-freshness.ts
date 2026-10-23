import type { CaptionProject } from './index.js';
import { createCaptionData, serializeCaptionFile, type CaptionFileFormat } from './caption-interchange.js';
import { normalizeCaptionAppearance } from './caption-settings.js';
import { hydrateCaptionWordTimings, resolveCaptionWordTiming } from './word-timing.js';

export type ExportEvidenceFormat = CaptionFileFormat | 'video';
export interface ExportEvidence {
  version: 1;
  format: ExportEvidenceFormat;
  fingerprint: string;
  preparedAt: string;
}

/** Canonical content basis, shared by local server receipts and browser comparisons. */
export function exportContentBasis(project: CaptionProject, format: ExportEvidenceFormat): string {
  const hydrated = hydrateCaptionWordTimings(project);
  const appearance = normalizeCaptionAppearance(project.captionAppearance);
  const input = { captions: hydrated.captions, appearance, durationMs: project.transcript?.timing?.audioDurationMs };
  let content: unknown;
  if (['srt', 'vtt', 'ttml', 'word-srt', 'word-vtt', 'data'].includes(format)) {
    content = serializeCaptionFile(input, format as Exclude<CaptionFileFormat, 'ass' | 'bundle'>).text;
  } else if (format === 'bundle') {
    // Bundles contain Studio data as well as ordinary caption files.
    content = createCaptionData(input);
  } else {
    content = { appearance, captions: hydrated.captions.map((caption) => {
      const timing = appearance.highlightMode === 'word' ? resolveCaptionWordTiming(caption) : null;
      return { text: caption.text, startMs: caption.startMs, endMs: caption.endMs,
        ...(timing ? { wordPaint: timing.state === 'ready'
          ? timing.words.map(({ startOffset, endOffset, startMs, endMs }) => ({ startOffset, endOffset, startMs, endMs })) : null } : {}),
      };
    }) };
  }
  return JSON.stringify({ version: 1, format, media: { filename: project.media.filename, size: project.media.size, mimeType: project.media.mimeType }, content });
}
