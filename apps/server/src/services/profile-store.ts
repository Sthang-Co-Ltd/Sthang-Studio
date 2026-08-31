import fs from 'node:fs/promises';
import path from 'node:path';
import { nanoid } from 'nanoid';
import type {
  AppProfile,
  CaptionProject,
  CaptionSegment,
  ConsentState,
  CorrectionEvent,
  CorrectionRule,
  CorrectionSuggestionKind,
  TimingQuality,
  TimingSource,
} from '@kcs/shared';
import { config } from '../config.js';
import { APP_VERSION } from '../version.js';
import { normalizeForMatch } from './tokenizer.js';

const DEFAULT_PROFILE: AppProfile = {
  version: 1,
  defaultVocabulary: [],
  styles: [{ id: 'my-tiktok-style', name: 'My TikTok Style', mode: 'dynamic', maxChars: 18 }],
  topicPacks: [],
  correctionRules: [],
  correctionEvents: [],
  preferences: {
    reviewPreRollMs: 450,
    reviewPostRollMs: 300,
    autoLoopReview: true,
    autoPlayNextReview: true,
    reviewFocusMode: 'brackets-label',
    qaProfileId: 'khmer-tiktok-comfortable',
    qaCustom: {},
    autosaveDelayMs: 2200,
    waveformMode: 'waveform',
    waveformZoom: 2,
    analyticsConsent: 'unset',
    khmerContributionConsent: 'unset',
  },
  updatedAt: new Date(0).toISOString(),
};

function uniqueLines(lines: unknown): string[] {
  if (!Array.isArray(lines)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of lines) {
    const line = String(value || '').trim().slice(0, 300);
    if (!line) continue;
    const key = line.toLocaleLowerCase('en');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
    if (out.length >= 300) break;
  }
  return out;
}

function consentState(value: unknown): ConsentState {
  return ['declined', 'granted'].includes(String(value)) ? value as ConsentState : 'unset';
}

function timingSource(value: unknown): TimingSource | undefined {
  return ['stt', 'stt-split', 'interpolated', 'manual'].includes(String(value)) ? value as TimingSource : undefined;
}

function timingQuality(value: unknown): TimingQuality | undefined {
  return ['high', 'medium', 'low'].includes(String(value)) ? value as TimingQuality : undefined;
}

function normalizeProfile(value: unknown): AppProfile {
  const raw = value && typeof value === 'object' ? value as Partial<AppProfile> : {};
  const styles = Array.isArray(raw.styles)
    ? raw.styles
      .filter((x): x is NonNullable<typeof x> => Boolean(x && typeof x === 'object'))
      .map((x) => ({
        id: String(x.id || nanoid(8)).slice(0, 80),
        name: String(x.name || 'Caption style').trim().slice(0, 80),
        mode: ['dynamic', 'word', 'phrase', 'single-line'].includes(String(x.mode)) ? x.mode : 'dynamic',
        maxChars: Math.max(6, Math.min(80, Number(x.maxChars || 18))),
      }))
      .slice(0, 20)
    : DEFAULT_PROFILE.styles;

  const topicPacks = Array.isArray(raw.topicPacks)
    ? raw.topicPacks
      .filter((x): x is NonNullable<typeof x> => Boolean(x && typeof x === 'object'))
      .map((x) => ({
        id: String(x.id || nanoid(8)).slice(0, 80),
        name: String(x.name || 'Topic pack').trim().slice(0, 80),
        description: String(x.description || '').trim().slice(0, 6000),
        vocabulary: uniqueLines(x.vocabulary),
        createdAt: String(x.createdAt || new Date().toISOString()),
        updatedAt: String(x.updatedAt || new Date().toISOString()),
      }))
      .slice(0, 50)
    : [];

  const correctionRules = Array.isArray(raw.correctionRules)
    ? raw.correctionRules
      .filter((x): x is CorrectionRule => Boolean(x && typeof x === 'object' && x.canonical))
      .map((x) => ({
        id: String(x.id || nanoid(8)),
        kind: x.kind === 'alias' ? 'alias' as const : 'protected-term' as const,
        canonical: String(x.canonical).trim().slice(0, 300),
        aliases: uniqueLines(x.aliases),
        sourceCorrectionId: x.sourceCorrectionId ? String(x.sourceCorrectionId) : undefined,
        createdAt: String(x.createdAt || new Date().toISOString()),
      }))
      .slice(-500)
    : [];

  const correctionEvents = Array.isArray(raw.correctionEvents)
    ? raw.correctionEvents
      .filter((x): x is CorrectionEvent => Boolean(x && typeof x === 'object' && x.id && x.projectId))
      .map((x) => ({
        ...x,
        originalText: String(x.originalText || '').slice(0, 1000),
        correctedText: String(x.correctedText || '').slice(0, 1000),
        suggestedVocabularyLine: String(x.suggestedVocabularyLine || '').slice(0, 600),
        sourceTimingSource: timingSource(x.sourceTimingSource),
        sourceTimingQuality: timingQuality(x.sourceTimingQuality),
        sourceConfidence: Number.isFinite(Number(x.sourceConfidence)) ? Math.max(0, Math.min(1, Number(x.sourceConfidence))) : undefined,
        sourceTextModel: x.sourceTextModel ? String(x.sourceTextModel).slice(0, 120) : undefined,
        sourceEngineVersion: x.sourceEngineVersion ? String(x.sourceEngineVersion).slice(0, 80) : undefined,
      }))
      .slice(-500)
    : [];

  const preferences: AppProfile['preferences'] = raw.preferences && typeof raw.preferences === 'object'
    ? {
      reviewPreRollMs: Math.max(0, Math.min(3000, Number(raw.preferences.reviewPreRollMs ?? 450))),
      reviewPostRollMs: Math.max(0, Math.min(3000, Number(raw.preferences.reviewPostRollMs ?? 300))),
      autoLoopReview: raw.preferences.autoLoopReview !== false,
      autoPlayNextReview: raw.preferences.autoPlayNextReview !== false,
      reviewFocusMode: ['brackets-label', 'brackets', 'off'].includes(String(raw.preferences.reviewFocusMode))
        ? raw.preferences.reviewFocusMode as 'brackets-label' | 'brackets' | 'off'
        : 'brackets-label',
      qaProfileId: ['khmer-tiktok-fast', 'khmer-tiktok-comfortable', 'capcut-srt', 'accessibility', 'custom'].includes(String(raw.preferences.qaProfileId))
        ? raw.preferences.qaProfileId
        : 'khmer-tiktok-comfortable',
      qaCustom: raw.preferences.qaCustom && typeof raw.preferences.qaCustom === 'object' ? raw.preferences.qaCustom : {},
      autosaveDelayMs: Math.max(800, Math.min(10000, Number(raw.preferences.autosaveDelayMs ?? 2200))),
      waveformMode: raw.preferences.waveformMode === 'spectrum' ? 'spectrum' : 'waveform',
      waveformZoom: Math.max(1, Math.min(24, Number(raw.preferences.waveformZoom ?? 2))),
      analyticsConsent: consentState(raw.preferences.analyticsConsent),
      khmerContributionConsent: consentState(raw.preferences.khmerContributionConsent),
    }
    : DEFAULT_PROFILE.preferences;

  return {
    version: 1,
    defaultVocabulary: uniqueLines(raw.defaultVocabulary),
    styles: styles.length ? styles : DEFAULT_PROFILE.styles,
    topicPacks,
    correctionRules,
    correctionEvents,
    preferences,
    updatedAt: String(raw.updatedAt || new Date().toISOString()),
  };
}

async function load(): Promise<AppProfile> {
  try {
    return normalizeProfile(JSON.parse(await fs.readFile(config.profileFile, 'utf8')));
  } catch {
    return { ...DEFAULT_PROFILE, preferences: { ...DEFAULT_PROFILE.preferences }, updatedAt: new Date().toISOString() };
  }
}

async function save(profile: AppProfile) {
  const normalized = normalizeProfile({ ...profile, updatedAt: new Date().toISOString() });
  await fs.mkdir(path.dirname(config.profileFile), { recursive: true });
  await fs.writeFile(config.profileFile, JSON.stringify(normalized, null, 2), 'utf8');
  return normalized;
}

function looksKhmer(value: string) {
  return /\p{Script=Khmer}/u.test(value);
}

function looksLatinEntity(value: string) {
  return /[A-Za-z]/.test(value) && (/[A-Z]/.test(value) || /\d/.test(value) || value.trim().split(/\s+/).length <= 5);
}

function compactComparable(value: string) {
  return value.normalize('NFC').toLocaleLowerCase('en').replace(/[\p{P}\p{S}\s]/gu, '');
}

function suggestCorrection(originalText: string, correctedText: string): {
  kind: CorrectionSuggestionKind;
  line: string;
} {
  const original = originalText.trim();
  const corrected = correctedText.trim();
  if (looksKhmer(original) && looksLatinEntity(corrected)) {
    return { kind: 'phonetic-alias', line: `${corrected} | ${original}` };
  }
  if (compactComparable(original) === compactComparable(corrected) || normalizeForMatch(original) === normalizeForMatch(corrected)) {
    return { kind: 'formatting', line: corrected };
  }
  if (looksLatinEntity(corrected)) {
    return { kind: 'protected-term', line: corrected };
  }
  return { kind: 'review', line: corrected };
}

function addVocabularyLine(lines: string[], line: string) {
  const cleaned = line.trim();
  if (!cleaned) return lines;
  const key = cleaned.toLocaleLowerCase('en');
  if (lines.some((x) => x.toLocaleLowerCase('en') === key)) return lines;
  return [...lines, cleaned];
}

function ruleFromEvent(event: CorrectionEvent): CorrectionRule {
  const parts = event.suggestedVocabularyLine.split('|').map((x) => x.trim()).filter(Boolean);
  return {
    id: nanoid(10),
    kind: event.suggestionKind === 'phonetic-alias' ? 'alias' : 'protected-term',
    canonical: parts[0] || event.correctedText.trim(),
    aliases: event.suggestionKind === 'phonetic-alias' ? parts.slice(1) : [],
    sourceCorrectionId: event.id,
    createdAt: new Date().toISOString(),
  };
}

export const profileStore = {
  get: load,

  async patch(value: unknown) {
    const current = await load();
    const raw = value && typeof value === 'object' ? value as Partial<AppProfile> : {};
    return save({
      ...current,
      defaultVocabulary: raw.defaultVocabulary == null ? current.defaultVocabulary : uniqueLines(raw.defaultVocabulary),
      styles: raw.styles == null ? current.styles : normalizeProfile({ ...current, styles: raw.styles }).styles,
      topicPacks: raw.topicPacks == null ? current.topicPacks : normalizeProfile({ ...current, topicPacks: raw.topicPacks }).topicPacks,
      preferences: raw.preferences == null
        ? current.preferences
        : normalizeProfile({ ...current, preferences: { ...current.preferences, ...raw.preferences } }).preferences,
    });
  },

  async replace(value: unknown) {
    const imported = normalizeProfile(value);
    // Privacy consent is installation-specific. Profile transfer never opts a different machine in.
    imported.preferences = {
      ...imported.preferences,
      analyticsConsent: 'unset',
      khmerContributionConsent: 'unset',
    };
    return save(imported);
  },

  async recordCaptionChanges(project: CaptionProject, before: CaptionSegment[], after: CaptionSegment[]) {
    const profile = await load();
    const byId = new Map(before.map((caption) => [caption.id, caption]));
    const created: CorrectionEvent[] = [];

    after.forEach((caption, index) => {
      const old = byId.get(caption.id);
      if (!old) return;
      const originalText = old.text.trim();
      const correctedText = caption.text.trim();
      if (!originalText || !correctedText || originalText === correctedText) return;
      if (originalText.replace(/\s+/g, ' ') === correctedText.replace(/\s+/g, ' ')) return;

      const duplicate = profile.correctionEvents.some((event) =>
        event.projectId === project.id
        && event.captionId === caption.id
        && event.originalText === originalText
        && event.correctedText === correctedText,
      );
      if (duplicate) return;

      const suggestion = suggestCorrection(originalText, correctedText);
      created.push({
        id: nanoid(12),
        projectId: project.id,
        projectTitle: project.title,
        captionId: caption.id,
        startMs: caption.startMs,
        endMs: caption.endMs,
        originalText,
        correctedText,
        contextBefore: after[index - 1]?.text,
        contextAfter: after[index + 1]?.text,
        suggestionKind: suggestion.kind,
        suggestedVocabularyLine: suggestion.line,
        status: 'pending',
        createdAt: new Date().toISOString(),
        sourceTimingSource: old.timingSource,
        sourceTimingQuality: old.timingQuality,
        sourceConfidence: old.confidence,
        sourceTextModel: project.transcript?.textModel,
        sourceEngineVersion: APP_VERSION,
      });
    });

    if (!created.length) return { profile, created };
    profile.correctionEvents = [...profile.correctionEvents, ...created].slice(-500);
    return { profile: await save(profile), created };
  },

  async actOnCorrection(id: string, action: 'remember-global' | 'add-project' | 'ignore') {
    const profile = await load();
    const index = profile.correctionEvents.findIndex((event) => event.id === id);
    if (index < 0) throw new Error('Correction event not found.');
    const event = profile.correctionEvents[index];
    const now = new Date().toISOString();

    if (action === 'remember-global') {
      profile.defaultVocabulary = addVocabularyLine(profile.defaultVocabulary, event.suggestedVocabularyLine);
      const nextRule = ruleFromEvent(event);
      const ruleKey = `${nextRule.kind}:${nextRule.canonical.toLocaleLowerCase('en')}:${nextRule.aliases.join('|').toLocaleLowerCase('en')}`;
      const already = profile.correctionRules.some((rule) =>
        `${rule.kind}:${rule.canonical.toLocaleLowerCase('en')}:${rule.aliases.join('|').toLocaleLowerCase('en')}` === ruleKey,
      );
      if (!already) profile.correctionRules.push(nextRule);
      profile.correctionEvents[index] = { ...event, status: 'remembered-global', decidedAt: now };
    } else if (action === 'add-project') {
      profile.correctionEvents[index] = { ...event, status: 'added-project', decidedAt: now };
    } else {
      profile.correctionEvents[index] = { ...event, status: 'ignored', decidedAt: now };
    }

    return { profile: await save(profile), event: profile.correctionEvents[index] };
  },

  addVocabularyLine,
};
