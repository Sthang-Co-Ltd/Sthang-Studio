import fs from 'node:fs/promises';
import path from 'node:path';
import type { CaptionProject } from '@kcs/shared';
import { config } from '../config.js';
import { cancelScheduledProjectPrewarm, scheduleProjectMediaPrewarm } from './prewarm.js';

const projectDir = path.join(path.dirname(config.dataFile), 'projects');
const orderFile = path.join(projectDir, 'order.json');
const migrationMarker = path.join(projectDir, '.per-project-v1');
const legacyBackup = path.join(path.dirname(config.dataFile), 'projects.legacy-v0.7.json');
const projects = new Map<string, CaptionProject>();
let order: string[] = [];
let initializePromise: Promise<void> | null = null;
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
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
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

async function persistOrder() {
  await atomicWrite(orderFile, `${JSON.stringify(order)}\n`);
}

async function initialize() {
  await fs.mkdir(projectDir, { recursive: true });
  const markerExists = await fs.stat(migrationMarker).then(() => true).catch(() => false);
  const names = await fs.readdir(projectDir).catch(() => [] as string[]);
  const projectNames = names.filter((name) => name.endsWith('.json') && name !== 'order.json');

  if (!markerExists && projectNames.length === 0) {
    const legacy = await readJson<CaptionProject[]>(config.dataFile);
    if (Array.isArray(legacy) && legacy.length) {
      await fs.copyFile(config.dataFile, legacyBackup, 1).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') console.warn('[project store] Could not create legacy backup:', error.message);
      });
      for (const project of legacy) {
        if (!project?.id) continue;
        projects.set(project.id, structuredClone(project));
        order.push(project.id);
        await atomicWrite(projectFile(project.id), `${JSON.stringify(project)}\n`);
      }
      await persistOrder();
      console.log(`[project store] Migrated ${projects.size} project(s) to per-project storage; legacy source preserved.`);
    }
    await fs.writeFile(migrationMarker, 'Sthang Studio per-project storage v1\n', 'utf8');
  } else {
    for (const name of projectNames) {
      const project = await readJson<CaptionProject>(path.join(projectDir, name));
      if (project?.id) projects.set(project.id, project);
    }
    const storedOrder = await readJson<string[]>(orderFile);
    order = Array.isArray(storedOrder)
      ? storedOrder.filter((id) => projects.has(id))
      : [];
    const missing = [...projects.values()]
      .filter((project) => !order.includes(project.id))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .map((project) => project.id);
    if (missing.length) {
      order.push(...missing);
      await persistOrder();
    }
    if (!markerExists) await fs.writeFile(migrationMarker, 'Sthang Studio per-project storage v1\n', 'utf8');
  }
}

async function ensureInitialized() {
  if (!initializePromise) initializePromise = initialize();
  return initializePromise;
}

function queueProjectWrite(project: CaptionProject) {
  const id = project.id;
  const previous = writeQueues.get(id) || Promise.resolve();
  const task = previous.then(() => atomicWrite(projectFile(id), `${JSON.stringify(project)}\n`));
  const tracked = task.then(() => undefined, () => undefined);
  writeQueues.set(id, tracked);
  tracked.finally(() => {
    if (writeQueues.get(id) === tracked) writeQueues.delete(id);
  });
  return task;
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
    await ensureInitialized();
    const previous = projects.get(project.id);
    const isNew = !previous;
    const mediaChanged = !previous
      || previous.media.filename !== project.media.filename
      || previous.media.size !== project.media.size;
    const stored = structuredClone(project);
    projects.set(project.id, stored);
    if (isNew) {
      order.unshift(project.id);
      await persistOrder();
    }
    await queueProjectWrite(stored);
    if (mediaChanged) scheduleProjectMediaPrewarm(stored);
    return structuredClone(stored);
  },

  async remove(id: string) {
    await ensureInitialized();
    cancelScheduledProjectPrewarm(id);
    const pending = writeQueues.get(id);
    if (pending) await pending;
    projects.delete(id);
    order = order.filter((projectId) => projectId !== id);
    await Promise.all([
      fs.rm(projectFile(id), { force: true }),
      persistOrder(),
    ]);
  },
};
