import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveVideoDimensions, type CaptionLayoutCheckInput, type CaptionLayoutCheckResult, type VideoExportCapabilities } from '@kcs/shared';
import { config } from '../config.js';
import { parseCaptionPreviewInput } from './caption-preview.js';
import { prepareCaptionFonts, requireCaptionFont } from './caption-renderer.js';
import { CaptionOverflowError, validateCaptionOverflow } from './caption-overflow.js';

export class CaptionLayoutCheckError extends Error {
  constructor(message: string, readonly status: 400 | 429 = 400) { super(message); }
}

/** This is an unsaved visual snapshot, never a project write or export request. */
export function parseCaptionLayoutCheckInput(value: unknown): CaptionLayoutCheckInput {
  const input = value as Partial<CaptionLayoutCheckInput> | null;
  if (!input || !Array.isArray(input.captions) || !input.captions.length || input.captions.length > 10_000) {
    throw new CaptionLayoutCheckError('Choose between 1 and 10,000 captions to check.');
  }
  const media = input.expectedMedia;
  if (!media || typeof media.filename !== 'string' || !media.filename || media.filename.length > 1024
    || !Number.isSafeInteger(media.size) || media.size < 0) {
    throw new CaptionLayoutCheckError('A layout check needs the current source version. Reopen Export and try again.');
  }
  const ids = new Set<string>();
  let characters = 0;
  let words = 0;
  for (const caption of input.captions) {
    if (!caption || typeof caption.id !== 'string' || !caption.id || caption.id.length > 128 || ids.has(caption.id)
      || typeof caption.text !== 'string' || caption.text.length > 4096) {
      throw new CaptionLayoutCheckError('The caption list could not be checked. Check caption text and unique caption IDs.');
    }
    ids.add(caption.id);
    characters += caption.text.length;
    if (characters > 200_000) throw new CaptionLayoutCheckError('This caption list is too large to check at once.');
    if (caption.wordTiming !== undefined) {
      const timing = caption.wordTiming;
      if (!timing || typeof timing.text !== 'string' || timing.text.length > 4096
        || !Array.isArray(timing.words) || timing.words.length > 4096) {
        throw new CaptionLayoutCheckError('The word timing could not be checked. Review word timing before trying again.');
      }
      words += timing.words.length;
      if (words > 100_000) throw new CaptionLayoutCheckError('This caption list has too many word timings to check at once.');
    }
  }
  try {
    const parsed = parseCaptionPreviewInput({ ...input, timesMs: [0] });
    // The preview intentionally substitutes indices. Diagnostics retain the validated
    // source IDs so the editor can navigate without confusing duplicate caption text.
    const captions = parsed.captions.map((caption, index) => ({ ...caption, id: input.captions![index].id }));
    return { captions, appearance: parsed.appearance, resolution: parsed.resolution,
      expectedMedia: { filename: media.filename, size: media.size } };
  } catch {
    throw new CaptionLayoutCheckError('The caption layout could not be checked. Review caption times, word timing, and output resolution.');
  }
}

let activeChecks = 0;
const maxConcurrentChecks = 2;

export async function checkCaptionLayout(
  input: CaptionLayoutCheckInput,
  capabilities: VideoExportCapabilities,
  projectId: string,
  signal?: AbortSignal,
): Promise<CaptionLayoutCheckResult> {
  signal?.throwIfAborted();
  const { width, height } = resolveVideoDimensions(capabilities.source.displayWidth, capabilities.source.displayHeight, input.resolution);
  const issue = (status: 'blocked' | 'unavailable', code: string, message: string): CaptionLayoutCheckResult =>
    ({ status, width, height, issues: [{ code, message, captionIds: [] }] });
  if (!input.captions.some((caption) => caption.text.trim() && caption.endMs > caption.startMs)) {
    return issue('unavailable', 'no-visible-captions', 'Add caption text with a start and end time before checking layout.');
  }
  if (!capabilities.subtitlesFilter) return issue('unavailable', 'renderer-unavailable', 'Layout checking is unavailable on this PC. Run System check and try again.');
  try { requireCaptionFont(capabilities.fonts, input.appearance); }
  catch { return issue('blocked', 'font-unavailable', 'The selected font or weight is unavailable. Choose an available font in Appearance.'); }
  if (activeChecks >= maxConcurrentChecks) throw new CaptionLayoutCheckError('Layout checking is busy. Try again shortly.', 429);
  activeChecks += 1;
  let workDir: string | undefined;
  try {
    const parent = path.join(config.exportDir, '.working');
    await fs.mkdir(parent, { recursive: true });
    signal?.throwIfAborted();
    workDir = await fs.mkdtemp(path.join(parent, 'layout-check-'));
    const fontDirectory = await prepareCaptionFonts(workDir, input.appearance);
    signal?.throwIfAborted();
    await validateCaptionOverflow({ captions: input.captions, appearance: input.appearance, width, height,
      fontDirectory, workDir, signal, cacheScope: projectId, collectIssues: true });
    signal?.throwIfAborted();
    return { status: 'passed', width, height, issues: [] };
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof CaptionOverflowError && error.kind === 'overflow') {
      const groups = error.captionGroups.length ? error.captionGroups : [[]];
      return { status: 'blocked', width, height, issues: groups.map((captionIds) => ({
        code: 'caption-overflow', captionIds,
        message: captionIds.length > 1 ? 'These captions overlap and their combined layout extends outside the frame.'
          : 'This caption extends outside the frame. Reduce Size, increase Max width, or adjust its position.',
      })) };
    }
    return issue('unavailable', 'layout-unverified', 'Layout could not be fully checked. Try reducing Size or the number of overlapping captions, then check again.');
  } finally {
    if (workDir) await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    activeChecks -= 1;
  }
}
