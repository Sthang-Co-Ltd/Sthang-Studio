import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { exportContentBasis, type CaptionProject, type ExportEvidence, type ExportEvidenceFormat } from '@kcs/shared';
import { config } from '../config.js';

const formats = new Set(['srt', 'vtt', 'ttml', 'word-srt', 'word-vtt', 'ass', 'data', 'bundle', 'video']);
const queues = new Map<string, Promise<void>>();
function evidenceFile(id: string) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Error('Invalid project id');
  // Project deletion already removes this project's history directory.
  return path.join(config.historyDir, id, 'export-receipts.json');
}
export function exportFingerprint(project: CaptionProject, format: ExportEvidenceFormat) {
  return crypto.createHash('sha256').update(exportContentBasis(project, format)).digest('hex');
}
export async function readExportEvidence(id: string): Promise<ExportEvidence[]> {
  const file = evidenceFile(id);
  let value: unknown;
  try {
    if ((await fs.stat(file)).size > 8192) throw new Error();
    value = JSON.parse(await fs.readFile(file, 'utf8'));
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw new Error('Export history could not be read.'); }
  if (!Array.isArray(value) || value.length > 9) throw new Error('Export history could not be read.');
  if (!value.every((entry) => entry?.version === 1 && formats.has(entry.format)
    && typeof entry.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(entry.fingerprint)
    && typeof entry.preparedAt === 'string' && Number.isFinite(Date.parse(entry.preparedAt)))
    || new Set(value.map((entry) => entry.format)).size !== value.length) throw new Error('Export history could not be read.');
  return value as ExportEvidence[];
}
/** Optional metadata must never make a successful file preparation/render fail. */
export async function recordExportEvidence(project: CaptionProject, format: ExportEvidenceFormat): Promise<boolean> {
  let entry: ExportEvidence;
  try { entry = { version: 1, format, fingerprint: exportFingerprint(project, format), preparedAt: new Date().toISOString() }; }
  catch { return false; }
  const previous = queues.get(project.id) || Promise.resolve();
  const task = previous.then(async () => {
    const file = evidenceFile(project.id);
    const old = await readExportEvidence(project.id);
    const next = [...old.filter((item) => item.format !== format), entry];
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, `${JSON.stringify(next)}\n`, 'utf8');
      const handle = await fs.open(temp, 'r+');
      try { await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temp, file);
    } finally { await fs.rm(temp, { force: true }).catch(() => {}); }
  });
  const settled = task.then(() => undefined, () => undefined);
  queues.set(project.id, settled);
  try { await task; return true; } catch { return false; }
  finally { if (queues.get(project.id) === settled) queues.delete(project.id); }
}
