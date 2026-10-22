import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { DEFAULT_CAPTION_APPEARANCE, normalizeVideoExportSettings, type CaptionProject, type ProcessingJob } from '@kcs/shared';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-export-receipt-native-'));
process.env.STHANG_STUDIO_STATE_ROOT = root;
process.env.STHANG_STUDIO_ENV_FILE = path.join(root, 'absent.env');
process.env.GEMINI_API_KEY = '';
process.env.STHANG_CONTRIBUTION_ENDPOINT = '';
process.env.STHANG_ANALYTICS_ENDPOINT = '';
const { config } = await import('../apps/server/src/config.js');
const { store } = await import('../apps/server/src/services/store.js');
const { cancelScheduledProjectPrewarm } = await import('../apps/server/src/services/prewarm.js');
const { jobStore } = await import('../apps/server/src/services/job-store.js');
const { fontCapabilities } = await import('../apps/server/src/services/caption-renderer.js');
const { exportFingerprint, readExportEvidence } = await import('../apps/server/src/services/export-evidence.js');
const font = (await fontCapabilities()).find((value) => value.available);
assert.ok(font, 'Native receipt test requires a compatible local Khmer font');
await fs.mkdir(config.uploadDir, { recursive: true });
const filename = 'synthetic-receipt.mp4';
execFileSync(config.ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=640x360:r=25:d=1',
  '-threads', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(config.uploadDir, filename)], { windowsHide: true, timeout: 30_000 });
const size = (await fs.stat(path.join(config.uploadDir, filename))).size;

async function waitForJob(id: string) {
  let stop = () => {};
  let timer: NodeJS.Timeout | undefined;
  try {
    return await new Promise<ProcessingJob>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Native export did not finish within 30 seconds')), 30_000);
      stop = jobStore.subscribe((jobs) => {
        const job = jobs.find((value) => value.id === id);
        if (job && ['completed', 'failed', 'cancelled'].includes(job.status)) resolve(job);
      });
    });
  } finally { if (timer) clearTimeout(timer); stop(); }
}
after(async () => {
  // Preserve evidence if any native operation remains active.
  if (jobStore.hasAnyActive()) return;
  const relative = path.relative(os.tmpdir(), root);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  await fs.rm(root, { recursive: true, force: true });
});

for (const failReceipt of [false, true]) test(`real video completion keeps immutable content provenance, optional receipt failure=${failReceipt}`, async () => {
  const id = failReceipt ? 'receipt-io-fails' : 'receipt-ok';
  const original: CaptionProject = { id, title: 'Synthetic receipt', mode: 'phrase', transcript: null,
    createdAt: '2026-01-01', updatedAt: '2026-01-01',
    media: { filename, originalName: filename, mimeType: 'video/mp4', size, url: `/media/${filename}` },
    captionAppearance: { ...DEFAULT_CAPTION_APPEARANCE, fontFamily: font.name, bold: false },
    captions: [{ id: 'c1', text: 'ខ្មែរ Test', startMs: 100, endMs: 800 }] };
  await store.upsert(original); cancelScheduledProjectPrewarm(id);
  if (failReceipt) await fs.mkdir(path.join(config.historyDir, id, 'export-receipts.json'), { recursive: true });
  const queued = await jobStore.create('export-video', id, { exportSettings: normalizeVideoExportSettings({}),
    exportAppearance: original.captionAppearance!, exportCaptions: structuredClone(original.captions), exportMediaFilename: filename, exportMediaSize: size });
  await store.upsert({ ...original, captions: [{ ...original.captions[0], text: 'Newer edits' }] });
  const completed = await waitForJob(queued.id);
  assert.equal(completed.status, 'completed', completed.error);
  assert.ok(completed.resultExport);
  assert.equal(completed.exportContentFingerprint, exportFingerprint(original, 'video'));
  assert.notEqual(completed.exportContentFingerprint, exportFingerprint((await store.get(id))!, 'video'));
  const persisted = JSON.parse(await fs.readFile(config.jobsFile, 'utf8')) as ProcessingJob[];
  assert.equal(persisted.find((job) => job.id === queued.id)?.exportContentFingerprint, completed.exportContentFingerprint);
  if (!failReceipt) assert.equal((await readExportEvidence(id))[0].fingerprint, completed.exportContentFingerprint);
  else assert.match(completed.message, /history could not be saved/);
});
