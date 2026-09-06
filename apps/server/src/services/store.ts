import fs from 'node:fs/promises';
import path from 'node:path';
import type { CaptionAppearance, CaptionProject } from '@kcs/shared';
import { config } from '../config.js';
import { cancelScheduledProjectPrewarm, scheduleProjectMediaPrewarm } from './prewarm.js';

const projectDir = path.join(path.dirname(config.dataFile), 'projects');
const orderFile = path.join(projectDir, 'order.json');
const migrationMarker = path.join(projectDir, '.per-project-v1');
const legacyBackup = path.join(path.dirname(config.dataFile), 'projects.legacy-v0.7.json');
const projects = new Map<string, CaptionProject>();
let order: string[] = [];
let initializePromise: Promise<void> | null = null;
let orderWriteQueue: Promise<void> = Promise.resolve();
const writeQueues = new Map<string, Promise<void>>();

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
    await fs.rename(temp, filePath);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
  } catch {
    return null;
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
    const next = uniqueIds(transform(order)).filter((id) => projects.has(id));
    await atomicWrite(orderFile, `${JSON.stringify(next)}\n`);
    order = next;
  });
  orderWriteQueue = task.then(() => undefined, () => undefined);
  return task;
}

async function loadProjectFiles() {
  const names = await fs.readdir(projectDir).catch(() => [] as string[]);
  const projectNames = names.filter((name) => name.endsWith('.json') && name !== 'order.json');
  for (const name of projectNames) {
    const project = await readJson<CaptionProject>(path.join(projectDir, name));
    if (project?.id) projects.set(project.id, project);
  }
}

function newestMissingIds() {
  return [...projects.values()]
    .filter((project) => !order.includes(project.id))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .map((project) => project.id);
}

async function initialize() {
  await fs.mkdir(projectDir, { recursive: true });
  const markerExists = await fs.stat(migrationMarker).then(() => true).catch(() => false);
  await loadProjectFiles();

  const storedOrder = await readJson<string[]>(orderFile);
  order = Array.isArray(storedOrder)
    ? uniqueIds(storedOrder).filter((id) => projects.has(id))
    : [];

  if (!markerExists) {
    // A previous launch may have stopped halfway through migration. Always
    // reconcile the legacy file against any already-written per-project files;
    // only write the marker after every project and the order index are durable.
    const legacy = await readJson<CaptionProject[]>(config.dataFile);
    const legacyIds: string[] = [];
    if (Array.isArray(legacy) && legacy.length) {
      await fs.copyFile(config.dataFile, legacyBackup, 1).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') console.warn('[project store] Could not create legacy backup:', error.message);
      });
      for (const project of legacy) {
        if (!project?.id) continue;
        legacyIds.push(project.id);
        if (projects.has(project.id)) continue;
        const stored = structuredClone(project);
        await atomicWrite(projectFile(project.id), `${JSON.stringify(stored)}\n`);
        projects.set(project.id, stored);
      }
    }

    const remaining = newestMissingIds().filter((id) => !legacyIds.includes(id));
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
  const mediaChanged = !previous
    || previous.media.filename !== stored.media.filename
    || previous.media.size !== stored.media.size;
  await atomicWrite(projectFile(stored.id), `${JSON.stringify(stored)}\n`);
  projects.set(stored.id, stored);
  if (!previous) await queueOrderUpdate((current) => [stored.id, ...current.filter((id) => id !== stored.id)]);
  if (mediaChanged) scheduleProjectMediaPrewarm(stored);
  return structuredClone(stored);
}

export const store = {
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
      await queueOrderUpdate((current) => current.filter((projectId) => projectId !== id));
    });
  },
};
