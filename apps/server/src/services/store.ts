import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { summarizeProject, type CaptionAppearance, type CaptionProject, type CaptionProjectAppearance, type ProjectDeletion, type ProjectStorageStatus } from '@kcs/shared';
import { config } from '../config.js';
import { cancelScheduledProjectPrewarm, scheduleProjectMediaPrewarm } from './prewarm.js';
import { isLoadableProject, isProjectDeletion, PROJECT_RESTORE_WINDOW_MS, readMigrationMarker, readStorageJson, scanProjectStorage, storageStatusFromScan } from './project-storage.js';
import { beginProjectLoadingPhase, endProjectLoadingPhase } from './project-loading-observer.js';

const projectDir = path.join(path.dirname(config.dataFile), 'projects');
const orderFile = path.join(projectDir, 'order.json');
const migrationMarker = path.join(projectDir, '.per-project-v1');
const legacyBackup = path.join(path.dirname(config.dataFile), 'projects.legacy-v0.7.json');
const projects = new Map<string, CaptionProject>();
const binned = new Map<string, CaptionProject & { deletion: ProjectDeletion }>();
const invalidBinRecords = new Map<string, CaptionProject>();
const disputedIds = new Set<string>();
let order: string[] = [];
let initializePromise: Promise<void> | null = null;
let orderWriteQueue: Promise<void> = Promise.resolve();
const writeQueues = new Map<string, Promise<void>>();
const durableProjectWrites = new Map<string, boolean>();
let storageStatus: ProjectStorageStatus;
let orderReadFault = false;
let startupNeedsRestart = false;
// Display order can include legacy records that exist only in memory while
// migration is pending. Only published references/files establish missing files.
let indexedProjectIds = new Set<string>();
const publishedProjectIds = new Set<string>();
let migrationDeletionBlocked = false;
let storageMutationGeneration = 0;
let activeStorageMutations = 0;

async function withStorageMutation<T>(operation: () => Promise<T>): Promise<T> {
  storageMutationGeneration++;
  activeStorageMutations++;
  try { return await operation(); }
  finally {
    activeStorageMutations--;
    storageMutationGeneration++;
  }
}

const binErrors = {
  not_found: 'Project not found.',
  project_binned: 'This project is in Recently deleted.',
  storage_blocked: 'Studio could not verify saved project storage for this operation. Check Saved projects and restart Studio before trying again.',
  instance_mismatch: 'This deletion has changed. Refresh Recently deleted and try again.',
  purging: 'Permanent removal has already started for this project.',
  expired: 'The restore deadline has passed for this project.',
};

export class ProjectBinError extends Error {
  constructor(readonly code: keyof typeof binErrors) { super(binErrors[code]); }
}

function safeId(id: string) {
  const value = id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 100);
  if (!value) throw new Error('Invalid project id');
  return value;
}

function projectFile(id: string) {
  return path.join(projectDir, `${safeId(id)}.json`);
}

function knownRecord(id: string) {
  return projects.get(id) ?? binned.get(id) ?? invalidBinRecords.get(id);
}

function knownRecordCount() { return projects.size + binned.size + invalidBinRecords.size; }

function isHiddenByBin(id: string) { return binned.has(id) || invalidBinRecords.has(id); }

type StorageScan = Awaited<ReturnType<typeof scanProjectStorage>>;

function noteDisputedRecords(scan: StorageScan) {
  const seen = new Set<string>();
  for (const { name, project } of scan.entries) {
    if (!project) {
      const id = name.slice(0, -5);
      disputedIds.add(id);
      continue;
    }
    if (seen.has(project.id) || name !== `${project.id}.json` || !/^[A-Za-z0-9_-]{1,100}$/.test(project.id)
      || (project.deletion !== undefined && !isProjectDeletion(project.deletion))) disputedIds.add(project.id);
    seen.add(project.id);
  }
}

async function hasRegularRecordFile(id: string) {
  return fs.lstat(projectFile(id)).then((stat) => stat.isFile(), () => false);
}

function assertLifecycleStorage(id: string) {
  if (migrationDeletionBlocked || disputedIds.has(id) || !/^[A-Za-z0-9_-]{1,100}$/.test(id) || id.toLowerCase() === 'order') {
    throw new ProjectBinError('storage_blocked');
  }
}

async function inspectLifecycleRecord(project: CaptionProject) {
  const { id } = project;
  assertLifecycleStorage(id);
  if (await readMigrationMarker(migrationMarker) !== 'present') {
    migrationDeletionBlocked = true;
    startupNeedsRestart = true;
    storageStatus = { ...storageStatus, migrationPending: true, restartRequired: true };
    throw new ProjectBinError('storage_blocked');
  }
  const scan = await scanProjectStorage(projectDir);
  assertLifecycleStorage(id);
  const matches = scan.entries.filter((entry) => entry.project?.id === id || entry.name.toLowerCase() === `${id}.json`.toLowerCase());
  if (scan.directoryUnreadable || matches.length !== 1 || matches[0].name !== `${id}.json`
    || JSON.stringify(matches[0].project) !== JSON.stringify(project) || !await hasRegularRecordFile(id)) {
    disputedIds.add(id);
    throw new ProjectBinError('storage_blocked');
  }
  assertLifecycleStorage(id);
  return scan;
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

function queueOrderUpdate(transform: (current: string[]) => string[], retainOnFailure = false) {
  const task = orderWriteQueue.then(async () => {
    // Keep references to missing/unreadable project files so recovery retains order.
    const next = uniqueIds(transform(order));
    // Preserve a corrupt index for recovery; project files remain authoritative.
    if (!orderReadFault) {
      // A pending migration can add usable legacy-only objects to display order.
      // Publishing a new project must not turn those objects into false missing
      // file references. Retain genuine existing references even when missing.
      const publishedOrder = next.filter((id) => indexedProjectIds.has(id) || publishedProjectIds.has(id));
      try { await atomicWrite(orderFile, `${JSON.stringify(publishedOrder)}\n`); }
      catch (error) { if (retainOnFailure) order = next; throw error; }
      indexedProjectIds = new Set(publishedOrder);
    }
    order = next;
  });
  orderWriteQueue = task.then(() => undefined, () => undefined);
  return task;
}

async function loadProjectFiles() {
  const scan = await scanProjectStorage(projectDir);
  noteDisputedRecords(scan);
  const now = Date.now();
  const publishing = beginProjectLoadingPhase('publication');
  try {
  for (const entry of scan.entries) if (entry.project) {
    let project = entry.project;
    const { id } = project;
    if (project.deletion !== undefined && !disputedIds.has(id)) {
      if (!await hasRegularRecordFile(id) || scan.entries.some((other) => other !== entry && other.name.toLowerCase() === entry.name.toLowerCase())) {
        disputedIds.add(id);
      } else {
        const deletion = project.deletion;
        const changed = deletion.recordUpdatedAt !== project.updatedAt;
        const future = Date.parse(deletion.binnedAt) > now + 24 * 60 * 60 * 1000;
        if (changed || future) {
          const corrected = { ...project, deletion: changed ? undefined : {
            ...deletion, binnedAt: new Date(now).toISOString(), restoreUntil: new Date(now + PROJECT_RESTORE_WINDOW_MS).toISOString(),
          } };
          try {
            await atomicWrite(projectFile(id), `${JSON.stringify(corrected)}\n`);
            project = entry.project = corrected;
            console.warn(changed
              ? '[project bin] Recovered an edited project from Recently deleted.'
              : '[project bin] Corrected a future deletion deadline.');
          } catch {
            disputedIds.add(id);
            console.warn('[project bin] Could not correct a saved deletion marker. Files were kept.');
          }
        }
      }
    }
    // A disputed duplicate with a deletion marker must stay visible in the bin
    // and must never become active because a second file lacks that marker.
    if (isProjectDeletion(project.deletion)) {
      projects.delete(id);
      invalidBinRecords.delete(id);
      binned.set(id, { ...project, deletion: project.deletion });
    } else if (!binned.has(id) && project.deletion !== undefined) {
      projects.delete(id);
      invalidBinRecords.set(id, project);
    } else if (!isHiddenByBin(id)) {
      projects.set(id, project);
    }
    publishedProjectIds.add(id);
  }
  storageStatus = storageStatusFromScan(scan, knownRecordCount());
  if (storageStatus.directoryUnreadable || storageStatus.unreadableProjectCount || disputedIds.size) {
    startupNeedsRestart = true;
    storageStatus.restartRequired = true;
  }
  return scan;
  } finally { endProjectLoadingPhase(publishing, scan.entries.length); }
}

function missingProjectCount(scan: Awaited<ReturnType<typeof scanProjectStorage>>, diskIndex: string[] = []) {
  if (scan.directoryUnreadable) return 0;
  const names = new Set(scan.entries.map((entry) => entry.name));
  const expectedNames = new Set([
    // Invalid index entries are preserved for recovery, never sanitized into a
    // different identity or used to probe paths outside the project directory.
    ...[...indexedProjectIds, ...diskIndex].filter((id) => /^[A-Za-z0-9_-]{1,100}$/.test(id)).map((id) => `${id}.json`),
    ...[...publishedProjectIds].map((id) => path.basename(projectFile(id))),
  ]);
  return [...expectedNames].filter((name) => !names.has(name)).length;
}

function newestMissingIds() {
  const ordered = new Set(order);
  return [...projects.values(), ...binned.values(), ...invalidBinRecords.values()]
    .filter((project) => !ordered.has(project.id))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .map((project) => project.id);
}

async function initialize() {
  const creating = beginProjectLoadingPhase('directory-create');
  try { await fs.mkdir(projectDir, { recursive: true }); }
  finally { endProjectLoadingPhase(creating); }
  const marker = await readMigrationMarker(migrationMarker);
  const markerExists = marker !== 'missing';
  const scan = await loadProjectFiles();
  const physicalNames = new Set(scan.entries.map((entry) => entry.name.toLowerCase()));
  const unreadableFiles = scan.entries.some((entry) => !entry.project);
  if (marker === 'unreadable') { storageStatus.migrationPending = true; migrationDeletionBlocked = true; startupNeedsRestart = true; storageStatus.restartRequired = true; }

  const orderRead = await readStorageJson(orderFile);
  const storedOrder = orderRead.state === 'ok' && Array.isArray(orderRead.value) && orderRead.value.every((id) => typeof id === 'string') ? orderRead.value as string[] : null;
  orderReadFault = orderRead.state === 'unreadable' || (orderRead.state === 'ok' && storedOrder === null);
  storageStatus.orderUnreadable = orderReadFault;
  if (orderReadFault) { startupNeedsRestart = true; storageStatus.restartRequired = true; }
  order = storedOrder
    ? uniqueIds(storedOrder)
    : [];
  indexedProjectIds = new Set(order);
  const finishMissingCheck = () => {
    storageStatus.missingProjectCount = missingProjectCount(scan);
    if (storageStatus.missingProjectCount) { startupNeedsRestart = true; storageStatus.restartRequired = true; }
  };

  if (!markerExists) {
    // A previous launch may have stopped halfway through migration. Always
    // reconcile the legacy file against any already-written per-project files;
    // only write the marker after every project and the order index are durable.
    const legacyRead = await readStorageJson(config.dataFile);
    const legacy = legacyRead.state === 'ok' && Array.isArray(legacyRead.value) ? legacyRead.value : [];
    storageStatus.legacyUnreadable = legacyRead.state === 'unreadable'
      || (legacyRead.state === 'ok' && (!Array.isArray(legacyRead.value) || !legacy.every(isLoadableProject)));
    let migrationSafe = !storageStatus.legacyUnreadable && !storageStatus.directoryUnreadable && !unreadableFiles && !orderReadFault;
    const legacyIds: string[] = [];
    if (Array.isArray(legacy) && legacy.length) {
      if (migrationSafe) await fs.copyFile(config.dataFile, legacyBackup, 1).catch(async (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST' || !await fs.stat(legacyBackup).then((stat) => stat.isFile()).catch(() => false)) migrationSafe = false;
      });
      for (const project of legacy) {
        if (!isLoadableProject(project)) continue;
        const filename = path.basename(projectFile(project.id));
        if (physicalNames.has(filename.toLowerCase()) && !knownRecord(project.id)) continue;
        legacyIds.push(project.id);
        if (knownRecord(project.id)) continue;
        const stored = structuredClone(project);
        if (migrationSafe) {
          await atomicWrite(projectFile(project.id), `${JSON.stringify(stored)}\n`);
          publishedProjectIds.add(project.id);
          scan.entries.push({ name: filename, project: stored });
          physicalNames.add(filename.toLowerCase());
          storageStatus.readableProjectCount++;
        }
        projects.set(project.id, stored);
      }
    }

    const remaining = newestMissingIds().filter((id) => !legacyIds.includes(id));
    if (!migrationSafe) {
      order = uniqueIds([...order, ...legacyIds, ...remaining]);
      storageStatus.migrationPending = true;
      migrationDeletionBlocked = true;
      startupNeedsRestart = true;
      storageStatus.restartRequired = true;
      finishMissingCheck();
      return;
    }
    await queueOrderUpdate((current) => [...current, ...legacyIds, ...remaining]);
    await atomicWrite(migrationMarker, 'Sthang Studio per-project storage v1\n');
    finishMissingCheck();
    if (legacyIds.length) {
      console.log(`[project store] Migrated/reconciled ${knownRecordCount()} project(s) to per-project storage; legacy source preserved.`);
    }
    return;
  }

  const missing = newestMissingIds();
  if (missing.length) await queueOrderUpdate((current) => [...current, ...missing]);
  finishMissingCheck();
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

async function persistProject(stored: CaptionProject, recoverCreationOrder = false) {
  return withStorageMutation(() => publishProject(stored, recoverCreationOrder));
}

async function publishProject(stored: CaptionProject, recoverCreationOrder = false) {
  const previous = projects.get(stored.id);
  // A timestamp is the public optimistic content revision. The future-job model
  // and title have separate compare-and-set checks and must preserve proposals.
  // Every other change still advances the revision, even within one clock tick.
  if (previous && (!Number.isFinite(Date.parse(stored.updatedAt)) || Date.parse(stored.updatedAt) <= Date.parse(previous.updatedAt))
    && JSON.stringify({ ...stored, generationModel: undefined, title: undefined }) !== JSON.stringify({ ...previous, generationModel: undefined, title: undefined })) {
    stored.updatedAt = new Date(Math.max(Date.now(), (Date.parse(previous.updatedAt) || 0) + 1)).toISOString();
  }
  const mediaChanged = !previous
    || previous.media.filename !== stored.media.filename
    || previous.media.size !== stored.media.size;
  const durable = await atomicWrite(projectFile(stored.id), `${JSON.stringify(stored)}\n`);
  publishedProjectIds.add(stored.id);
  durableProjectWrites.set(stored.id, durable);
  projects.set(stored.id, stored);
  if (!previous) {
    try { await queueOrderUpdate((current) => [stored.id, ...current.filter((id) => id !== stored.id)], recoverCreationOrder); }
    catch (error) {
      if (!recoverCreationOrder) throw error;
      startupNeedsRestart = true;
      storageStatus = { ...storageStatus, restartRequired: true };
      console.warn('[project store] New project saved; project order could not be saved. Published media was retained.');
    }
  }
  if (mediaChanged) scheduleProjectMediaPrewarm(stored);
  return structuredClone(stored);
}

async function publishDeletion(project: CaptionProject, deletion?: ProjectDeletion) {
  return withStorageMutation(async () => {
    const { id } = project;
    const next = { ...project };
    delete next.deletion;
    if (deletion) next.deletion = deletion;
    const durable = await atomicWrite(projectFile(id), `${JSON.stringify(next)}\n`);
    durableProjectWrites.set(id, durable);
    if (deletion) {
      projects.delete(id);
      binned.set(id, { ...next, deletion });
      cancelScheduledProjectPrewarm(id);
    } else {
      binned.delete(id);
      projects.set(id, next);
    }
    return structuredClone(next);
  });
}

function requireBinned(id: string, instanceId?: string) {
  if (!binned.has(id) && !invalidBinRecords.has(id) && !disputedIds.has(id)) throw new ProjectBinError('not_found');
  assertLifecycleStorage(id);
  const project = binned.get(id);
  if (!project) throw new ProjectBinError('not_found');
  if (instanceId !== undefined && project.deletion.instanceId !== instanceId) throw new ProjectBinError('instance_mismatch');
  return project;
}

function uploadNameKey(filename: string) { return filename.replace(/[. ]+$/u, '').toLowerCase(); }

function mayRemoveUpload(id: string, filename: string, scan: StorageScan) {
  const key = uploadNameKey(filename);
  if (!key || key !== filename.toLowerCase() || filename === '.' || filename === '..'
    || /[<>:"/\\|?*\x00-\x1f\x7f]/u.test(filename)
    || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(filename)) return false;
  const references = (project: CaptionProject) => project.id !== id && uploadNameKey(project.media.filename) === key;
  return !scan.entries.some(({ project }) => project && references(project))
    && ![...projects.values(), ...binned.values(), ...invalidBinRecords.values()].some(references);
}

async function beginPurge(id: string, { instanceId, expiredBy }: { instanceId?: string; expiredBy?: number }) {
  const project = requireBinned(id, instanceId);
  if (expiredBy !== undefined && expiredBy <= Date.parse(project.deletion.restoreUntil)) throw new ProjectBinError('expired');
  const scan = await inspectLifecycleRecord(project);
  if (!project.deletion.purgeStartedAt) {
    await publishDeletion(project, { ...project.deletion, purgeStartedAt: new Date().toISOString() });
  }
  return { filename: project.media.filename, ownsUpload: (filename: string) => mayRemoveUpload(id, filename, scan) };
}

async function finishPurge(id: string) {
  // Clear the order reference before unlinking the retry record. A failure here
  // leaves that record discoverable by a subsequent filesystem scan on restart.
  await inspectLifecycleRecord(requireBinned(id));
  await withStorageMutation(async () => {
    await queueOrderUpdate((current) => current.filter((projectId) => projectId !== id));
    await fs.rm(projectFile(id), { force: true });
    binned.delete(id);
    durableProjectWrites.delete(id);
    publishedProjectIds.delete(id);
  });
}

async function recheckProjectStorage() {
  // Per-project writes remain independent. A scan may be published only when
  // none of its awaited reads overlapped a file/reference/index mutation.
  for (let attempt = 0; attempt < 3; attempt++) {
    if (activeStorageMutations) break;
    const generation = storageMutationGeneration;
    const scan = await scanProjectStorage(projectDir);
    const next = storageStatusFromScan(scan, knownRecordCount());
    const index = await readStorageJson(orderFile);
    next.orderUnreadable = index.state === 'unreadable' || (index.state === 'ok' && (!Array.isArray(index.value) || !index.value.every((id) => typeof id === 'string')));
    const marker = await readMigrationMarker(migrationMarker);
    if (marker === 'unreadable') next.migrationPending = true;
    if (marker === 'missing') {
      const legacy = await readStorageJson(config.dataFile);
      next.legacyUnreadable = legacy.state === 'unreadable' || (legacy.state === 'ok' && (!Array.isArray(legacy.value) || !legacy.value.every(isLoadableProject)));
      next.migrationPending = true;
    }
    next.missingProjectCount = missingProjectCount(scan, index.state === 'ok' && !next.orderUnreadable ? index.value as string[] : []);
    // Discard the entire candidate before touching any sticky recovery state.
    // There is no await between validation and synchronous publication below.
    if (activeStorageMutations || generation !== storageMutationGeneration) continue;
    noteDisputedRecords(scan);
    // A read-only recheck cannot establish a safe migration transition for the
    // running objects. Once blocked, only a known-safe restart can unlock it.
    if (next.migrationPending) migrationDeletionBlocked = true;
    if (next.unreadableProjectCount || next.missingProjectCount || next.duplicateProjectCount || next.directoryUnreadable
      || next.orderUnreadable || next.legacyUnreadable || next.migrationPending) startupNeedsRestart = true;
    next.restartRequired = startupNeedsRestart || orderReadFault || disputedIds.size > 0 || scan.entries.some((entry) => entry.project && !knownRecord(entry.project.id));
    storageStatus = next;
    return;
  }
  // The API maps this to its existing sanitized unavailable response. Keep the
  // previous snapshot and recovery flags until a subsequent stable recheck.
  throw new Error('Saved project storage changed during the check. Try again.');
}

export const store = {
  initialize: ensureInitialized,
  isHiddenByBin,
  migrationBlocksDeletion() { return migrationDeletionBlocked; },

  async storageStatus(recheck = false): Promise<ProjectStorageStatus> {
    await ensureInitialized();
    if (recheck) await recheckProjectStorage();
    return { ...storageStatus, loadedProjectCount: knownRecordCount() };
  },
  /** False after a committed write whose directory flush is unavailable. */
  latestWriteIsDurable(id: string) { return durableProjectWrites.get(id) !== false; },
  projectOrderIsSaved(id: string) { return indexedProjectIds.has(id); },
  async listSummaries() {
    await ensureInitialized();
    const summarizing = beginProjectLoadingPhase('summary');
    try {
    return order
      .map((id) => projects.get(id))
      .filter((project): project is CaptionProject => Boolean(project))
      .map(summarizeProject);
    } finally { endProjectLoadingPhase(summarizing, order.length); }
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

  /** The same published snapshot as get(), without cloning private caption payloads. */
  async getAppearance(id: string): Promise<CaptionProjectAppearance | null> {
    await ensureInitialized();
    const project = projects.get(id);
    return project ? structuredClone({ id: project.id, media: project.media, captionAppearance: project.captionAppearance }) : null;
  },

  async upsert(project: CaptionProject) {
    const snapshot = structuredClone(project);
    await ensureInitialized();
    return queueProjectWrite(snapshot.id, async () => {
      if (isHiddenByBin(snapshot.id)) throw new ProjectBinError('project_binned');
      if (snapshot.deletion !== undefined) throw new Error('Use the project bin to change deletion state');
      // Caption/transcript operations own their fields, not appearance. They may have
      // started before a concurrent appearance save; never restore that older look.
      const current = projects.get(snapshot.id);
      if (current) snapshot.captionAppearance = current.captionAppearance;
      if (current?.generationModel !== undefined) snapshot.generationModel = current.generationModel;
      else if (current) delete snapshot.generationModel;
      return persistProject(snapshot);
    });
  },

  async withProjectWrite<T>(
    id: string,
    operation: (
      current: CaptionProject | null,
      persist: (next: CaptionProject, options?: { restoreAppearance?: boolean; updateGenerationModel?: boolean; recoverCreationOrder?: boolean }) => Promise<CaptionProject>,
    ) => Promise<T>,
  ): Promise<T> {
    await ensureInitialized();
    return queueProjectWrite(id, async () => {
      const current = projects.get(id);
      const detached = current ? structuredClone(current) : null;
      let persisted = false;
      const persist = async (next: CaptionProject, options?: { restoreAppearance?: boolean; updateGenerationModel?: boolean; recoverCreationOrder?: boolean }) => {
        if (next.id !== id) throw new Error('Project write cannot change project id');
        if (persisted) throw new Error('Project write already persisted');
        if (isHiddenByBin(id)) throw new ProjectBinError('project_binned');
        const snapshot = structuredClone(next);
        if (snapshot.deletion !== undefined) throw new Error('Use the project bin to change deletion state');
        const published = projects.get(id);
        if (published && !options?.restoreAppearance) snapshot.captionAppearance = published.captionAppearance;
        if (published && !options?.updateGenerationModel) {
          if (published.generationModel !== undefined) snapshot.generationModel = published.generationModel;
          else delete snapshot.generationModel;
        }
        persisted = true;
        return persistProject(snapshot, !published && options?.recoverCreationOrder === true);
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

  async listBinned() {
    await ensureInitialized();
    return [...binned.values(), ...invalidBinRecords.values()].map((project) => {
      const deletion = isProjectDeletion(project.deletion) ? project.deletion : null;
      return { id: project.id, title: project.title, captionCount: project.captions.length,
        binnedAt: deletion?.binnedAt ?? '', restoreUntil: deletion?.restoreUntil ?? '', instanceId: deletion?.instanceId ?? '',
        purging: migrationDeletionBlocked || disputedIds.has(project.id) || Boolean(deletion?.purgeStartedAt) };
    }).sort((a, b) => (Date.parse(b.binnedAt) || 0) - (Date.parse(a.binnedAt) || 0));
  },

  async listPurgeCandidates(now: number) {
    await ensureInitialized();
    return [...binned.values()].filter(({ id, deletion }) => !disputedIds.has(id)
      && (deletion.purgeStartedAt || now > Date.parse(deletion.restoreUntil)))
      .map(({ id, deletion }) => ({ id, instanceId: deletion.instanceId, started: Boolean(deletion.purgeStartedAt) }));
  },

  async moveToBin(id: string, now?: number, afterPublished?: () => Promise<void>) {
    await ensureInitialized();
    return queueProjectWrite(id, async () => {
      const project = projects.get(id);
      if (!project) throw new ProjectBinError('not_found');
      await inspectLifecycleRecord(project);
      const binnedAt = now ?? Date.now();
      const deletion = { instanceId: randomUUID(), binnedAt: new Date(binnedAt).toISOString(),
        restoreUntil: new Date(binnedAt + PROJECT_RESTORE_WINDOW_MS).toISOString(), recordUpdatedAt: project.updatedAt };
      if (!isProjectDeletion(deletion)) throw new ProjectBinError('storage_blocked');
      await publishDeletion(project, deletion);
      await afterPublished?.();
      return { id, instanceId: deletion.instanceId, restoreUntil: deletion.restoreUntil };
    });
  },

  async restoreFromBin(id: string, instanceId: string, now?: number, beforePublish?: () => Promise<void>) {
    await ensureInitialized();
    return queueProjectWrite(id, async () => {
      const project = requireBinned(id, instanceId);
      if (project.deletion.purgeStartedAt) throw new ProjectBinError('purging');
      const deadline = Date.parse(project.deletion.restoreUntil);
      if ((now ?? Date.now()) > deadline) throw new ProjectBinError('expired');
      await inspectLifecycleRecord(project);
      await beforePublish?.();
      if ((now ?? Date.now()) > deadline) throw new ProjectBinError('expired');
      return summarizeProject(await publishDeletion(project));
    });
  },

  async purgeBinnedProject(id: string, options: { instanceId?: string; expiredBy?: number },
    drain: (operation: () => Promise<void>) => Promise<void>,
    cleanup: (ownership: Awaited<ReturnType<typeof beginPurge>>) => Promise<void>) {
    await ensureInitialized();
    return queueProjectWrite(id, async () => {
      await inspectLifecycleRecord(requireBinned(id, options.instanceId));
      await drain(async () => {
        const ownership = await beginPurge(id, options);
        await cleanup(ownership);
        await finishPurge(id);
      });
    });
  },
};
