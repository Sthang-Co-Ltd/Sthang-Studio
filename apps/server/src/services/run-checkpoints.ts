import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

interface CheckpointEnvelope<T> {
  version: 1;
  signature: string;
  createdAt: string;
  value: T;
}

const checkpointRetentionMs = 48 * 60 * 60 * 1000;
const maxCheckpointRunsPerProject = 24;

function safe(value: string) {
  return value.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 100);
}

function rootFor(projectId: string) {
  return path.join(config.cacheDir, safe(projectId), 'job-checkpoints');
}

function runDir(projectId: string, runKey: string) {
  return path.join(rootFor(projectId), safe(runKey));
}

function fileFor(projectId: string, runKey: string, stageKey: string) {
  return path.join(runDir(projectId, runKey), `${safe(stageKey)}.json`);
}

async function trimProjectCheckpoints(projectId: string, keepRunKey: string) {
  try {
    const root = rootFor(projectId);
    const names = await fs.readdir(root);
    const entries = (await Promise.all(names.map(async (name) => {
      const directory = path.join(root, name);
      try {
        const stat = await fs.stat(directory);
        if (!stat.isDirectory()) return null;
        return { directory, name, mtimeMs: stat.mtimeMs };
      } catch {
        return null;
      }
    }))).filter((entry): entry is { directory: string; name: string; mtimeMs: number } => Boolean(entry));
    entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const now = Date.now();
    let kept = 0;
    for (const entry of entries) {
      const current = entry.name === safe(keepRunKey);
      const fresh = now - entry.mtimeMs <= checkpointRetentionMs;
      if (current || (fresh && kept < maxCheckpointRunsPerProject)) {
        kept += 1;
      } else {
        await fs.rm(entry.directory, { recursive: true, force: true });
      }
    }
  } catch {
    // Checkpoints are an optimization. Cleanup failure must never block work.
  }
}

export async function readRunCheckpoint<T>(
  projectId: string,
  runKey: string | undefined,
  stageKey: string,
  signature: string,
): Promise<T | null> {
  if (!runKey) return null;
  try {
    const filePath = fileFor(projectId, runKey, stageKey);
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8')) as CheckpointEnvelope<T>;
    if (parsed?.version !== 1 || parsed.signature !== signature || parsed.value == null) return null;
    const now = new Date();
    await fs.utimes(path.dirname(filePath), now, now).catch(() => {});
    return parsed.value;
  } catch {
    return null;
  }
}

export async function writeRunCheckpoint<T>(
  projectId: string,
  runKey: string | undefined,
  stageKey: string,
  signature: string,
  value: T,
) {
  if (!runKey) return;
  const directory = runDir(projectId, runKey);
  const filePath = fileFor(projectId, runKey, stageKey);
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.mkdir(directory, { recursive: true });
    const envelope: CheckpointEnvelope<T> = {
      version: 1,
      signature,
      createdAt: new Date().toISOString(),
      value,
    };
    await fs.writeFile(temp, JSON.stringify(envelope), 'utf8');
    await fs.rename(temp, filePath);
    const now = new Date();
    await fs.utimes(directory, now, now).catch(() => {});
    await trimProjectCheckpoints(projectId, runKey);
  } catch (error) {
    console.warn(`[job checkpoint] Could not persist ${stageKey}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}

export async function removeRunCheckpoints(projectId: string, runKey: string | undefined) {
  if (!runKey) return;
  await fs.rm(runDir(projectId, runKey), { recursive: true, force: true });
}
