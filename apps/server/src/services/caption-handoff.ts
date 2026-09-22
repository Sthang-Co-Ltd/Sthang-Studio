import crypto from 'node:crypto';
import path from 'node:path';
import { nanoid } from 'nanoid';
import {
  analyzeCaptionInterchange,
  captionRenderTime,
  createCaptionData,
  hydrateCaptionWordTimings,
  isVideoProject,
  normalizeCaptionAppearance,
  parseCaptionData,
  serializeCaptionFile,
  type CaptionAppearance,
  type CaptionDataDocument,
  type CaptionDataCue,
  type CaptionFileFormat,
  type CaptionInterchangeInput,
  type CaptionProject,
  type CaptionSegment,
  type SharedCaptionFileFormat,
} from '@kcs/shared';
import { buildAssDocument } from './caption-renderer.js';
import { config } from '../config.js';
import { historyStore } from './history-store.js';
import { jobStore } from './job-store.js';
import { runCommand } from './media.js';
import { store } from './store.js';
import { probeVideoExportCapabilities } from './video-export.js';

export type CaptionHandoffFormat = CaptionFileFormat;

export interface ExpectedMedia {
  filename: string;
  size: number;
}

export interface CaptionHandoffSummary {
  revision: string;
  captionDigest: string;
  snapshot: CaptionDataDocument;
  captionCount: number;
  readyWordCaptionCount: number;
  unresolvedCaptionIds: string[];
  durationMs?: number;
  media: ExpectedMedia;
  formats: {
    plain: Array<'srt' | 'vtt' | 'ttml' | 'data'>;
    wordTimed: Array<'word-srt' | 'word-vtt'>;
    ass: boolean;
    bundle: true;
  };
}

export interface CaptionHandoffExportRequest {
  format: CaptionHandoffFormat;
  expectedMedia: ExpectedMedia;
  expectedRevision: string;
  options?: Record<string, unknown>;
}

export interface CaptionHandoffExportResult {
  body: Buffer;
  contentType: string;
  filename: string;
  warnings: string[];
  revision: string;
}

export interface CaptionRestorePreviewRequest {
  data: string;
  expectedMedia: ExpectedMedia;
  expectedRevision: string;
}

export interface CaptionRestorePreview {
  revision: string;
  candidateDigest: string;
  candidate: CaptionDataDocument;
  captionCount: number;
  readyWordCaptionCount: number;
  sampleCaptions: Array<Pick<CaptionSegment, 'text' | 'startMs' | 'endMs'>>;
  changes: { added: number; removed: number; changed: number };
  appearanceIncluded: boolean;
  appearanceWillRestore: false;
  warnings: string[];
}

export interface CaptionRestoreRequest extends CaptionRestorePreviewRequest {
  confirmed: true;
  expectedCandidateDigest: string;
}

export interface CaptionRestoreResult {
  project: CaptionProject;
  revision: string;
  candidateDigest: string;
}

export class CaptionHandoffError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 428 | 503 = 400) {
    super(message);
    this.name = 'CaptionHandoffError';
  }
}

export interface CaptionHandoffDependencies {
  getProject(id: string): Promise<CaptionProject | null>;
  withProjectWrite<T>(
    id: string,
    operation: (current: CaptionProject | null, persist: (next: CaptionProject) => Promise<CaptionProject>) => Promise<T>,
  ): Promise<T>;
  checkpoint(project: CaptionProject, label: string): Promise<unknown>;
  hasActiveForProject(projectId: string): boolean;
  geometry(project: CaptionProject): Promise<{ width: number; height: number }>;
  mediaDuration(project: CaptionProject): Promise<number>;
  buildAss(captions: CaptionSegment[], appearance: Partial<CaptionAppearance> | undefined, width: number, height: number): string;
}

const MAX_DATA_CHARS = 8_000_000;
const MAX_ZIP_ENTRY_BYTES = 4 * 1024 * 1024;
const MAX_ZIP_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 10;

const fixedFilenames: Record<CaptionHandoffFormat, string> = {
  srt: 'sthang-captions.srt',
  'word-srt': 'sthang-captions-word-by-word.srt',
  vtt: 'sthang-captions.vtt',
  'word-vtt': 'sthang-captions-word-by-word.vtt',
  ttml: 'sthang-captions.ttml',
  ass: 'sthang-captions-styled.ass',
  data: 'sthang-caption-data.json',
  bundle: 'sthang-caption-handoff.zip',
};

const contentTypes: Record<CaptionHandoffFormat, string> = {
  srt: 'application/x-subrip; charset=utf-8',
  'word-srt': 'application/x-subrip; charset=utf-8',
  vtt: 'text/vtt; charset=utf-8',
  'word-vtt': 'text/vtt; charset=utf-8',
  ttml: 'application/ttml+xml; charset=utf-8',
  ass: 'text/plain; charset=utf-8',
  data: 'application/json; charset=utf-8',
  bundle: 'application/zip',
};

function sha256(value: unknown) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function portableSnapshot(project: CaptionProject) {
  return createCaptionData(interchangeInput(hydrateCaptionWordTimings(project)));
}

export function captionHandoffCaptionDigest(captions: CaptionSegment[]) {
  return sha256(createCaptionData({ captions }).captions);
}

export function captionHandoffRevision(project: CaptionProject) {
  const snapshot = portableSnapshot(project);
  return sha256({
    version: 1,
    media: {
      filename: project.media.filename,
      size: project.media.size,
      mimeType: project.media.mimeType,
    },
    captions: snapshot.captions,
    appearance: snapshot.appearance ?? null,
    durationMs: snapshot.durationMs ?? null,
    internalCaptionIds: project.captions.map((caption) => caption.id),
  });
}

function expectedMedia(project: CaptionProject): ExpectedMedia {
  return { filename: project.media.filename, size: project.media.size };
}

function mediaMatches(project: CaptionProject, expected: ExpectedMedia) {
  return project.media.filename === expected.filename && project.media.size === expected.size;
}

function projectDurationMs(project: CaptionProject) {
  const transcriptDuration = project.transcript?.timing?.audioDurationMs;
  return typeof transcriptDuration === 'number' && Number.isFinite(transcriptDuration) && transcriptDuration > 0
    ? transcriptDuration
    : undefined;
}

function wordReadiness(captions: CaptionSegment[]) {
  const analysis = analyzeCaptionInterchange(captions);
  const unresolvedIndices = new Set(analysis.issues
    .filter((issue) => issue.code.startsWith('word-timing-'))
    .map((issue) => issue.captionIndex));
  const unresolvedCaptionIds = captions.flatMap((caption, index) => unresolvedIndices.has(index) ? [caption.id] : []);
  return {
    readyWordCaptionCount: analysis.readyWordCaptionCount,
    unresolvedCaptionIds,
    allReady: captions.length > 0 && analysis.readyWordCaptionCount === captions.length,
  };
}

function summaryForProject(project: CaptionProject): CaptionHandoffSummary {
  const readiness = wordReadiness(project.captions);
  const snapshot = portableSnapshot(project);
  return {
    revision: captionHandoffRevision(project),
    captionDigest: sha256(snapshot.captions),
    snapshot,
    captionCount: project.captions.length,
    readyWordCaptionCount: readiness.readyWordCaptionCount,
    unresolvedCaptionIds: readiness.unresolvedCaptionIds,
    ...(projectDurationMs(project) ? { durationMs: projectDurationMs(project) } : {}),
    media: expectedMedia(project),
    formats: {
      plain: ['srt', 'vtt', 'ttml', 'data'],
      wordTimed: readiness.allReady ? ['word-srt', 'word-vtt'] : [],
      ass: isVideoProject(project),
      bundle: true,
    },
  };
}

function requireCurrentSnapshot(project: CaptionProject, expected: ExpectedMedia, revision: string) {
  let currentRevision: string;
  try {
    currentRevision = captionHandoffRevision(project);
  } catch {
    throw new CaptionHandoffError('The saved captions are invalid or changed. Refresh the handoff summary before exporting.', 409);
  }
  if (!mediaMatches(project, expected) || currentRevision !== revision) {
    throw new CaptionHandoffError('The saved captions or source media changed. Refresh the handoff summary and try again.', 409);
  }
}

function interchangeInput(project: CaptionProject): CaptionInterchangeInput {
  return {
    captions: structuredClone(project.captions),
    appearance: normalizeCaptionAppearance(project.captionAppearance),
    ...(projectDurationMs(project) ? { durationMs: projectDurationMs(project) } : {}),
  };
}

function assertTextPayload(value: string, label: string) {
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes > MAX_ZIP_ENTRY_BYTES) throw new CaptionHandoffError(`${label} is too large for a portable caption handoff.`, 400);
  return value;
}

async function assDocument(project: CaptionProject, dependencies: CaptionHandoffDependencies) {
  if (!isVideoProject(project)) throw new CaptionHandoffError('Styled ASS export requires a video source with readable frame geometry.', 400);
  let snapshot: CaptionDataDocument;
  try {
    snapshot = portableSnapshot(project);
  } catch (error) {
    throw new CaptionHandoffError(error instanceof Error ? error.message : 'Saved captions are invalid for styled ASS export.', 400);
  }
  for (let index = 0; index < snapshot.captions.length; index += 1) {
    const cue = snapshot.captions[index];
    if (captionRenderTime(cue.endMs) <= captionRenderTime(cue.startMs)) {
      throw new CaptionHandoffError(`Caption ${index + 1} collapses on the 10 ms ASS timing grid. Adjust its timing before styled export.`, 400);
    }
  }
  const geometry = await dependencies.geometry(project).catch(() => null);
  if (!geometry?.width || !geometry.height) throw new CaptionHandoffError('Styled ASS export could not read this video frame geometry.', 400);
  return dependencies.buildAss(project.captions, project.captionAppearance, geometry.width, geometry.height);
}

function readmeForBundle(input: { wordFilesIncluded: boolean; assIncluded: boolean; omissions: string[] }) {
  const lines = [
    'Sthang Studio - Editable Caption Handoff',
    '',
    'Quickest path for CapCut Desktop',
    '1. Open your project in CapCut Desktop.',
    '2. Open Captions, choose Add Captions, and import the UTF-8 SRT file from this kit.',
    '3. Place the imported subtitle asset on the timeline aligned with source zero, then review timing, wrapping, font, and placement.',
    '',
    'CapCut Web can import SRT. CapCut Mobile does not currently provide direct subtitle-file import.',
    'If you choose to continue on mobile, import the subtitles in CapCut Desktop or Web first, then use CapCut Cloud Sync.',
    'CapCut Cloud Sync is an external service and may upload your project/captions. Sthang Studio does not automate or control that upload.',
    '',
    'Format notes',
    '- captions.srt: plain editable cue text and cue timing. SRT does not carry Sthang styling or spoken-word highlights.',
    '- Cue overlaps are preserved exactly. Destination editors may stack, reorder, or constrain overlapping captions; Sthang Studio does not silently retime them.',
    '- Final Cut Pro may flag overlapping SRT captions. Review any overlap warnings after import; the handoff intentionally keeps your saved timing unchanged.',
    '- Some editors interpret SRT markup-like text such as angle-bracket tags as styling. Verify literal caption text after import.',
    '- Subtitle times are media-relative from source 00:00:00.000. SRT/VTT/TTML export does not apply a frame-rate conversion.',
    '- captions.vtt / captions.ttml: alternate subtitle handoff formats. Import/edit support varies by editor and version.',
    '- caption-data.json: Sthang portable caption data for restoring editable timing/review information back into Sthang Studio.',
    input.wordFilesIncluded
      ? '- word-by-word SRT/VTT: every timed word is emitted as an individual cue. Editor behavior varies; this does not guarantee native highlight animation.'
      : '- word-by-word SRT/VTT omitted because at least one caption does not have fully ready spoken-word timing.',
    input.assIncluded
      ? '- captions-styled.ass: render-oriented styled events generated from the saved appearance at the source video geometry. It is not a clean native per-word editor track.'
      : '- styled ASS omitted because usable video geometry was not available.',
    '- Some editors import ASS text/timing but discard its styles and word colors. Use SRT for clean caption editing and verify any ASS effect in the receiving app.',
    '',
    'Privacy',
    'This ZIP contains caption text/timing files and this README only. It does not contain source media, fonts, private filesystem paths, or project metadata.',
  ];
  if (input.omissions.length) {
    lines.push('', 'Omitted from this kit:', ...input.omissions.map((item) => `- ${item}`));
  }
  return `${lines.join('\n')}\n`;
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xEDB88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(buffer: Buffer) {
  let crc = 0xFFFFFFFF;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function writeUInt32(value: number) {
  const out = Buffer.allocUnsafe(4);
  out.writeUInt32LE(value >>> 0, 0);
  return out;
}

function writeUInt16(value: number) {
  const out = Buffer.allocUnsafe(2);
  out.writeUInt16LE(value & 0xFFFF, 0);
  return out;
}

export function createStoreZip(entries: Array<{ name: string; contents: string | Buffer }>) {
  if (!entries.length || entries.length > MAX_ZIP_ENTRIES) throw new CaptionHandoffError('Caption bundle entry count is outside the supported range.', 400);
  const seen = new Set<string>();
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  let totalPayload = 0;

  for (const entry of entries) {
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(entry.name) || entry.name.includes('..') || seen.has(entry.name)) {
      throw new CaptionHandoffError('Caption bundle contains an unsafe or duplicate entry name.', 400);
    }
    seen.add(entry.name);
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.isBuffer(entry.contents) ? entry.contents : Buffer.from(entry.contents, 'utf8');
    if (data.length > MAX_ZIP_ENTRY_BYTES) throw new CaptionHandoffError('A caption bundle entry is too large.', 400);
    totalPayload += data.length;
    if (totalPayload > MAX_ZIP_TOTAL_BYTES) throw new CaptionHandoffError('Caption bundle is too large.', 400);
    const checksum = crc32(data);
    const flags = 0x0800;
    const method = 0;
    const dosTime = 0;
    const dosDate = 0x0021;

    const localHeader = Buffer.concat([
      writeUInt32(0x04034B50), writeUInt16(20), writeUInt16(flags), writeUInt16(method),
      writeUInt16(dosTime), writeUInt16(dosDate), writeUInt32(checksum), writeUInt32(data.length), writeUInt32(data.length),
      writeUInt16(name.length), writeUInt16(0), name,
    ]);
    localParts.push(localHeader, data);

    const centralHeader = Buffer.concat([
      writeUInt32(0x02014B50), writeUInt16(20), writeUInt16(20), writeUInt16(flags), writeUInt16(method),
      writeUInt16(dosTime), writeUInt16(dosDate), writeUInt32(checksum), writeUInt32(data.length), writeUInt32(data.length),
      writeUInt16(name.length), writeUInt16(0), writeUInt16(0), writeUInt16(0), writeUInt16(0), writeUInt32(0),
      writeUInt32(localOffset), name,
    ]);
    centralParts.push(centralHeader);
    localOffset += localHeader.length + data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.concat([
    writeUInt32(0x06054B50), writeUInt16(0), writeUInt16(0), writeUInt16(entries.length), writeUInt16(entries.length),
    writeUInt32(centralDirectory.length), writeUInt32(localOffset), writeUInt16(0),
  ]);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function materializeCaptionData(document: CaptionDataDocument): CaptionSegment[] {
  if (!document.captions.length) throw new CaptionHandoffError('Portable caption data must contain at least one caption.', 400);
  return document.captions.map((cue) => {
    const id = nanoid(12);
    return {
      id,
      text: cue.text,
      startMs: cue.startMs,
      endMs: cue.endMs,
      ...(cue.wordTiming ? {
        wordTiming: {
          version: 1 as const,
          text: cue.wordTiming.text,
          words: cue.wordTiming.words.map((word, index) => ({ id: `${id}:word:${index}`, ...word })),
        },
      } : {}),
      ...(cue.confidence !== undefined ? { confidence: cue.confidence } : {}),
      ...(cue.timingQuality !== undefined ? { timingQuality: cue.timingQuality } : {}),
      ...(cue.timingSource !== undefined ? { timingSource: cue.timingSource } : {}),
      approved: false,
      ...(cue.textLocked !== undefined ? { textLocked: cue.textLocked } : {}),
      ...(cue.timingLocked !== undefined ? { timingLocked: cue.timingLocked } : {}),
    };
  });
}

function assertRestoreCueBounds(document: CaptionDataDocument, mediaDurationMs: number) {
  if (!Number.isFinite(mediaDurationMs) || mediaDurationMs <= 0) throw new CaptionHandoffError('Current media duration could not be verified for restore.', 409);
  for (let index = 0; index < document.captions.length; index += 1) {
    const cue = document.captions[index];
    if (cue.endMs - cue.startMs < 40) {
      throw new CaptionHandoffError(`Caption ${index + 1} is shorter than the 40 ms editable minimum.`, 400);
    }
    if (cue.endMs > mediaDurationMs) {
      throw new CaptionHandoffError(`Caption ${index + 1} ends after the current source media.`, 409);
    }
  }
}

async function verifiedMediaDuration(project: CaptionProject, dependencies: CaptionHandoffDependencies) {
  const duration = await dependencies.mediaDuration(project).catch(() => 0);
  if (!Number.isFinite(duration) || duration <= 0) throw new CaptionHandoffError('Current media duration could not be verified for restore.', 409);
  return duration;
}

function assertNoExistingLocks(current: CaptionSegment[]) {
  if (current.some((caption) => caption.textLocked || caption.timingLocked)) {
    throw new CaptionHandoffError('Portable restore replaces caption identities, so existing locked captions cannot be replaced safely. Unlock them explicitly before restoring.', 409);
  }
}

function parsedCandidate(data: string) {
  if (typeof data !== 'string' || !data.trim() || data.length > MAX_DATA_CHARS) throw new CaptionHandoffError('Portable caption data is missing or too large.', 400);
  let parsed: CaptionDataDocument;
  try {
    parsed = parseCaptionData(data);
  } catch (error) {
    throw new CaptionHandoffError(error instanceof Error ? error.message : 'Portable caption data could not be parsed.', 400);
  }
  if (!parsed.captions.length) throw new CaptionHandoffError('Portable caption data must contain at least one caption.', 400);
  const indexed = parsed.captions.map((cue, index) => ({ cue, index }));
  const ordered = [...indexed].sort((left, right) => left.cue.startMs - right.cue.startMs || left.cue.endMs - right.cue.endMs || left.index - right.index);
  const orderNormalized = ordered.some((item, index) => item.index !== indexed[index]?.index);
  return {
    document: orderNormalized ? { ...parsed, captions: ordered.map((item) => item.cue) } : parsed,
    orderNormalized,
  };
}

function candidateDigest(parsed: CaptionDataDocument) {
  return sha256(parsed);
}

function changeCounts(current: CaptionSegment[], imported: CaptionDataCue[]) {
  const currentPortable = createCaptionData({ captions: current }).captions;
  const common = Math.min(currentPortable.length, imported.length);
  const added = Math.max(0, imported.length - currentPortable.length);
  const removed = Math.max(0, currentPortable.length - imported.length);
  let changed = 0;
  for (let index = 0; index < common; index += 1) if (JSON.stringify(currentPortable[index]) !== JSON.stringify(imported[index])) changed += 1;
  return { added, removed, changed };
}

function restorePreview(project: CaptionProject, parsed: CaptionDataDocument, options: { orderNormalized: boolean; mediaDurationMs: number }) {
  assertNoExistingLocks(project.captions);
  const materialized = materializeCaptionData(parsed);
  const readiness = wordReadiness(materialized);
  const warnings: string[] = [];
  if (options.orderNormalized) warnings.push('Imported captions were reordered by start time for a stable editable timeline.');
  if (parsed.durationMs !== undefined && Math.abs(parsed.durationMs - options.mediaDurationMs) > 1) {
    warnings.push(`Portable caption data duration (${parsed.durationMs} ms) differs from the verified current source duration (${options.mediaDurationMs} ms). Caption timing was not retimed.`);
  }
  if (parsed.appearance) warnings.push('Saved caption appearance is included in the portable data but will not be restored by this captions-only import.');
  warnings.push('Imported captions will be marked unapproved so you can review them before final export.');
  return {
    revision: captionHandoffRevision(project),
    candidateDigest: candidateDigest(parsed),
    candidate: parsed,
    captionCount: parsed.captions.length,
    readyWordCaptionCount: readiness.readyWordCaptionCount,
    sampleCaptions: parsed.captions.slice(0, 3).map(({ text, startMs, endMs }) => ({ text, startMs, endMs })),
    changes: changeCounts(project.captions, parsed.captions),
    appearanceIncluded: Boolean(parsed.appearance),
    appearanceWillRestore: false as const,
    warnings,
  } satisfies CaptionRestorePreview;
}

export function createCaptionHandoffService(dependencies: CaptionHandoffDependencies) {
  const loadCurrent = async (projectId: string, media: ExpectedMedia, revision: string) => {
    const project = await dependencies.getProject(projectId);
    if (!project) throw new CaptionHandoffError('Project not found.', 404);
    requireCurrentSnapshot(project, media, revision);
    return hydrateCaptionWordTimings(project);
  };

  const serialize = (project: CaptionProject, format: SharedCaptionFileFormat) => {
    try {
      const serialized = serializeCaptionFile(interchangeInput(project), format);
      return {
        ...serialized,
        text: assertTextPayload(serialized.text, fixedFilenames[format]),
        warnings: serialized.warnings.map((warning) => warning.message),
      };
    } catch (error) {
      if (error instanceof CaptionHandoffError) throw error;
      throw new CaptionHandoffError(error instanceof Error ? error.message : `Could not serialize ${format} captions.`, 400);
    }
  };

  const bundle = async (project: CaptionProject) => {
    const srt = serialize(project, 'srt');
    const vtt = serialize(project, 'vtt');
    const ttml = serialize(project, 'ttml');
    const data = serialize(project, 'data');
    const entries: Array<{ name: string; contents: string | Buffer }> = [
      { name: 'captions.srt', contents: srt.text },
      { name: 'captions.vtt', contents: vtt.text },
      { name: 'captions.ttml', contents: ttml.text },
      { name: 'caption-data.json', contents: data.text },
    ];
    const omissions: string[] = [];
    const warnings: string[] = [];
    const readiness = wordReadiness(project.captions);
    if (readiness.allReady) {
      const wordSrt = serialize(project, 'word-srt');
      const wordVtt = serialize(project, 'word-vtt');
      entries.push(
        { name: 'captions-word-by-word.srt', contents: wordSrt.text },
        { name: 'captions-word-by-word.vtt', contents: wordVtt.text },
      );
    } else {
      const reason = `${readiness.unresolvedCaptionIds.length} caption(s) do not have fully ready word timing; word-by-word SRT/VTT were omitted.`;
      omissions.push(reason);
      warnings.push(reason);
    }

    let assIncluded = false;
    try {
      entries.push({ name: 'captions-styled.ass', contents: assertTextPayload(await assDocument(project, dependencies), 'Styled ASS') });
      assIncluded = true;
    } catch (error) {
      const reason = error instanceof CaptionHandoffError ? error.message : 'Styled ASS could not be produced from this source geometry.';
      omissions.push(reason);
      warnings.push(reason);
    }

    entries.push({
      name: 'README.txt',
      contents: readmeForBundle({ wordFilesIncluded: readiness.allReady, assIncluded, omissions }),
    });
    return { body: createStoreZip(entries), warnings };
  };

  return {
    async summary(projectId: string) {
      const project = await dependencies.getProject(projectId);
      if (!project) throw new CaptionHandoffError('Project not found.', 404);
      return summaryForProject(hydrateCaptionWordTimings(project));
    },

    async export(projectId: string, request: CaptionHandoffExportRequest): Promise<CaptionHandoffExportResult> {
      const project = await loadCurrent(projectId, request.expectedMedia, request.expectedRevision);
      if (!project.captions.length) throw new CaptionHandoffError('There are no saved captions to export.', 400);
      const revision = captionHandoffRevision(project);
      if (request.format === 'bundle') {
        const result = await bundle(project);
        await loadCurrent(projectId, request.expectedMedia, request.expectedRevision);
        return { ...result, contentType: contentTypes.bundle, filename: fixedFilenames.bundle, revision };
      }
      if (request.format === 'ass') {
        const contents = assertTextPayload(await assDocument(project, dependencies), 'Styled ASS');
        await loadCurrent(projectId, request.expectedMedia, request.expectedRevision);
        return { body: Buffer.from(contents, 'utf8'), contentType: contentTypes.ass, filename: fixedFilenames.ass, warnings: [], revision };
      }
      if (request.format === 'word-srt' || request.format === 'word-vtt') {
        const readiness = wordReadiness(project.captions);
        if (!readiness.allReady) throw new CaptionHandoffError('Every caption needs fully ready word timing before exporting a word-by-word subtitle file.', 409);
      }
      const contents = serialize(project, request.format);
      await loadCurrent(projectId, request.expectedMedia, request.expectedRevision);
      return { body: Buffer.from(contents.text, 'utf8'), contentType: contents.mimeType, filename: fixedFilenames[request.format], warnings: contents.warnings, revision };
    },

    async restorePreview(projectId: string, request: CaptionRestorePreviewRequest): Promise<CaptionRestorePreview> {
      const project = await loadCurrent(projectId, request.expectedMedia, request.expectedRevision);
      const candidate = parsedCandidate(request.data);
      const mediaDurationMs = await verifiedMediaDuration(project, dependencies);
      assertRestoreCueBounds(candidate.document, mediaDurationMs);
      const preview = restorePreview(project, candidate.document, { orderNormalized: candidate.orderNormalized, mediaDurationMs });
      await loadCurrent(projectId, request.expectedMedia, request.expectedRevision);
      return preview;
    },

    async restore(projectId: string, request: CaptionRestoreRequest): Promise<CaptionRestoreResult> {
      if (request.confirmed !== true) throw new CaptionHandoffError('Caption restore requires explicit confirmation.', 428);
      if (dependencies.hasActiveForProject(projectId)) throw new CaptionHandoffError('Finish or cancel the active processing job before restoring captions.', 409);
      const candidate = parsedCandidate(request.data);
      const parsed = candidate.document;
      const initial = await loadCurrent(projectId, request.expectedMedia, request.expectedRevision);
      assertRestoreCueBounds(parsed, await verifiedMediaDuration(initial, dependencies));
      const digest = candidateDigest(parsed);
      if (!request.expectedCandidateDigest || request.expectedCandidateDigest !== digest) {
        throw new CaptionHandoffError('The portable caption data changed after preview. Preview it again before restoring.', 409);
      }

      return dependencies.withProjectWrite(projectId, async (current, persist) => {
        if (!current) throw new CaptionHandoffError('Project not found.', 404);
        if (dependencies.hasActiveForProject(projectId)) throw new CaptionHandoffError('Finish or cancel the active processing job before restoring captions.', 409);
        requireCurrentSnapshot(current, request.expectedMedia, request.expectedRevision);
        assertNoExistingLocks(current.captions);
        assertRestoreCueBounds(parsed, await verifiedMediaDuration(current, dependencies));
        await dependencies.checkpoint(current, 'Before portable caption restore');
        if (dependencies.hasActiveForProject(projectId)) throw new CaptionHandoffError('A processing job started while captions were being prepared. Restore was not applied.', 409);
        requireCurrentSnapshot(current, request.expectedMedia, request.expectedRevision);
        const restored = await persist({
          ...current,
          captions: materializeCaptionData(parsed),
          transcriptNeedsSync: true,
          updatedAt: new Date().toISOString(),
        });
        return { project: restored, revision: captionHandoffRevision(restored), candidateDigest: digest };
      });
    },
  };
}

export type CaptionHandoffService = ReturnType<typeof createCaptionHandoffService>;

/**
 * Default server dependencies. Caption serialization/parsing is pure shared code;
 * server dependencies here are local persistence/rendering only.
 */
export function defaultCaptionHandoffDependencies(): CaptionHandoffDependencies {
  return {
    getProject: (id) => store.get(id),
    withProjectWrite: (id, operation) => store.withProjectWrite(id, operation),
    checkpoint: (project, label) => historyStore.checkpoint(project, label, 'restore'),
    hasActiveForProject: (projectId) => jobStore.hasActiveForProject(projectId),
    geometry: async (project) => {
      const capabilities = await probeVideoExportCapabilities(project);
      return { width: capabilities.source.displayWidth, height: capabilities.source.displayHeight };
    },
    mediaDuration: async (project) => {
      const source = path.join(config.uploadDir, project.media.filename);
      const { stdout } = await runCommand(config.ffprobePath, [
        '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', source,
      ], 'Caption restore media duration probe', 15_000);
      const seconds = Number(stdout.trim());
      if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('Media duration probe returned no usable duration.');
      return seconds * 1000;
    },
    buildAss: (captions, appearance, width, height) => buildAssDocument(captions, appearance, width, height),
  };
}
