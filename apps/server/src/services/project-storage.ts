import fs from 'node:fs/promises';
import path from 'node:path';
import type { CaptionProject, ProjectStorageStatus } from '@kcs/shared';

export type JsonRead = { state: 'ok'; value: unknown } | { state: 'missing' | 'unreadable' };
export async function readStorageJson(file: string): Promise<JsonRead> {
  try { return { state: 'ok', value: JSON.parse(await fs.readFile(file, 'utf8')) }; }
  catch (error) { return { state: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable' }; }
}
export async function readMigrationMarker(file: string): Promise<'present' | 'missing' | 'unreadable'> {
  try { return (await fs.stat(file)).isFile() ? 'present' : 'unreadable'; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable'; }
}

/** Validate load shape only. Editorial errors and repairable cue timing stay editable. */
export function isLoadableProject(value: unknown): value is CaptionProject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const p = value as CaptionProject;
  return typeof p.id === 'string' && /[A-Za-z0-9_-]/.test(p.id) && typeof p.title === 'string'
    && typeof p.createdAt === 'string' && typeof p.updatedAt === 'string'
    && Boolean(p.media) && typeof p.media.filename === 'string' && typeof p.media.originalName === 'string'
    && typeof p.media.url === 'string' && typeof p.media.mimeType === 'string'
    && Number.isFinite(p.media.size) && p.media.size >= 0 && Array.isArray(p.captions)
    && p.captions.every((c) => c && typeof c.id === 'string' && typeof c.text === 'string' && Number.isFinite(c.startMs) && Number.isFinite(c.endMs));
}

export async function scanProjectStorage(directory: string) {
  let names: string[];
  try { names = (await fs.readdir(directory)).filter((name) => name.endsWith('.json') && name !== 'order.json'); }
  catch { return { entries: [] as Array<{ name: string; project: CaptionProject | null }>, directoryUnreadable: true }; }
  const entries: Array<{ name: string; project: CaptionProject | null }> = [];
  for (let index = 0; index < names.length; index += 4) {
    entries.push(...await Promise.all(names.slice(index, index + 4).map(async (name) => {
      const read = await readStorageJson(path.join(directory, name));
      return { name, project: read.state === 'ok' && isLoadableProject(read.value) ? read.value : null };
    })));
  }
  return { entries, directoryUnreadable: false };
}

export function storageStatusFromScan(scan: Awaited<ReturnType<typeof scanProjectStorage>>, loadedProjectCount: number): ProjectStorageStatus {
  const ids = scan.entries.flatMap((entry) => entry.project ? [entry.project.id] : []);
  return { schemaVersion: 1, checkedAt: new Date().toISOString(), loadedProjectCount, readableProjectCount: ids.length,
    unreadableProjectCount: scan.entries.filter((entry) => !entry.project).length, missingProjectCount: 0,
    duplicateProjectCount: ids.length - new Set(ids).size, directoryUnreadable: scan.directoryUnreadable,
    orderUnreadable: false, legacyUnreadable: false, migrationPending: false, restartRequired: false };
}
