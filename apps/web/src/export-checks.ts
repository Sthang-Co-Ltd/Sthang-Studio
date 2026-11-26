import {
  captionFileBlockers, compileHighlightPlan, hasWordTimingEvidence, highlightAttention, resolveCaptionWordTiming, resolveWordExport,
  type CaptionAppearance, type CaptionFileFormat, type CaptionSegment,
} from '@kcs/shared';
import type { ReviewIssue } from './review';
import { translate } from './i18n/translate';
import type { MessageKey, MessageParams } from './i18n/types';

export type ExportRepairKind = 'caption' | 'timing' | 'word-timing' | 'appearance';

export interface ExportRepairTarget {
  kind: ExportRepairKind;
  captionId?: string;
  focus?: 'font';
}

interface ExportCheckMessage {
  key: MessageKey;
  params?: MessageParams;
}

export interface ExportCheckIssue {
  id: string;
  severity: 'blocker' | 'advisory';
  title: string;
  reasons: string[];
  titleIsFirstReason?: boolean;
  remedy: string;
  titleMessage?: ExportCheckMessage;
  reasonMessages?: (ExportCheckMessage | undefined)[];
  remedyMessage?: ExportCheckMessage;
  captionIds: string[];
  repair: ExportRepairKind;
}

function english(key: MessageKey) {
  return translate('en', key);
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
      const title = timing ? 'export.issue.timing' : !caption ? 'export.issue.dataLimit'
        : caption.text.trim() ? 'export.issue.text' : 'export.issue.empty';
      const remedy = timing ? 'export.issue.timingRemedy'
        : 'export.issue.textRemedy';
      issues.push({ id: `file:${caption?.id || 'project'}:${issue.field}:${index}`, severity: 'blocker',
        title: english(title), titleMessage: { key: title }, reasons: [issue.message],
        remedy: english(remedy), remedyMessage: { key: remedy },
        captionIds: caption ? [caption.id] : [], repair: issue.field === 'word-timing' ? 'word-timing' : timing ? 'timing' : 'caption' });
    }
  }

  for (const issue of reviewIssues) {
    if (!indices.has(issue.captionId) || issue.severity === 'info') continue;
    const previous = captions[(indices.get(issue.captionId) ?? 0) - 1];
    const overlap = Boolean(previous && issue.reasons.some((reason) => reason.code === 'overlap'));
    if (overlap) issues.push({ id: `overlap:${previous.id}:${issue.captionId}`, severity: 'advisory',
      title: english('export.issue.overlap'), titleMessage: { key: 'export.issue.overlap' },
      reasons: [english('export.issue.overlapReason')], reasonMessages: [{ key: 'export.issue.overlapReason' }],
      remedy: english('export.issue.overlapRemedy'), remedyMessage: { key: 'export.issue.overlapRemedy' },
      captionIds: [previous.id, issue.captionId], repair: 'timing' });
    const reasons = issue.reasons.filter((reason) => !overlap || reason.code !== 'overlap');
    const reasonMessages = reasons.map(({ code, label, params }) => {
      const key = `review.reason.${code}.label` as const;
      return translate('en', key, params) === label ? { key, params } : undefined;
    });
    if (reasons.length) issues.push({ id: `review:${issue.captionId}`, severity: 'advisory', title: reasons[0].label,
      titleMessage: reasonMessages[0], reasons: reasons.map(({ label }) => label), reasonMessages,
      titleIsFirstReason: true, remedy: english('export.issue.listenRemedy'), remedyMessage: { key: 'export.issue.listenRemedy' },
      captionIds: [issue.captionId], repair: 'caption' });
  }

  const needsWords = format === 'word-srt' || format === 'word-vtt';
  const showsWords = needsWords || format === 'bundle' || ((format === 'video' || format === 'ass') && appearance.highlightMode === 'word');
  if (showsWords) {
    for (const caption of captions) {
      if (!caption.text.trim()) continue;
      const strict = needsWords || format === 'bundle';
      const wordExport = strict ? resolveWordExport(caption) : null;
      if (wordExport ? wordExport.ready : highlightAttention(caption) !== 'needs-attention') continue;
      const marked = hasWordTimingEvidence(caption.wordTiming);
      const plan = marked && !strict ? compileHighlightPlan(caption, 'measured-and-manual') : null;
      const externalReason = wordExport && !wordExport.ready ? wordExport.reason : marked ? undefined : resolveCaptionWordTiming(caption).reason;
      const reasonKey = marked ? 'export.issue.unusableWords' : 'export.issue.missingWords';
      const reason = wordExport && !wordExport.ready ? wordExport.reason : externalReason || english(reasonKey);
      const consequence = needsWords ? 'export.issue.wordFilesRequireTiming'
        : format === 'bundle' ? 'export.issue.kitOmitsWordFiles'
          : plan?.coverage === 'partial' ? 'export.issue.somePlainWords'
            : plan ? 'export.issue.normalColor'
              : 'export.issue.plainWithoutHighlight';
      issues.push({ id: `words:${caption.id}`, severity: needsWords ? 'blocker' : 'advisory',
        title: english('export.issue.wordTiming'), titleMessage: { key: 'export.issue.wordTiming' },
        reasons: plan ? [english(consequence)] : [reason, english(consequence)],
        reasonMessages: plan ? [{ key: consequence }] : [externalReason !== undefined ? undefined : { key: reasonKey }, { key: consequence }],
        remedy: english('export.issue.wordTimingRemedy'), remedyMessage: { key: 'export.issue.wordTimingRemedy' },
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
