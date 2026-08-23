import type { CaptionSegment, QaProfileId, QaProfileSettings } from '@kcs/shared';

export type ReviewSeverity = 'info' | 'warning' | 'error';

export interface ReviewIssue {
  captionId: string;
  severity: ReviewSeverity;
  reasons: string[];
}

export const QA_PROFILES: Record<Exclude<QaProfileId, 'custom'>, QaProfileSettings> = {
  'khmer-tiktok-fast': {
    id: 'khmer-tiktok-fast',
    name: 'Khmer TikTok — Fast',
    description: 'Punchy single-line captions for rapid short-form delivery.',
    maxCps: 25,
    maxCharsPerLine: 26,
    maxLines: 1,
    minDurationMs: 220,
    maxDurationMs: 3000,
    minGapMs: 35,
    leadInMs: 60,
    leadOutMs: 90,
    snapToleranceMs: 150,
  },
  'khmer-tiktok-comfortable': {
    id: 'khmer-tiktok-comfortable',
    name: 'Khmer TikTok — Comfortable',
    description: 'Balanced reading rhythm with slightly longer display time.',
    maxCps: 20,
    maxCharsPerLine: 32,
    maxLines: 2,
    minDurationMs: 380,
    maxDurationMs: 3800,
    minGapMs: 45,
    leadInMs: 80,
    leadOutMs: 120,
    snapToleranceMs: 180,
  },
  'capcut-srt': {
    id: 'capcut-srt',
    name: 'CapCut SRT',
    description: 'Practical sidecar-subtitle limits for CapCut handoff.',
    maxCps: 22,
    maxCharsPerLine: 42,
    maxLines: 2,
    minDurationMs: 320,
    maxDurationMs: 4500,
    minGapMs: 40,
    leadInMs: 70,
    leadOutMs: 100,
    snapToleranceMs: 160,
  },
  accessibility: {
    id: 'accessibility',
    name: 'Accessibility',
    description: 'Slower, more readable captions with conservative limits.',
    maxCps: 15,
    maxCharsPerLine: 37,
    maxLines: 2,
    minDurationMs: 750,
    maxDurationMs: 6000,
    minGapMs: 80,
    leadInMs: 120,
    leadOutMs: 180,
    snapToleranceMs: 220,
  },
};

export function resolveQaProfile(id: QaProfileId | undefined, custom?: Partial<QaProfileSettings>): QaProfileSettings {
  if (id === 'custom') {
    const base = QA_PROFILES['khmer-tiktok-comfortable'];
    return {
      ...base,
      ...custom,
      id: 'custom',
      name: custom?.name || 'Custom QA',
      description: custom?.description || 'Your own subtitle quality thresholds.',
    };
  }
  const key: Exclude<QaProfileId, 'custom'> = id || 'khmer-tiktok-comfortable';
  return QA_PROFILES[key];
}

const hasKhmer = (value: string) => /\p{Script=Khmer}/u.test(value);
const hasLatin = (value: string) => /[A-Za-z]/.test(value);
const graphemeLength = (value: string) => [...new Intl.Segmenter('km', { granularity: 'grapheme' }).segment(value)].length;

function vocabularyAliases(lines: string[]) {
  return lines.flatMap((line) => {
    const parts = line.split('|').map((x) => x.trim()).filter(Boolean);
    return parts.slice(1).map((alias) => ({ canonical: parts[0], alias }));
  });
}

function addReason(target: Map<string, ReviewIssue>, captionId: string, severity: ReviewSeverity, reason: string) {
  const rank: Record<ReviewSeverity, number> = { info: 0, warning: 1, error: 2 };
  const existing = target.get(captionId);
  if (!existing) {
    target.set(captionId, { captionId, severity, reasons: [reason] });
    return;
  }
  if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
  if (rank[severity] > rank[existing.severity]) existing.severity = severity;
}

export function analyzeCaptions(
  captions: CaptionSegment[],
  vocabularyLines: string[],
  settings: QaProfileSettings = QA_PROFILES['khmer-tiktok-comfortable'],
  mediaDurationMs?: number,
): ReviewIssue[] {
  const issues = new Map<string, ReviewIssue>();
  const aliases = vocabularyAliases(vocabularyLines);

  captions.forEach((caption, index) => {
    const text = caption.text.trim();
    const durationMs = caption.endMs - caption.startMs;
    const durationSeconds = Math.max(0.05, durationMs / 1000);
    const cps = graphemeLength(text.replace(/\s+/g, '')) / durationSeconds;
    const lines = caption.text.split(/\r?\n/);
    const longestLine = Math.max(0, ...lines.map((line) => graphemeLength(line)));

    if (!text) addReason(issues, caption.id, 'error', 'Empty caption');
    if (caption.timingQuality === 'low' || caption.timingSource === 'interpolated') {
      addReason(issues, caption.id, 'error', 'Weak/interpolated timing');
    } else if (!caption.approved && (caption.timingQuality === 'medium' || caption.timingSource === 'stt-split')) {
      addReason(issues, caption.id, 'warning', 'Timing deserves a quick listen');
    }
    if (durationMs < settings.minDurationMs) addReason(issues, caption.id, 'warning', `Shorter than ${settings.minDurationMs} ms`);
    if (durationMs > settings.maxDurationMs) addReason(issues, caption.id, 'warning', `Longer than ${(settings.maxDurationMs / 1000).toFixed(1)} seconds`);
    if (cps > settings.maxCps) addReason(issues, caption.id, 'warning', `Fast reading speed (${Math.round(cps)} chars/s; target ≤ ${settings.maxCps})`);
    if (longestLine > settings.maxCharsPerLine) addReason(issues, caption.id, 'warning', `Line is ${longestLine} characters; target ≤ ${settings.maxCharsPerLine}`);
    if (lines.length > settings.maxLines) addReason(issues, caption.id, 'warning', `${lines.length} lines; target ≤ ${settings.maxLines}`);
    if (hasKhmer(text) && hasLatin(text) && !caption.approved) addReason(issues, caption.id, 'info', 'Khmer + English entity check');
    if (!caption.approved && /\b(?:GPT|AI|API|LLM|[A-Z]{2,}|[A-Za-z]+[- ]?\d|\d+(?:\.\d+)+)\b/.test(text)) {
      addReason(issues, caption.id, 'info', 'Name, acronym or version number');
    }
    if (/\s{2,}/.test(text)) addReason(issues, caption.id, 'warning', 'Repeated spaces');

    for (const { canonical, alias } of aliases) {
      if (alias && text.includes(alias) && alias !== canonical) {
        addReason(issues, caption.id, 'error', `Alias “${alias}” should probably display as “${canonical}”`);
      }
    }

    const previous = captions[index - 1];
    if (previous && caption.startMs < previous.endMs) addReason(issues, caption.id, 'error', 'Overlaps the previous caption');
    if (previous) {
      const gap = caption.startMs - previous.endMs;
      if (gap >= 0 && gap < settings.minGapMs) addReason(issues, caption.id, 'info', `Gap is ${gap} ms; QA target is ${settings.minGapMs} ms`);
      if (previous.text.trim() === text && text) addReason(issues, caption.id, 'warning', 'Duplicates the previous caption');
    }
    if (caption.startMs < 0) addReason(issues, caption.id, 'error', 'Starts before the media');
    if (mediaDurationMs && caption.endMs > mediaDurationMs + 20) addReason(issues, caption.id, 'error', 'Ends after the media');
  });

  return [...issues.values()].sort((a, b) => {
    const rank: Record<ReviewSeverity, number> = { error: 0, warning: 1, info: 2 };
    const severity = rank[a.severity] - rank[b.severity];
    if (severity) return severity;
    return captions.findIndex((c) => c.id === a.captionId) - captions.findIndex((c) => c.id === b.captionId);
  });
}

export function exportReadiness(captions: CaptionSegment[], issues: ReviewIssue[]) {
  if (!captions.length) return 0;
  const weight: Record<ReviewSeverity, number> = { info: 0.2, warning: 0.7, error: 1.5 };
  const penalty = issues.reduce((sum, issue) => sum + weight[issue.severity], 0);
  const approvalBonus = captions.filter((caption) => caption.approved).length / captions.length * 6;
  return Math.max(0, Math.min(100, Math.round(100 - (penalty / captions.length) * 32 + approvalBonus)));
}
