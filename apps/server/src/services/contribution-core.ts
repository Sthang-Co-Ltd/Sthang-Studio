import crypto from 'node:crypto';
import type {
  CaptionProject,
  CaptionSegment,
  ContributionCandidate,
  CorrectionEvent,
} from '@kcs/shared';

const MAX_TEXT_LENGTH = 1000;
const MIN_AUDIO_MS = 250;
const MAX_AUDIO_MS = 15_000;

function comparableText(value: string) {
  return value.normalize('NFC').trim().replace(/\s+/g, ' ');
}

function sameText(left: string, right: string) {
  return comparableText(left) === comparableText(right);
}

function containsKhmer(value: string) {
  return /\p{Script=Khmer}/u.test(value);
}

export interface CorrectionLineage {
  originalText: string;
  correctedText: string;
  events: CorrectionEvent[];
  sourceEvent: CorrectionEvent;
  finalEvent: CorrectionEvent;
}

export function resolveCorrectionLineage(
  events: CorrectionEvent[],
  projectId: string,
  captionId: string,
  finalText: string,
): CorrectionLineage | null {
  const relevant = events
    .filter((event) => event.projectId === projectId && event.captionId === captionId)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  if (!relevant.length) return null;

  let cursor = comparableText(finalText);
  let upperBound = relevant.length;
  const chain: CorrectionEvent[] = [];
  while (upperBound > 0 && chain.length < 32) {
    let matchIndex = -1;
    for (let index = upperBound - 1; index >= 0; index -= 1) {
      if (sameText(relevant[index].correctedText, cursor)) {
        matchIndex = index;
        break;
      }
    }
    if (matchIndex < 0) break;
    const event = relevant[matchIndex];
    chain.unshift(event);
    cursor = comparableText(event.originalText);
    upperBound = matchIndex;
  }

  if (!chain.length) return null;
  const sourceEvent = chain[0];
  const finalEvent = chain[chain.length - 1];
  const originalText = sourceEvent.originalText.trim();
  const correctedText = finalText.trim();
  if (!originalText || !correctedText || sameText(originalText, correctedText)) return null;
  return { originalText, correctedText, events: chain, sourceEvent, finalEvent };
}

export function approvedContributionCandidates(input: {
  project: CaptionProject;
  before: CaptionSegment[];
  after: CaptionSegment[];
  correctionEvents: CorrectionEvent[];
  consentGrantedAt: string;
  mediaFingerprint: string;
}): ContributionCandidate[] {
  const { project, before, after, correctionEvents, consentGrantedAt, mediaFingerprint } = input;
  const consentTime = Date.parse(consentGrantedAt);
  if (!Number.isFinite(consentTime)) return [];
  const beforeById = new Map(before.map((caption) => [caption.id, caption]));
  const out: ContributionCandidate[] = [];

  for (const caption of after) {
    const previous = beforeById.get(caption.id);
    if (!previous || previous.approved === true || caption.approved !== true) continue;
    const durationMs = caption.endMs - caption.startMs;
    if (durationMs < MIN_AUDIO_MS || durationMs > MAX_AUDIO_MS) continue;

    const lineage = resolveCorrectionLineage(correctionEvents, project.id, caption.id, caption.text);
    if (!lineage) continue;
    if (Date.parse(lineage.sourceEvent.createdAt) < consentTime) continue;
    if (lineage.finalEvent.suggestionKind === 'formatting') continue;
    // A correction that began from a manually-authored caption is not machine-transcription truth.
    if (!lineage.sourceEvent.sourceTimingSource || lineage.sourceEvent.sourceTimingSource === 'manual') continue;
    if (lineage.originalText.length > MAX_TEXT_LENGTH || lineage.correctedText.length > MAX_TEXT_LENGTH) continue;
    if (!containsKhmer(`${lineage.originalText}${lineage.correctedText}`)) continue;

    const id = crypto.createHash('sha256').update(JSON.stringify({
      schema: 'sthang-khmer-contribution-v1',
      mediaFingerprint,
      captionId: caption.id,
      startMs: Math.round(caption.startMs),
      endMs: Math.round(caption.endMs),
      originalText: comparableText(lineage.originalText),
      correctedText: comparableText(lineage.correctedText),
    })).digest('hex').slice(0, 32);

    out.push({
      id,
      projectId: project.id,
      captionId: caption.id,
      correctionEventIds: lineage.events.map((event) => event.id),
      startMs: Math.round(caption.startMs),
      endMs: Math.round(caption.endMs),
      originalText: lineage.originalText,
      correctedText: lineage.correctedText,
      sourceTimingSource: lineage.sourceEvent.sourceTimingSource,
      sourceTextModel: lineage.sourceEvent.sourceTextModel,
      sourceEngineVersion: lineage.sourceEvent.sourceEngineVersion,
      createdAt: new Date().toISOString(),
      status: 'queued',
      attempts: 0,
    });
  }
  return out;
}
