import { normalizeVideoExportSettings, type CaptionProject } from '@kcs/shared';
import { createExportWorkspaceSession, type ExportWorkspaceSession } from './export-session';

export const EXPORT_SESSION_PREFIX = 'sthang:export-session:v1:';
export const EXPORT_SESSION_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const MAX_RECORDS = 20;
const MAX_BYTES = 4096;
type Project = Pick<CaptionProject, 'id' | 'media'>;
type StorageAccess = () => Storage | null;
interface RecordValue {
  version: 1;
  projectId: string;
  media: { filename: string; size: number };
  savedAt: number;
  session: ExportWorkspaceSession;
}
const destinations = new Set(['capcut-desktop', 'capcut-mobile', 'premiere', 'resolve', 'final-cut', 'web-other', 'subtitle-tools']);
const formats = new Set(['vtt', 'ttml', 'word-srt', 'word-vtt', 'ass', 'data', 'bundle']);
const bytes = (value: string) => new TextEncoder().encode(value).length;
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const only = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every((key) => keys.includes(key));
const boundedId = (value: unknown): value is string => typeof value === 'string' && value.length <= 120;

function normalizeSession(value: unknown): ExportWorkspaceSession | null {
  if (!object(value) || !only(value, ['outputMode', 'settings', 'settingsHydrated', 'selectedPresetId', 'managedPresetId', 'advancedOpen', 'handoff'])
    || !['video', 'captions'].includes(String(value.outputMode)) || !object(value.settings)
    || !only(value.settings, ['resolution', 'frameRate', 'quality', 'codec', 'encoder', 'customBitrateMbps'])
    || typeof value.settingsHydrated !== 'boolean' || !boundedId(value.selectedPresetId) || !boundedId(value.managedPresetId)
    || typeof value.advancedOpen !== 'boolean' || !object(value.handoff)
    || !only(value.handoff, ['destination', 'advancedFormat', 'advancedOpen'])
    || !destinations.has(String(value.handoff.destination)) || typeof value.handoff.advancedOpen !== 'boolean'
    || value.handoff.advancedFormat !== null && !formats.has(String(value.handoff.advancedFormat))) return null;
  const suppliedSettings = value.settings;
  const settings = normalizeVideoExportSettings(suppliedSettings);
  if (Object.keys(settings).some((key) => settings[key as keyof typeof settings] !== suppliedSettings[key])
    || Object.keys(suppliedSettings).some((key) => suppliedSettings[key] !== settings[key as keyof typeof settings])) return null;
  return {
    outputMode: value.outputMode as ExportWorkspaceSession['outputMode'], settings,
    settingsHydrated: value.settingsHydrated, selectedPresetId: value.selectedPresetId, managedPresetId: value.managedPresetId,
    advancedOpen: value.advancedOpen,
    handoff: { destination: value.handoff.destination as ExportWorkspaceSession['handoff']['destination'],
      advancedFormat: value.handoff.advancedFormat as ExportWorkspaceSession['handoff']['advancedFormat'],
      advancedOpen: value.handoff.advancedOpen },
  };
}

function parse(raw: string, now: number): RecordValue | null {
  if (bytes(raw) > MAX_BYTES) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!object(value) || !only(value, ['version', 'projectId', 'media', 'savedAt', 'session'])
      || value.version !== 1 || !boundedId(value.projectId) || !value.projectId
      || !object(value.media) || !only(value.media, ['filename', 'size'])
      || typeof value.media.filename !== 'string' || value.media.filename.length > 512
      || !Number.isFinite(value.media.size) || Number(value.media.size) < 0
      || typeof value.savedAt !== 'number' || !Number.isFinite(value.savedAt) || value.savedAt > now + 300_000) return null;
    const session = normalizeSession(value.session);
    return session ? { version: 1, projectId: value.projectId,
      media: { filename: value.media.filename, size: Number(value.media.size) }, savedAt: value.savedAt, session } : null;
  } catch { return null; }
}

/** Optional output choices only. Reading a record never authorizes an export. */
export function createExportSessionStorage(access: StorageAccess, now = () => Date.now()) {
  const keyFor = (id: string) => EXPORT_SESSION_PREFIX + encodeURIComponent(id);
  const removeExact = (storage: Storage, key: string, raw: string) => {
    if (storage.getItem(key) === raw) storage.removeItem(key);
  };
  return {
    read(project: Project): ExportWorkspaceSession | null {
      try {
        const storage = access(); if (!storage) return null;
        const key = keyFor(project.id); const raw = storage.getItem(key); if (!raw) return null;
        const value = parse(raw, now());
        if (!value || value.projectId !== project.id) return null;
        if (now() - value.savedAt > EXPORT_SESSION_MAX_AGE) { removeExact(storage, key, raw); return null; }
        if (value.media.filename !== project.media.filename || value.media.size !== project.media.size) return null;
        return value.session;
      } catch { return null; }
    },
    write(project: Project, session: ExportWorkspaceSession): boolean {
      try {
        const storage = access(); if (!storage) return false;
        // Pick a known schema instead of serializing future UI/private fields.
        const picked = { ...createExportWorkspaceSession(session.outputMode === 'video'),
          outputMode: session.outputMode, settings: normalizeVideoExportSettings(session.settings),
          settingsHydrated: session.settingsHydrated, selectedPresetId: session.selectedPresetId,
          managedPresetId: session.managedPresetId, advancedOpen: session.advancedOpen,
          handoff: { destination: session.handoff.destination, advancedFormat: session.handoff.advancedFormat, advancedOpen: session.handoff.advancedOpen } };
        const clean = normalizeSession(picked); if (!clean) return false;
        const value: RecordValue = { version: 1, projectId: project.id,
          media: { filename: project.media.filename, size: project.media.size }, savedAt: now(), session: clean };
        const raw = JSON.stringify(value); if (bytes(raw) > MAX_BYTES || !parse(raw, now())) return false;
        const key = keyFor(project.id);
        const retained: Array<{ key: string; raw: string; savedAt: number }> = [];
        for (let i = 0; i < storage.length; i++) {
          const otherKey = storage.key(i); if (!otherKey?.startsWith(EXPORT_SESSION_PREFIX) || otherKey === key) continue;
          const otherRaw = storage.getItem(otherKey); if (!otherRaw) continue;
          const other = parse(otherRaw, now()); if (other) retained.push({ key: otherKey, raw: otherRaw, savedAt: other.savedAt });
        }
        for (const old of retained.filter((entry) => now() - entry.savedAt > EXPORT_SESSION_MAX_AGE)) removeExact(storage, old.key, old.raw);
        const current = retained.filter((entry) => now() - entry.savedAt <= EXPORT_SESSION_MAX_AGE).sort((a, b) => b.savedAt - a.savedAt);
        // Write first: a quota failure cannot evict the creator's previous choices.
        storage.setItem(key, raw);
        for (const old of current.slice(MAX_RECORDS - 1)) removeExact(storage, old.key, old.raw);
        return true;
      } catch { return false; }
    },
  };
}
