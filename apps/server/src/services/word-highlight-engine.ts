import {
  compileHighlightPlan, hasWordTimingEvidence, highlightDisplayUnits, resolveCaptionWordTiming, validateMarkedWordTiming,
  type CaptionProject, type CaptionSegment, type CaptionWord, type CaptionWordTiming, type Coverage,
  type HighlightDisplayUnit, type WordIssue,
} from '@kcs/shared';
import { ensureNormalizedAudio, mediaFingerprint, stageSignature } from './cache.js';
import { captionWordTimingRevision } from './caption-word-timing.js';
import {
  alignWindowsLocally, LocalTimingUnavailableError, prepareFullEmission,
  type AlignWindowsRequest, type AlignWindowsResult, type WindowAttempt, type WindowClock, type WindowVariant,
  type WindowVariantName, type WindowWord,
} from './local-timing.js';
import { store } from './store.js';

export const wordHighlightEngineVersion = 'word-highlight-v1';
// KFA's trellis is float64: the hard caps reserve 8 MB with context and 64 MB target-only.
export const wordHighlightBudgets = Object.freeze({ maxIds: 512, maxCells: 1_000_000, maxCellsTargetOnly: 8_000_000 });
const maximumTargetMs = 60_000;
const maximumTargetCharacters = 2_000;
const regularPad = 1_500;
const widePad = 3_000;
const maximumNeighborMs = 8_000;
const maximumInternalGapMs = 150;
const minimumPeak = 2 ** -14;
const graphemes = new Intl.Segmenter('km', { granularity: 'grapheme' });
const optionalSymbol = /^[\p{Sc}%+\-−]$/u;
const ignored = /^[\s\p{Z}\p{Cf}\p{P}\p{S}]$/u;

type EvidenceTrack = CaptionWordTiming & { evidence: 2 };
export type ExpectedWordHighlightMedia = Pick<CaptionProject['media'], 'filename' | 'size'>;
export interface WordHighlightOutcome {
  id: string;
  status: 'candidate' | 'reused' | 'locked' | 'outside-media' | 'budget' | 'error' | 'stale';
  coverage?: Coverage;
  track?: EvidenceTrack;
  basis?: string;
  dependencies?: Record<string, string>;
  variant?: WindowVariantName;
  conflicts?: string[];
  diagnostics: { attempts: WindowAttempt[]; mappingFailure?: boolean };
}

export interface WordHighlightDependencies {
  getProject: (id: string) => Promise<CaptionProject | undefined | null>;
  ensureNormalizedAudio: typeof ensureNormalizedAudio;
  prepareFullEmission: typeof prepareFullEmission;
  alignWindowsLocally: typeof alignWindowsLocally;
  clock: () => number;
  onTargetMeasured?: (id: string, elapsedMs: number) => void;
}

export class WordHighlightProjectError extends Error {
  constructor(readonly status: 404 | 409) {
    super(status === 404 ? 'Project not found.' : 'The source media changed. Refresh the project and try again.');
    this.name = 'WordHighlightProjectError';
  }
}

interface PlannedWindows {
  variants: WindowVariant[];
  consulted: CaptionSegment[];
}

interface TargetPlan extends PlannedWindows {
  caption: CaptionSegment;
}

interface MeasuredSpan {
  units: HighlightDisplayUnit[];
  word: CaptionWord & { startMs: number; endMs: number };
}

interface CandidateDraft {
  outcome: WordHighlightOutcome;
  plan: TargetPlan;
  words: CaptionWord[];
  spans: MeasuredSpan[];
  durationMs: number;
}

export function orderHighlightCaptions(captions: CaptionSegment[]): CaptionSegment[] {
  return captions.map((caption, index) => ({ caption, index }))
    .filter(({ caption }) => /[^\s\p{Cf}]/u.test(caption.text))
    .sort((a, b) => a.caption.startMs - b.caption.startMs || a.caption.endMs - b.caption.endMs || a.index - b.index)
    .map(({ caption }) => caption);
}

function validCue(caption: CaptionSegment, durationMs: number) {
  return Number.isFinite(caption.startMs) && Number.isFinite(caption.endMs)
    && caption.startMs >= 0 && caption.endMs > caption.startMs && caption.endMs <= durationMs;
}

export function planHighlightWindows(
  order: CaptionSegment[], index: number, durationMs: number,
): PlannedWindows {
  const target = order[index];
  const previous = order[index - 1];
  const next = order[index + 1];
  const consulted = new Map([[target.id, target]]);
  if (previous) consulted.set(previous.id, previous);
  if (next) consulted.set(next.id, next);
  function eligible(neighbor: CaptionSegment | undefined, gap: number) {
    return !!neighbor && validCue(neighbor, durationMs) && gap >= 0 && gap <= regularPad
      && neighbor.endMs - neighbor.startMs <= maximumNeighborMs;
  }
  const leftGap = previous ? target.startMs - previous.endMs : Infinity;
  const rightGap = next ? next.startMs - target.endMs : Infinity;
  const left = eligible(previous, leftGap) ? previous : undefined;
  const right = eligible(next, rightGap) ? next : undefined;

  function makeVariant(name: WindowVariantName, padding: number, before?: CaptionSegment, after?: CaptionSegment): WindowVariant {
    let startMs = before?.startMs ?? Math.max(0, target.startMs - padding);
    let endMs = after?.endMs ?? Math.min(durationMs, target.endMs + padding);
    const earliest = startMs;
    const latest = endMs;
    for (const other of order) {
      if (other === target) continue;
      if (!before && other.startMs < target.startMs && other.endMs > earliest) {
        consulted.set(other.id, other);
        startMs = Math.max(startMs, Math.min(target.startMs, other.endMs));
      }
      if (!after && other.endMs > target.endMs && other.startMs < latest) {
        consulted.set(other.id, other);
        endMs = Math.min(endMs, Math.max(target.endMs, other.startMs));
      }
    }
    const lines = [before, target, after].flatMap((cue) => cue
      ? [{ owner: cue.id, text: cue.text, target: cue === target }] : []);
    return { name, startMs, endMs, lines };
  }

  const variants = [makeVariant('full', regularPad, left, right)];
  if (left && right) {
    variants.push(leftGap > rightGap
      ? makeVariant('drop-far', regularPad, undefined, right)
      : makeVariant('drop-far', regularPad, left));
  }
  const sole = makeVariant('target', regularPad);
  const alternate = makeVariant('target-wide', widePad);
  variants.push(sole);
  if (alternate.startMs !== sole.startMs || alternate.endMs !== sole.endMs) variants.push(alternate);
  return { variants, consulted: [...consulted.values()] };
}

export function highlightFrameTime(frame: number, clock: WindowClock): number {
  return 1_000 * frame * clock.sampleCount / (clock.frameCount * clock.sampleRate)
    + 1_000 * (clock.sampleOrigin ?? 0) / clock.sampleRate;
}

interface LexicalCharacter {
  value: string;
  optional: boolean;
  unit: number;
}

function characterStream(text: string, units: HighlightDisplayUnit[]): LexicalCharacter[] {
  const stream: LexicalCharacter[] = [];
  let index = 0;
  for (const grapheme of graphemes.segment(text)) {
    while (index < units.length && units[index].endOffset <= grapheme.index) index += 1;
    const unit = units[index]?.startOffset <= grapheme.index ? index : -1;
    const normalized = grapheme.segment.normalize('NFC').replaceAll('ឲ', 'ឱ').replaceAll('្ដ', '្ត')
      .replace(/[០-៩]/gu, (digit) => String(digit.charCodeAt(0) - 0x17e0))
      .replace(/\p{Script=Latin}/gu, (letter) => letter.toLowerCase());
    for (const value of normalized) {
      const optional = optionalSymbol.test(value);
      if (optional || !ignored.test(value)) stream.push({ value, optional, unit });
    }
  }
  return stream;
}

function wordCore(text: string) {
  return characterStream(text, []).filter((character) => !character.optional).map((character) => character.value).join('');
}

function pairCharacters(caption: LexicalCharacter[], worker: LexicalCharacter[]) {
  type Pair = { unit: number; word: number };
  const prefix: Pair[] = [];
  const suffix: Pair[] = [];
  let a = 0;
  let b = 0;
  let endA = caption.length;
  let endB = worker.length;
  function matchStep(left?: LexicalCharacter, right?: LexicalCharacter) {
    if (left && right && left.value === right.value) return 'pair';
    if (left?.optional && !right?.optional) return 'left';
    if (right?.optional && !left?.optional) return 'right';
    return 'stop';
  }
  while (a < endA || b < endB) {
    const left = caption[a];
    const right = worker[b];
    const step = matchStep(left, right);
    if (step === 'stop') break;
    if (step === 'pair') prefix.push({ unit: left.unit, word: right.unit });
    if (step !== 'right') a += 1;
    if (step !== 'left') b += 1;
  }
  while (endA > a || endB > b) {
    const left = endA > a ? caption[endA - 1] : undefined;
    const right = endB > b ? worker[endB - 1] : undefined;
    const step = matchStep(left, right);
    if (step === 'stop') break;
    if (step === 'pair') suffix.push({ unit: left!.unit, word: right!.unit });
    if (step !== 'right') endA -= 1;
    if (step !== 'left') endB -= 1;
  }
  return {
    pairs: [...prefix, ...suffix.reverse()].filter(({ unit, word }) => unit >= 0 && word >= 0),
    unmatchedUnits: new Set(caption.slice(a, endA).map(({ unit }) => unit)),
    unmatchedWords: new Set(worker.slice(b, endB).map(({ unit }) => unit)),
    mappingFailure: a < endA || b < endB,
  };
}

function placeholder(id: string, unit: HighlightDisplayUnit, issue: WordIssue): CaptionWord {
  return {
    id: `${id}:${unit.startOffset}-${unit.endOffset}`, ...unit,
    startMs: null, endMs: null, source: 'estimated', needsReview: true, issue,
  };
}

export function mapHighlightWords(caption: CaptionSegment, anchors: WindowWord[], clock: WindowClock) {
  const units = highlightDisplayUnits(caption.text);
  let transcript = '';
  const anchorOffsets = anchors.map(({ text }) => {
    const startOffset = transcript.length;
    transcript += text;
    return { startOffset, endOffset: transcript.length };
  });
  const mapping = pairCharacters(characterStream(caption.text, units), characterStream(transcript, anchorOffsets));
  const { pairs, unmatchedUnits, unmatchedWords } = mapping;
  const lastInUnit = new Map<number, number>();
  const lastInWord = new Map<number, number>();
  pairs.forEach(({ unit, word }, index) => {
    lastInUnit.set(unit, index);
    lastInWord.set(word, index);
  });
  const words: (CaptionWord | undefined)[] = units.map((unit, index) =>
    placeholder(caption.id, unit, unmatchedUnits.has(index) ? 'text-mismatch' : 'missing'));
  const spans: MeasuredSpan[] = [];
  let first = 0;
  pairs.forEach(({ unit, word }, index) => {
    if (lastInUnit.get(unit) !== index || lastInWord.get(word) !== index) return;
    const firstPair = pairs[first];
    first = index + 1;
    const componentUnits = units.slice(firstPair.unit, unit + 1);
    const componentAnchors = anchors.slice(firstPair.word, word + 1);
    const start = componentAnchors[0];
    const end = componentAnchors[componentAnchors.length - 1];
    let issue: WordIssue | undefined;
    if (componentUnits.some((_, offset) => unmatchedUnits.has(firstPair.unit + offset))
      || componentAnchors.some((_, offset) => unmatchedWords.has(firstPair.word + offset))) issue = 'text-mismatch';
    else if (componentAnchors.some((anchor, i) => i > 0
      && highlightFrameTime(anchor.startFrame - componentAnchors[i - 1].endFrame, clock) - highlightFrameTime(0, clock) > maximumInternalGapMs)) issue = 'discontinuous';
    else if (componentAnchors.every(({ peak }) => peak < minimumPeak)) issue = 'no-fit';
    if (issue) {
      componentUnits.forEach((span, i) => { words[firstPair.unit + i] = placeholder(caption.id, span, issue); });
      return;
    }
    const startOffset = units[firstPair.unit].startOffset;
    const endOffset = units[unit].endOffset;
    const grouped = componentUnits.length > 1;
    spans.push({
      units: componentUnits,
      word: {
        id: `${caption.id}:${startOffset}-${endOffset}`, startOffset, endOffset,
        startMs: highlightFrameTime(start.startFrame, clock), endMs: highlightFrameTime(end.endFrame, clock),
        source: 'aligned', method: grouped ? 'kfa-group' : 'kfa',
        ...(grouped ? { members: componentUnits.map(({ startOffset: s, endOffset: e }) => [s, e]) } : {}),
      },
    });
    words.fill(undefined, firstPair.unit, unit + 1);
  });
  return { words: words.filter((word) => word !== undefined), spans, mappingFailure: mapping.mappingFailure };
}

function overlaps(a: HighlightDisplayUnit, b: HighlightDisplayUnit) {
  return a.startOffset < b.endOffset && b.startOffset < a.endOffset;
}

function preserveManual(caption: CaptionSegment, words: CaptionWord[], spans: MeasuredSpan[]) {
  if (caption.wordTiming?.text !== caption.text) return { words, spans };
  const manual = caption.wordTiming.words.filter(({ source }) => source === 'manual').map((word): CaptionWord => {
    const units = highlightDisplayUnits(caption.text.slice(word.startOffset, word.endOffset));
    const members = units.length > 1
      ? units.map(({ startOffset, endOffset }, index): [number, number] => [
        index === 0 ? word.startOffset : word.startOffset + startOffset,
        index === units.length - 1 ? word.endOffset : word.startOffset + endOffset,
      ]) : undefined;
    return { ...word, method: 'manual', ...(word.members ? {} : members ? { members } : {}) };
  });
  if (!manual.length) return { words, spans };

  function leftovers(unit: HighlightDisplayUnit, issue: WordIssue) {
    const remainder = [];
    let start = unit.startOffset;
    for (const protectedWord of manual) {
      if (!overlaps(unit, protectedWord)) continue;
      if (protectedWord.startOffset > start) remainder.push({ startOffset: start, endOffset: protectedWord.startOffset });
      start = Math.max(start, protectedWord.endOffset);
    }
    if (start < unit.endOffset) remainder.push({ startOffset: start, endOffset: unit.endOffset });
    return remainder.filter(({ startOffset, endOffset }) => characterStream(caption.text.slice(startOffset, endOffset), [])
      .some(({ optional }) => !optional)).map((span) => placeholder(caption.id, span, issue));
  }
  const preserved = [...manual, ...words.flatMap((word) => manual.some((item) => overlaps(word, item))
    ? leftovers(word, 'manual-conflict') : [word])];
  const automatic: MeasuredSpan[] = [];
  for (const span of spans) {
    if (manual.some((word) => overlaps(word, span.word))) {
      preserved.push(...span.units.flatMap((unit) => leftovers(unit, 'manual-conflict')));
    } else automatic.push(span);
  }
  return { words: preserved, spans: automatic };
}

interface TimeInterval {
  startMs: number;
  endMs: number;
}

interface Occurrence extends TimeInterval {
  core: string;
}

function intersection(a: TimeInterval, b: TimeInterval): TimeInterval {
  return { startMs: Math.max(a.startMs, b.startMs), endMs: Math.min(a.endMs, b.endMs) };
}

function intersects(a: TimeInterval, b: TimeInterval) {
  return Math.max(a.startMs, b.startMs) < Math.min(a.endMs, b.endMs);
}

function strictlyContains(outer: TimeInterval, inner: TimeInterval) {
  return outer.startMs <= inner.startMs && inner.endMs <= outer.endMs
    && (outer.startMs < inner.startMs || inner.endMs < outer.endMs);
}

export function highlightOccurrencesCollide(a: Occurrence, b: Occurrence): boolean {
  const overlap = intersection(a, b);
  return (a.startMs === b.startMs && a.endMs === b.endMs)
    || (a.core === b.core && overlap.endMs - overlap.startMs >= 0.5 * Math.min(a.endMs - a.startMs, b.endMs - b.startMs));
}

function applyOccurrenceGuard(drafts: CandidateDraft[], order: CaptionSegment[]) {
  const byId = new Map(drafts.map((draft) => [draft.plan.caption.id, draft]));
  const impacted = new Map<MeasuredSpan, Set<string>>();
  function addConflict(span: MeasuredSpan, owner: string) {
    const conflicts = impacted.get(span) ?? new Set();
    conflicts.add(owner);
    impacted.set(span, conflicts);
  }
  function occurrence(caption: CaptionSegment, word: CaptionWord & { startMs: number; endMs: number }) {
    return { core: wordCore(caption.text.slice(word.startOffset, word.endOffset)), startMs: word.startMs, endMs: word.endMs };
  }
  const occurrences = drafts.map(({ plan, spans }) => spans.map((span) => ({
    span, occurrence: occurrence(plan.caption, span.word),
  })));
  function dependOn(draft: CandidateDraft, peer: CaptionSegment) {
    const dependencies = draft.outcome.dependencies!;
    if (!Object.hasOwn(dependencies, peer.id)) {
      Object.defineProperty(dependencies, peer.id, {
        value: captionWordTimingRevision(peer), enumerable: true, writable: true, configurable: true,
      });
    }
  }
  const retained = new Map<string, Occurrence[]>();
  function persisted(caption: CaptionSegment) {
    const cached = retained.get(caption.id);
    if (cached) return cached;
    const validated = validateMarkedWordTiming(caption.text, caption.wordTiming);
    const anchors = !validated.ok ? [] : validated.timing.words.flatMap((word) =>
      word.source === 'aligned' && word.startMs !== null && word.endMs !== null && !word.needsReview && !word.issue
        ? [occurrence(caption, { ...word, startMs: word.startMs, endMs: word.endMs })] : []);
    retained.set(caption.id, anchors);
    return anchors;
  }
  const protectedIntervals = new Map<string, TimeInterval[]>();
  function protectedPaint(caption: CaptionSegment) {
    const cached = protectedIntervals.get(caption.id);
    if (cached) return cached;
    function collect(track: CaptionWordTiming | undefined) {
      if (!Array.isArray(track?.words)) return [];
      const bounds = new Map(track.words.flatMap((word) =>
        word && (caption.timingLocked || word.source === 'manual') && word.startMs !== null && word.endMs !== null
          ? [[word.startOffset, word] as const] : []));
      if (!bounds.size) return [];
      return compileHighlightPlan({ ...caption, wordTiming: track }, 'measured-and-manual').spans.flatMap((paint) => {
        const word = bounds.get(paint.startOffset);
        return word?.endOffset === paint.endOffset && word.startMs !== null && word.endMs !== null
          ? [intersection(caption, { startMs: word.startMs, endMs: word.endMs })] : [];
      });
    }
    const intervals = collect(caption.wordTiming);
    const draft = byId.get(caption.id);
    if (draft?.words.some(({ source }) => source === 'manual')) {
      const words = [...draft.words, ...draft.spans.map(({ word }) => word)].sort((a, b) => a.startOffset - b.startOffset);
      intervals.push(...collect({ version: 1, evidence: 2, text: caption.text, words }));
    }
    protectedIntervals.set(caption.id, intervals);
    return intervals;
  }

  for (const [i, draft] of drafts.entries()) {
    const { caption, consulted } = draft.plan;
    const peers = new Map(consulted.map((peer) => [peer.id, peer]));
    peers.delete(caption.id);
    // Nested cues need no stored track or candidate in this request to affect geometry.
    for (const peer of order) {
      if (peer.startMs >= caption.endMs) break;
      if (peer.id === caption.id || !intersects(caption, peer)) continue;
      peers.set(peer.id, peer);
      dependOn(draft, peer);
      const regions = strictlyContains(peer, caption) ? protectedPaint(peer) : [intersection(caption, peer)];
      for (const span of draft.spans) {
        const clipped = intersection(caption, span.word);
        if (regions.some((region) => intersects(clipped, region))) addConflict(span, peer.id);
      }
    }

    for (const { span, occurrence: own } of occurrences[i]) {
      for (const peer of peers.values()) {
        if (persisted(peer).some((other) => highlightOccurrencesCollide(own, other))) addConflict(span, peer.id);
      }
      for (let j = i + 1; j < drafts.length; j += 1) {
        const peerDraft = drafts[j];
        const peer = peerDraft.plan.caption;
        for (const { span: other, occurrence: competing } of occurrences[j]) {
          if (!highlightOccurrencesCollide(own, competing)) continue;
          addConflict(span, peer.id);
          addConflict(other, caption.id);
          dependOn(draft, peer);
          dependOn(peerDraft, caption);
        }
      }
    }
  }
  for (const draft of drafts) {
    const { caption } = draft.plan;
    const conflicts = new Set<string>();
    for (const span of draft.spans) {
      const owners = impacted.get(span);
      if (!owners) draft.words.push(span.word);
      else {
        owners.forEach((id) => conflicts.add(id));
        draft.words.push(...span.units.map((unit) => placeholder(caption.id, unit, 'ambiguous-occurrence')));
      }
    }
    if (conflicts.size) draft.outcome.conflicts = [...conflicts].sort();
  }
}

function evidenceBasis(caption: CaptionSegment, variant: WindowVariant, project: CaptionProject, clock: WindowClock) {
  const context = variant.lines.filter((line) => !line.target).map((line) => {
    const { id, text, startMs, endMs } = project.captions.find((cue) => cue.id === line.owner)!;
    return { id, text, startMs, endMs };
  });
  const { id, text, startMs, endMs } = caption;
  return stageSignature({
    engine: wordHighlightEngineVersion, mediaFingerprint: mediaFingerprint(project),
    target: { id, text, startMs, endMs }, context, variant: variant.name, aliasesVersion: 1, unitsVersion: 1, clock,
  });
}

function outcome(id: string, status: WordHighlightOutcome['status'], attempts: WindowAttempt[] = []): WordHighlightOutcome {
  return { id, status, diagnostics: { attempts } };
}

function draftCandidate(
  plan: TargetPlan, result: AlignWindowsResult['targets'][number], project: CaptionProject, clock: WindowClock,
): CandidateDraft | WordHighlightOutcome {
  const { caption, variants, consulted } = plan;
  const last = result.attempts.at(-1);
  const variant = variants.find(({ name }) => name === last?.variant);
  if (!variant || last?.result === 'error') return outcome(caption.id, 'error', result.attempts);
  if (last?.result === 'budget') return outcome(caption.id, 'budget', result.attempts);
  const targetLine = variant.lines.findIndex(({ target }) => target);
  const measurement = result.words ? mapHighlightWords(caption, result.words.filter(({ line }) => line === targetLine), clock) : {
    words: highlightDisplayUnits(caption.text).map((unit) => placeholder(caption.id, unit, 'no-fit')),
    spans: [], mappingFailure: false,
  };
  const preserved = preserveManual(caption, measurement.words, measurement.spans);
  const candidate = outcome(caption.id, 'candidate', result.attempts);
  candidate.variant = variant.name;
  candidate.dependencies = Object.fromEntries(consulted.map((cue) => [cue.id, captionWordTimingRevision(cue)]));
  candidate.basis = evidenceBasis(caption, variant, project, clock);
  if (measurement.mappingFailure) candidate.diagnostics.mappingFailure = true;
  return { outcome: candidate, plan, ...preserved, durationMs: highlightFrameTime(clock.frameCount, clock) };
}

const defaultDependencies: WordHighlightDependencies = {
  getProject: (id) => store.get(id),
  ensureNormalizedAudio, prepareFullEmission, alignWindowsLocally, clock: () => performance.now(),
};

export function createWordHighlightEngine(dependencies: WordHighlightDependencies = defaultDependencies) {
  async function loadProject(projectId: string, expected: ExpectedWordHighlightMedia) {
    const project = await dependencies.getProject(projectId);
    if (!project) throw new WordHighlightProjectError(404);
    if (project.media.filename !== expected.filename || project.media.size !== expected.size) throw new WordHighlightProjectError(409);
    return project;
  }

  return {
    async prepare(projectId: string, expectedMedia: ExpectedWordHighlightMedia) {
      const project = await loadProject(projectId, expectedMedia);
      const normalized = await dependencies.ensureNormalizedAudio(project);
      await dependencies.prepareFullEmission(normalized.outputPath, project.id);
      const latest = await loadProject(projectId, expectedMedia);
      if (mediaFingerprint(latest) !== mediaFingerprint(project)) throw new WordHighlightProjectError(409);
      return { ready: true as const, durationMs: normalized.durationMs, mediaFingerprint: mediaFingerprint(project) };
    },

    async candidates(projectId: string, expectedMedia: ExpectedWordHighlightMedia, ids: string[]) {
      const project = await loadProject(projectId, expectedMedia);
      const fingerprint = mediaFingerprint(project);
      const order = orderHighlightCaptions(project.captions);
      const indices = new Map(order.map(({ id }, index) => [id, index]));
      const results = new Map<string, WordHighlightOutcome>();
      const eligible = ids.flatMap((id) => {
        const index = indices.get(id);
        const caption = index === undefined ? undefined : order[index];
        if (!caption || index === undefined) results.set(id, outcome(id, 'stale'));
        else if (caption.timingLocked) results.set(id, outcome(id, 'locked'));
        else if (!hasWordTimingEvidence(caption.wordTiming) && resolveCaptionWordTiming(caption).state === 'ready') {
          results.set(id, { ...outcome(id, 'reused'), coverage: 'full-individual' });
        } else if (caption.text.length > maximumTargetCharacters || caption.endMs - caption.startMs > maximumTargetMs) {
          results.set(id, outcome(id, 'budget'));
        } else return [{ index, caption }];
        return [];
      });
      if (!eligible.length) return { mediaFingerprint: fingerprint, results: ids.map((id) => results.get(id)!) };
      const normalized = await dependencies.ensureNormalizedAudio(project);
      const plans = eligible.flatMap(({ caption, index }) => {
        if (validCue(caption, normalized.durationMs)) return [{ caption, ...planHighlightWindows(order, index, normalized.durationMs) }];
        results.set(caption.id, outcome(caption.id, 'outside-media'));
        return [];
      });
      if (!plans.length) return { mediaFingerprint: fingerprint, results: ids.map((id) => results.get(id)!) };
      const request: AlignWindowsRequest = {
        budgets: wordHighlightBudgets,
        targets: plans.map(({ caption, variants }) => ({ id: caption.id, variants })),
      };
      try {
        const measured = await dependencies.alignWindowsLocally(normalized.outputPath, projectId, request);
        const byId = new Map(measured.targets.map((target) => [target.id, target]));
        const drafts: CandidateDraft[] = [];
        for (const plan of plans) {
          const started = dependencies.clock();
          const measurement = byId.get(plan.caption.id);
          try {
            const result = measurement && draftCandidate(plan, measurement, project, measurement.clock ?? measured.clock);
            if (result && 'plan' in result) drafts.push(result);
            else results.set(plan.caption.id, result ?? outcome(plan.caption.id, 'error'));
          } catch {
            results.set(plan.caption.id, outcome(plan.caption.id, 'error', measurement?.attempts));
          } finally {
            dependencies.onTargetMeasured?.(plan.caption.id, dependencies.clock() - started + (measurement?.elapsedMs ?? 0));
          }
        }
        applyOccurrenceGuard(drafts, order);
        const latest = await loadProject(projectId, expectedMedia);
        if (mediaFingerprint(latest) !== fingerprint) throw new WordHighlightProjectError(409);
        const latestById = new Map(latest.captions.map((caption) => [caption.id, caption]));
        for (const draft of drafts) {
          const { caption } = draft.plan;
          const candidate = draft.outcome;
          const stale = Object.entries(candidate.dependencies!).some(([id, revision]) => {
            const latestCaption = latestById.get(id);
            return !latestCaption || captionWordTimingRevision(latestCaption) !== revision;
          });
          if (stale) {
            results.set(caption.id, outcome(caption.id, 'stale', candidate.diagnostics.attempts));
            continue;
          }
          const verified = validateMarkedWordTiming(caption.text, {
            version: 1, evidence: 2, text: caption.text, basis: candidate.basis,
            words: draft.words.sort((a, b) => a.startOffset - b.startOffset),
          }, draft.durationMs);
          if (verified.ok) {
            candidate.track = verified.timing;
            candidate.coverage = compileHighlightPlan({ ...caption, wordTiming: verified.timing }, 'measured-and-manual').coverage;
            results.set(caption.id, candidate);
          } else results.set(caption.id, outcome(caption.id, 'error', candidate.diagnostics.attempts));
        }
      } catch (error) {
        if (error instanceof LocalTimingUnavailableError || error instanceof WordHighlightProjectError) throw error;
        for (const { caption } of plans) results.set(caption.id, outcome(caption.id, 'error'));
      }
      return { mediaFingerprint: fingerprint, results: ids.map((id) => results.get(id)!) };
    },
  };
}

export const wordHighlightEngine = createWordHighlightEngine();
