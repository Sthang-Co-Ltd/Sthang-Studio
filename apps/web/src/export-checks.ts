import { captionFileBlockers, resolveCaptionWordTiming, type CaptionAppearance, type CaptionFileFormat, type CaptionSegment } from '@kcs/shared';
import type { ReviewIssue } from './review';

export type ExportRepairKind = 'caption' | 'timing' | 'word-timing' | 'appearance';

export interface ExportRepairTarget {
  kind: ExportRepairKind;
  captionId?: string;
}

export interface ExportCheckIssue {
  id: string;
  severity: 'blocker' | 'advisory';
  title: string;
  reasons: string[];
  remedy: string;
  captionIds: string[];
  repair: ExportRepairKind;
}

/** Reuse the editor's QA and word-readiness authorities; no native rendering here. */
export function buildExportCaptionIssues(input: {
  captions: CaptionSegment[];
  reviewIssues: ReviewIssue[];
  format: 'video' | CaptionFileFormat;
  appearance: CaptionAppearance;
  durationMs?: number;
}): ExportCheckIssue[] {
  const { captions, reviewIssues, format, appearance, durationMs } = input;
  const issues: ExportCheckIssue[] = [];
  const indices = new Map(captions.map((caption, index) => [caption.id, index]));
  // Caption-file validation is stricter than the editorial QA profile. These
  // findings describe the existing serializer's rejection, not a new QA gate.
  if (format !== 'video') {
    for (const [index, issue] of captionFileBlockers({ captions, appearance,
      durationMs: durationMs && Number.isFinite(durationMs) && durationMs > 0 ? durationMs : undefined }, format).entries()) {
      const caption = issue.captionIndex === null ? undefined : captions[issue.captionIndex];
      const timing = issue.field === 'timing' || issue.field === 'word-timing';
      issues.push({ id: `file:${caption?.id || 'project'}:${issue.field}:${index}`, severity: 'blocker',
        title: timing ? 'Caption timing needs correction' : !caption ? 'Caption data exceeds export limits'
          : caption.text.trim() ? 'Caption text or data needs correction' : 'Caption has no text',
        reasons: [issue.message],
        remedy: timing ? 'Adjust the affected timing inside the source, then return to export.'
          : 'Review the indicated wording or data. Keep the original until you have corrected the export issue.',
        captionIds: caption ? [caption.id] : [], repair: issue.field === 'word-timing' ? 'word-timing' : timing ? 'timing' : 'caption' });
    }
  }

  for (const issue of reviewIssues) {
    if (!indices.has(issue.captionId) || issue.severity === 'info') continue;
    const previous = captions[(indices.get(issue.captionId) ?? 0) - 1];
    const overlap = Boolean(previous && issue.reasons.includes('Overlaps the previous caption'));
    if (overlap) issues.push({ id: `overlap:${previous.id}:${issue.captionId}`, severity: 'advisory', title: 'Overlapping captions',
      reasons: ['These captions overlap in the source timeline. Some destination editors cannot keep overlapping cues.'],
      remedy: 'Check both captions in Fine timing. Keep an intentional overlap, or adjust their shared boundary without shifting later speech.',
      captionIds: [previous.id, issue.captionId], repair: 'timing' });
    const reasons = issue.reasons.filter((reason) => !overlap || reason !== 'Overlaps the previous caption')
      .map((reason) => reason === 'Weak/interpolated timing' ? 'The timing needs a careful listen against the source.' : reason);
    if (reasons.length) issues.push({ id: `review:${issue.captionId}`, severity: 'advisory', title: 'Review suggested',
      reasons, remedy: 'Listen to this caption and check its wording, duration and nearby captions. Export keeps your chosen text and timing.',
      captionIds: [issue.captionId], repair: 'caption' });
  }

  const needsWords = format === 'word-srt' || format === 'word-vtt';
  const showsWords = needsWords || format === 'bundle' || ((format === 'video' || format === 'ass') && appearance.highlightMode === 'word');
  if (showsWords) {
    for (const caption of captions) {
      if (!caption.text.trim()) continue;
      const timing = resolveCaptionWordTiming(caption);
      if (timing.state === 'ready') continue;
      const consequence = needsWords ? 'Word-timed download requires usable timing for every caption.'
        : format === 'bundle' ? 'The handoff kit will omit word-timed files until every caption is ready.'
          : 'This caption will keep its normal color without a spoken-word highlight.';
      issues.push({ id: `words:${caption.id}`, severity: needsWords ? 'blocker' : 'advisory', title: 'Word timing needs review',
        reasons: [timing.reason || 'This caption has no saved word timing.', consequence],
        remedy: 'Open Word timing, sync or adjust the words, then review and apply the timing.',
        captionIds: [caption.id], repair: 'word-timing' });
    }
  }
  return issues.sort((a, b) => Number(b.severity === 'blocker') - Number(a.severity === 'blocker')
    || (indices.get(a.captionIds[0]) ?? -1) - (indices.get(b.captionIds[0]) ?? -1)
    || a.id.localeCompare(b.id));
}

/** The complete draft, including word timing, owns a native check. */
export function exportLayoutKey(input: {
  projectId: string;
  media: { filename: string; size: number };
  captions: CaptionSegment[];
  appearance: CaptionAppearance;
  resolution: string;
  fontRevision: number;
  capabilityRevision: number;
}) {
  return JSON.stringify([input.projectId, input.media.filename, input.media.size, input.captions,
    input.appearance, input.resolution, input.fontRevision, input.capabilityRevision]);
}
