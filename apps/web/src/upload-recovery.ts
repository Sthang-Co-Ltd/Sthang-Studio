export const UPLOAD_RECOVERY_PREFIX = 'sthang-studio:upload-attempt:v1:';
export const UPLOAD_RECOVERY_LIMITS = Object.freeze({ maxEntries: 5, maxEntryBytes: 4096, maxTotalBytes: 20 * 1024,
  ttlMs: 7 * 24 * 60 * 60 * 1000, futureClockAllowanceMs: 5 * 60 * 1000 });
type RecoveryStorage = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem' | 'removeItem'>;
export interface UploadFileDetails { name: string; size: number; type: string; lastModified: number }
export interface UploadRecoveryMetadata extends UploadFileDetails { version: 1; id: string; capturedAt: number }
export interface UploadRecoveryEntry { key: string; raw: string; metadata: UploadRecoveryMetadata }
export interface UploadRecoveryRead { entries: UploadRecoveryEntry[]; error: string }
const unavailable = 'Upload recovery could not be kept for restart. Keep this page open until the upload result is confirmed.';
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const validId = (value: unknown): value is string => typeof value === 'string' && /^upload_[a-f0-9]{32}$/.test(value);
const bytes = (key: string, raw: string) => (key.length + raw.length) * 2;
const mediaType = (value: string) => value || 'application/octet-stream';
export const uploadTitle = (name: string) => name.replace(/\.[^.]+$/, '');
export function matchingUploadFile(file: UploadFileDetails, record: UploadFileDetails) {
  return file.name === record.name && file.size === record.size && mediaType(file.type) === mediaType(record.type) && file.lastModified === record.lastModified;
}
function parse(key: string, raw: string, now: number, allowExpired = false): UploadRecoveryEntry | null {
  if (bytes(key, raw) > UPLOAD_RECOVERY_LIMITS.maxEntryBytes) return null;
  try {
    const value = JSON.parse(raw) as UploadRecoveryMetadata;
    if (!value || typeof value !== 'object' || Object.keys(value).sort().join(',') !== 'capturedAt,id,lastModified,name,size,type,version'
      || value.version !== 1 || !validId(value.id) || key !== UPLOAD_RECOVERY_PREFIX + value.id
      || typeof value.name !== 'string' || !value.name.length || value.name.length > 512 || /[\x00-\x1f]/.test(value.name)
      || typeof value.type !== 'string' || value.type.length > 256 || /[\x00-\x1f]/.test(value.type)
      || !integer(value.size) || !integer(value.lastModified) || !integer(value.capturedAt)
      || value.capturedAt > now + UPLOAD_RECOVERY_LIMITS.futureClockAllowanceMs
      || !allowExpired && value.capturedAt < now - UPLOAD_RECOVERY_LIMITS.ttlMs) return null;
    return { key, raw, metadata: value };
  } catch { return null; }
}

/** Immutable per-attempt keys avoid a shared last-writer-wins slot. No bytes,
 * titles or caption text enter this optional browser-origin recovery store. */
export function createUploadRecoveryStore(storageGetter: () => RecoveryStorage | null, now: () => number = Date.now) {
  const target = () => { try { return storageGetter(); } catch { return null; } };
  const ownership = (entry: UploadRecoveryEntry): 'current' | 'changed' | 'unavailable' => {
    try { const storage = target(); return !storage ? 'unavailable' : storage.getItem(entry.key) === entry.raw ? 'current' : 'changed'; }
    catch { return 'unavailable'; }
  };
  function remove(entry: UploadRecoveryEntry) {
    try {
      const storage = target();
      if (!storage || !parse(entry.key, entry.raw, now(), true)) return false;
      const current = storage.getItem(entry.key);
      if (current === null) return true;
      if (current !== entry.raw) return false;
      storage.removeItem(entry.key);
      return storage.getItem(entry.key) === null;
    } catch { return false; }
  }
  function inspect(storage: RecoveryStorage) {
    const count = storage.length;
    if (!Number.isInteger(count) || count < 0 || count > 1000) throw new Error('Storage inventory unavailable');
    const keys = Array.from({ length: count }, (_, index) => storage.key(index)).filter((key): key is string => Boolean(key?.startsWith(UPLOAD_RECOVERY_PREFIX)));
    const entries: UploadRecoveryEntry[] = [];
    let total = 0; let records = 0;
    for (const key of keys) {
      const raw = storage.getItem(key); if (raw === null) continue;
      const entry = parse(key, raw, now());
      if (!entry) {
        const expired = parse(key, raw, now(), true);
        if (expired && expired.metadata.capturedAt < now() - UPLOAD_RECOVERY_LIMITS.ttlMs && remove(expired)) continue;
      }
      records++; total += bytes(key, raw);
      if (entry) entries.push(entry);
    }
    return { entries: entries.sort((a, b) => b.metadata.capturedAt - a.metadata.capturedAt || a.metadata.id.localeCompare(b.metadata.id)), total, records };
  }
  return {
    read(): UploadRecoveryRead {
      try { const storage = target(); if (!storage) return { entries: [], error: unavailable };
        return { entries: inspect(storage).entries, error: '' };
      } catch { return { entries: [], error: unavailable }; }
    },
    keep(file: UploadFileDetails, id: string): { entry: UploadRecoveryEntry | null; error: string } {
      const metadata: UploadRecoveryMetadata = { version: 1, id, name: file.name, size: file.size, type: mediaType(file.type), lastModified: file.lastModified, capturedAt: now() };
      const key = UPLOAD_RECOVERY_PREFIX + id; const raw = JSON.stringify(metadata);
      const candidate = parse(key, raw, now());
      if (!candidate) return { entry: null, error: unavailable };
      try {
        const storage = target(); if (!storage) return { entry: null, error: unavailable };
        const previous = storage.getItem(key);
        if (previous !== null) {
          const existing = parse(key, previous, now());
          return existing && matchingUploadFile(file, existing.metadata) ? { entry: existing, error: '' } : { entry: null, error: unavailable };
        }
        const current = inspect(storage);
        if (current.records >= UPLOAD_RECOVERY_LIMITS.maxEntries || current.total + bytes(key, raw) > UPLOAD_RECOVERY_LIMITS.maxTotalBytes) {
          return { entry: null, error: 'Upload recovery is full. Earlier reminders are kept; forget one you no longer need to keep this upload for restart.' };
        }
        storage.setItem(key, raw);
        return storage.getItem(key) === raw ? { entry: candidate, error: '' } : { entry: null, error: unavailable };
      } catch { return { entry: null, error: unavailable }; }
    },
    remove,
    ownership,
    isCurrent: (entry: UploadRecoveryEntry) => ownership(entry) === 'current',
  };
}
const browserStorage = () => { try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; } };
export function captureUploadRecoveryForProject(projectId: string): UploadRecoveryEntry | null {
  return createUploadRecoveryStore(browserStorage).read().entries.find((entry) => entry.metadata.id === projectId) || null;
}
/** Capture before an awaited project open, then clear only that exact reminder. */
export function clearUploadRecoveryForProject(projectId: string, expected: UploadRecoveryEntry | null): boolean {
  return !expected || expected.metadata.id === projectId && createUploadRecoveryStore(browserStorage).remove(expected);
}
