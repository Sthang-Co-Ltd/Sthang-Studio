import fs from 'node:fs/promises';
import path from 'node:path';
import { summarizeProject, type CaptionAppearance, type CaptionProject, type ProjectStorageStatus } from '@kcs/shared';
import { config } from '../config.js';
import { cancelScheduledProjectPrewarm, scheduleProjectMediaPrewarm } from './prewarm.js';
import { isLoadableProject, readMigrationMarker, readStorageJson, scanProjectStorage, storageStatusFromScan } from './project-storage.js';

const projectDir = path.join(path.dirname(config.dataFile), 'projects');
const orderFile = path.join(projectDir, 'order.json');
const migrationMarker = path.join(projectDir, '.per-project-v1');
const legacyBackup = path.join(path.dirname(config.dataFile), 'projects.legacy-v0.7.json');
const projects = new Map<string, CaptionProject>();
let order: string[] = [];
let initializePromise: Promise<void> | null = null;
let orderWriteQueue: Promise<void> = Promise.resolve();
const writeQueues = new Map<string, Promise<void>>();
const durableProjectWrites = new Map<string, boolean>();
let storageStatus: ProjectStorageStatus;
let orderReadFault = false;
let startupNeedsRestart = false;

function safeId(id: string) {
  const value = id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 100);
  if (!value) throw new Error('Invalid project id');
  return value;
}

function projectFile(id: string) {
  return path.join(projectDir, `${safeId(id)}.json`);
}

async function atomicWrite(filePath: string, value: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    await fs.writeFile(temp, value, 'utf8');
    const file = await fs.open(temp, 'r+');
    try { await file.sync(); } finally { await file.close(); }
    await fs.rename(temp, filePath);
    // Publication has happened. A directory-flush failure must not be reported
    // as an aborted write, which could delete media referenced by this pointer.
    if (process.platform === 'win32') return false;
    try {
      const directory = await fs.open(path.dirname(filePath), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
      return true;
    } catch {
      console.warn('[project store] Project published, but directory durability could not be confirmed. Previous source media will be retained.');
      return false;
    }
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}

function uniqueIds(values: string[]) {
  const seen = new Set<string>();
  return values.filter((id) => {
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function queueOrderUpdate(transform: (current: string[]) => string[]) {
  const task = orderWriteQueue.then(async () => {
    // Keep references to missing/unreadable project files so recovery retains order.
    const next = uniqueIds(transform(order));
    // Preserve a corrupt index for recovery; project files remain authoritative.
    if (!orderReadFault) await atomicWrite(orderFile, `${JSON.stringify(next)}\n`);
    order = next;
  });
  orderWriteQueue = task.then(() => undefined, () => undefined);
  return task;
}

async function loadProjectFiles() {
  const scan = await scanProjectStorage(projectDir);
  for (const entry of scan.entries) if (entry.project) projects.set(entry.project.id, entry.project);
  storageStatus = storageStatusFromScan(scan, projects.size);
  if (storageStatus.directoryUnreadable || storageStatus.unreadableProjectCount || storageStatus.duplicateProjectCount) {
    startupNeedsRestart = true;
    storageStatus.restartRequired = true;
  }
  return new Set(scan.entries.filter((entry) => !entry.project).map((entry) => entry.name));
}

function newestMissingIds() {
  const ordered = new Set(order);
  return [...projects.values()]
    .filter((project) => !ordered.has(project.id))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .map((project) => project.id);
}

async function initialize() {
  await fs.mkdir(projectDir, { recursive: true });
  const marker = await readMigrationMarker(migrationMarker);
  const markerExists = marker !== 'missing';
  const unreadableFiles = await loadProjectFiles();
  if (marker === 'unreadable') { storageStatus.migrationPending = true; startupNeedsRestart = true; storageStatus.restartRequired = true; }

  const orderRead = await readStorageJson(orderFile);
  const storedOrder = orderRead.state === 'ok' && Array.isArray(orderRead.value) && orderRead.value.every((id) => typeof id === 'string') ? orderRead.value as string[] : null;
  orderReadFault = orderRead.state === 'unreadable' || (orderRead.state === 'ok' && storedOrder === null);
  storageStatus.orderUnreadable = orderReadFault;
  if (orderReadFault) { startupNeedsRestart = true; storageStatus.restartRequired = true; }
  order = storedOrder
    ? uniqueIds(storedOrder)
    : [];

  if (!markerExists) {
    // A previous launch may have stopped halfway through migration. Always
    // reconcile the legacy file against any already-written per-project files;
    // only write the marker after every project and the order index are durable.
    const legacyRead = await readStorageJson(config.dataFile);
    const legacy = legacyRead.state === 'ok' && Array.isArray(legacyRead.value) ? legacyRead.value : [];
    storageStatus.legacyUnreadable = legacyRead.state === 'unreadable'
      || (legacyRead.state === 'ok' && (!Array.isArray(legacyRead.value) || !legacy.every(isLoadableProject)));
    let migrationSafe = !storageStatus.legacyUnreadable && !storageStatus.directoryUnreadable && !unreadableFiles.size && !orderReadFault;
    const legacyIds: string[] = [];
    if (Array.isArray(legacy) && legacy.length) {
      if (migrationSafe) await fs.copyFile(config.dataFile, legacyBackup, 1).catch(async (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST' || !await fs.stat(legacyBackup).then((stat) => stat.isFile()).catch(() => false)) migrationSafe = false;
      });
      for (const project of legacy) {
        if (!isLoadableProject(project) || unreadableFiles.has(path.basename(projectFile(project.id)))) continue;
        legacyIds.push(project.id);
        if (projects.has(project.id)) continue;
        const stored = structuredClone(project);
        if (migrationSafe) {
          await atomicWrite(projectFile(project.id), `${JSON.stringify(stored)}\n`);
          storageStatus.readableProjectCount++;
        }
        projects.set(project.id, stored);
      }
    }

    const remaining = newestMissingIds().filter((id) => !legacyIds.includes(id));
    if (!migrationSafe) {
      order = uniqueIds([...order, ...legacyIds, ...remaining]);
      storageStatus.migrationPending = true;
      startupNeedsRestart = true;
      storageStatus.restartRequired = true;
      return;
    }
    await queueOrderUpdate((current) => [...current, ...legacyIds, ...remaining]);
    await atomicWrite(migrationMarker, 'Sthang Studio per-project storage v1\n');
    if (legacyIds.length) {
      console.log(`[project store] Migrated/reconciled ${projects.size} project(s) to per-project storage; legacy source preserved.`);
    }
    return;
  }

  const missing = newestMissingIds();
  if (missing.length) await queueOrderUpdate((current) => [...current, ...missing]);
}

async function ensureInitialized() {
  if (!initializePromise) initializePromise = initialize();
  return initializePromise;
}

function queueProjectWrite<T>(id: string, operation: () => Promise<T>) {
  const previous = writeQueues.get(id) || Promise.resolve();
  const task = previous.then(operation);
  const tracked = task.then(() => undefined, () => undefined);
  writeQueues.set(id, tracked);
  void tracked.then(() => {
    if (writeQueues.get(id) === tracked) writeQueues.delete(id);
  });
  return task;
}

async function persistProject(stored: CaptionProject) {
  const previous = projects.get(stored.id);
  // A timestamp is the public optimistic revision. Two writes in one clock tick
  // (or a backwards wall clock) must not let a stale replacement overwrite edits.
  if (previous && (!Number.isFinite(Date.parse(stored.updatedAt)) || Date.parse(stored.updatedAt) <= Date.parse(previous.updatedAt))
    && JSON.stringify(stored) !== JSON.stringify(previous)) {
    stored.updatedAt = new Date(Math.max(Date.now(), (Date.parse(previous.updatedAt) || 0) + 1)).toISOString();
  }
  const mediaChanged = !previous
    || previous.media.filename !== stored.media.filename
    || previous.media.size !== stored.media.size;
  const durable = await atomicWrite(projectFile(stored.id), `${JSON.stringify(stored)}\n`);
  durableProjectWrites.set(stored.id, durable);
  projects.set(stored.id, stored);
  if (!previous) await queueOrderUpdate((current) => [stored.id, ...current.filter((id) => id !== stored.id)]);
  if (mediaChanged) scheduleProjectMediaPrewarm(stored);
  return structuredClone(stored);
}

export const store = {
  async storageStatus(recheck = false): Promise<ProjectStorageStatus> {
    await ensureInitialized();
    if (recheck) {
      const loadedBefore = new Set(projects.keys());
      const scan = await scanProjectStorage(projectDir);
      const next = storageStatusFromScan(scan, projects.size);
      const index = await readStorageJson(orderFile);
      next.orderUnreadable = index.state === 'unreadable' || (index.state === 'ok' && (!Array.isArray(index.value) || !index.value.every((id) => typeof id === 'string')));
      const marker = await readMigrationMarker(migrationMarker);
      if (marker === 'unreadable') next.migrationPending = true;
      if (marker === 'missing') {
        const legacy = await readStorageJson(config.dataFile);
        next.legacyUnreadable = legacy.state === 'unreadable' || (legacy.state === 'ok' && (!Array.isArray(legacy.value) || !legacy.value.every(isLoadableProject)));
        next.migrationPending = true;
      }
      if (!scan.directoryUnreadable && !next.migrationPending) {
        const names = new Set(scan.entries.map((entry) => entry.name));
        next.missingProjectCount = [...projects.keys()].filter((id) => loadedBefore.has(id) && !names.has(path.basename(projectFile(id)))).length;
      }
      if (next.unreadableProjectCount || next.missingProjectCount || next.duplicateProjectCount || next.directoryUnreadable
        || next.orderUnreadable || next.legacyUnreadable || next.migrationPending) startupNeedsRestart = true;
      next.restartRequired = startupNeedsRestart || orderReadFault || scan.entries.some((entry) => entry.project && !projects.has(entry.project.id));
      storageStatus = next;
    }
    return { ...storageStatus, loadedProjectCount: projects.size };
  },
  /** False after a committed write whose directory flush is unavailable. */
  latestWriteIsDurable(id: string) { return durableProjectWrites.get(id) !== false; },
  async listSummaries() {
    await ensureInitialized();
    return order
      .map((id) => projects.get(id))
      .filter((project): project is CaptionProject => Boolean(project))
      .map(summarizeProject);
  },

  async list() {
    await ensureInitialized();
    return order
      .map((id) => projects.get(id))
      .filter((project): project is CaptionProject => Boolean(project))
      .map((project) => structuredClone(project));
  },

  async get(id: string) {
    await ensureInitialized();
    const project = projects.get(id);
    return project ? structuredClone(project) : null;
  },

  /** Read the published in-memory state without cloning caption/transcript payloads. */
  async has(id: string): Promise<boolean> {
    await ensureInitialized();
    return projects.has(id);
  },

  /** Detached source metadata; never return a live reference into the stored project. */
  async getMedia(id: string): Promise<Pick<CaptionProject, 'id' | 'media'> | null> {
    await ensureInitialized();
    const project = projects.get(id);
    return project ? { id: project.id, media: structuredClone(project.media) } : null;
  },

  async upsert(project: CaptionProject) {
    const snapshot = structuredClone(project);
    await ensureInitialized();
    return queueProjectWrite(snapshot.id, async () => {
      // Caption/transcript operations own their fields, not appearance. They may have
      // started before a concurrent appearance save; never restore that older look.
      const current = projects.get(snapshot.id);
      if (current) snapshot.captionAppearance = current.captionAppearance;
      return persistProject(snapshot);
    });
  },

  async withProjectWrite<T>(
    id: string,
    operation: (
      current: CaptionProject | null,
      persist: (next: CaptionProject, options?: { restoreAppearance?: boolean }) => Promise<CaptionProject>,
    ) => Promise<T>,
  ): Promise<T> {
    await ensureInitialized();
    return queueProjectWrite(id, async () => {
      const current = projects.get(id);
      const detached = current ? structuredClone(current) : null;
      let persisted = false;
      const persist = async (next: CaptionProject, options?: { restoreAppearance?: boolean }) => {
        if (next.id !== id) throw new Error('Project write cannot change project id');
        if (persisted) throw new Error('Project write already persisted');
        const snapshot = structuredClone(next);
        const published = projects.get(id);
        if (published && !options?.restoreAppearance) snapshot.captionAppearance = published.captionAppearance;
        persisted = true;
        return persistProject(snapshot);
      };
      return operation(detached, persist);
    });
  },

  async setCaptionAppearance(id: string, appearance: CaptionAppearance) {
    const snapshot = structuredClone(appearance);
    await ensureInitialized();
    return queueProjectWrite(id, async () => {
      // Resolve the project inside the same queue as caption writes, not before it.
      const current = projects.get(id);
      if (!current) return null;
      return persistProject({ ...current, captionAppearance: snapshot, updatedAt: new Date().toISOString() });
    });
  },

  async remove(id: string) {
    await ensureInitialized();
    return queueProjectWrite(id, async () => {
      cancelScheduledProjectPrewarm(id);
      await fs.rm(projectFile(id), { force: true });
      projects.delete(id);
      durableProjectWrites.delete(id);
      await queueOrderUpdate((current) => current.filter((projectId) => projectId !== id));
    });
  },
};
