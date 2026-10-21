import { hydrateCaptionWordTimings, type CaptionProject, type TranscriptionContext } from '@kcs/shared';
import { ApiRequestError } from './api';
import { accuracyPayload, sameAccuracyContext, type AccuracyFields } from './accuracy-context-draft';
import { projectMediaKey } from './project-scope';

export type ProjectSaveField = 'captions' | 'context';

export function matchesCaptionSaveBasis(basis: CaptionProject | null, next: CaptionProject): boolean {
  return Boolean(basis && projectMediaKey(basis) === projectMediaKey(next)
    && JSON.stringify(hydrateCaptionWordTimings(basis).captions) === JSON.stringify(hydrateCaptionWordTimings(next).captions));
}

/** A fresh timestamp is usable only when the fields this write will replace
 * still match this editor's acknowledged basis. Other fields remain server-owned.
 * The PUT checks this timestamp again under the project's write lock. */
export function checkedSaveRevision(basis: CaptionProject | null, latest: CaptionProject, field: ProjectSaveField): string {
  const matches = field === 'captions' ? matchesCaptionSaveBasis(basis, latest)
    : basis && projectMediaKey(basis) === projectMediaKey(latest)
      && sameAccuracyContext(basis.transcriptionContext, latest.transcriptionContext);
  if (!matches) {
    throw new ApiRequestError(
      `The saved ${field === 'captions' ? 'captions' : 'Accuracy context'} changed. Download your edits, then reload the saved project to compare.`,
      409, field === 'captions' ? 'CAPTION_REVISION_CHANGED' : 'CONTEXT_REVISION_CHANGED',
    );
  }
  return latest.updatedAt;
}

/** A read owns its context only when that value actually reached the editor.
 * Raw whitespace can keep the old fields visible even when they were normalized clean. */
export function editorAdoptedAccuracy(fields: AccuracyFields, context: TranscriptionContext | undefined, defaults?: string[]): boolean {
  return sameAccuracyContext(accuracyPayload(fields, defaults), accuracyPayload({
    description: context?.description || '', vocabulary: (context?.vocabulary || []).join('\n'),
  }, defaults));
}

/** Adding one correction term owns only that addition, not other context fields
 * which may have changed in another editor. Match the server's bounded transform. */
export function matchesVocabularyAddition(basis: CaptionProject | null, next: CaptionProject, line: string): boolean {
  if (!basis || projectMediaKey(basis) !== projectMediaKey(next)) return false;
  const context = basis.transcriptionContext;
  const description = (context?.description || '').trim().slice(0, 6000);
  const vocabulary = (context?.vocabulary || []).map((value) => value.trim().slice(0, 300)).filter(Boolean).slice(0, 100);
  const cleaned = line.trim();
  if (cleaned && !vocabulary.some((value) => value.toLocaleLowerCase('en') === cleaned.toLocaleLowerCase('en'))) vocabulary.push(cleaned);
  return sameAccuracyContext(next.transcriptionContext, { description, vocabulary });
}
