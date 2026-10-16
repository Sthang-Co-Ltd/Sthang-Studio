import type { CaptionProject, TranscriptionContext } from '@kcs/shared';
import { projectMediaKey, type ProjectTicket } from './project-scope';

export interface AccuracyFields { description: string; vocabulary: string }
export interface AccuracyObservation {
  readonly ticket: ProjectTicket;
  readonly publication: number;
  readonly writePublication: number;
  readonly generation: number;
  readonly editRevision: number;
}

export function uniqueContextLines(...groups: Array<string[] | undefined>) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const group of groups) for (const raw of group || []) {
    const line = raw.trim();
    const key = line.toLocaleLowerCase('en');
    if (!line || seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out;
}

export function accuracyPayload(fields: AccuracyFields, defaults?: string[]): TranscriptionContext {
  return { description: fields.description.trim(), vocabulary: uniqueContextLines(defaults, fields.vocabulary.split(/\r?\n/)) };
}

function contextFields(context: TranscriptionContext | undefined, defaults?: string[]): AccuracyFields {
  return { description: context?.description || '', vocabulary: uniqueContextLines(defaults, context?.vocabulary).join('\n') };
}

export function sameAccuracyContext(left: TranscriptionContext | undefined, right: TranscriptionContext | undefined) {
  return JSON.stringify(left || { description: '', vocabulary: [] }) === JSON.stringify(right || { description: '', vocabulary: [] });
}

/** Raw editor text and its acknowledged server baseline have independent owners.
 * Caption-only replies never publish context. Context reads/writes carry both the
 * editor-session ticket and a baseline generation, so a late read cannot undo a
 * newer save, even after leaving and reopening the same source. */
export function createAccuracyContextDraft() {
  let key = '';
  let saved: TranscriptionContext | undefined;
  let fields: AccuracyFields = { description: '', vocabulary: '' };
  let editRevision = 0;
  let publication = 0;
  let writePublication = 0;
  let generation = 0;
  return {
    get key() { return key; },
    get saved() { return saved; },
    get fields() { return fields; },
    get editRevision() { return editRevision; },
    retainProject(next: CaptionProject): CaptionProject {
      return projectMediaKey(next) === key ? { ...next, transcriptionContext: saved } : next;
    },
    reset(nextKey: string, context?: TranscriptionContext, defaults?: string[], retained?: AccuracyFields) {
      key = nextKey;
      saved = context;
      fields = retained ? { ...retained } : contextFields(context, defaults);
      publication += 1;
      generation += 1;
      return fields;
    },
    edit(change: Partial<AccuracyFields>) {
      fields = { ...fields, ...change };
      editRevision += 1;
      return fields;
    },
    recoverySince(revision: number): AccuracyFields | undefined {
      return revision === editRevision ? undefined : { ...fields };
    },
    capture(ticket: ProjectTicket): AccuracyObservation { return { ticket, publication, writePublication, generation, editRevision }; },
    publish(context: TranscriptionContext | undefined, observation: AccuracyObservation, currentTicket: ProjectTicket, defaults?: string[], acknowledgement = false, mutation = acknowledgement) {
      if (observation.ticket !== currentTicket || currentTicket.key !== key || observation.generation !== generation) return false;
      // A serial write is authoritative over intervening reads, but never over
      // a newer acknowledged write. Reads cannot undo any newer publication.
      if (mutation ? observation.writePublication !== writePublication : observation.publication !== publication) return false;
      const dirty = JSON.stringify(fields) !== JSON.stringify(contextFields(saved, defaults));
      if (mutation || !sameAccuracyContext(saved, context)) publication += 1;
      if (mutation) writePublication += 1;
      saved = context;
      // A save acknowledges exactly its submitted payload, never later typing.
      // Keep raw spelling/spacing even when its normalized payload is now clean.
      if (!acknowledgement && !dirty && editRevision === observation.editRevision) fields = contextFields(context, defaults);
      return true;
    },
  };
}
