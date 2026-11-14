import fs from 'node:fs/promises';
import path from 'node:path';
import { nanoid } from 'nanoid';
import type { CaptionProject } from '@kcs/shared';
import { config } from '../config.js';
import { profileStore } from './profile-store.js';
import { store } from './store.js';

interface UploadedMedia { path: string; originalname: string; mimetype: string; size: number }
interface CreationSource { name: string; size: number; mimeType: string; lastModified: number | null }
type CreationProject = CaptionProject & { creationAttempt?: { id: string; source: CreationSource } };
export interface ProjectCreationReceipt { project: CaptionProject; reused: boolean; orderSaved: boolean }

export class ProjectCreationError extends Error {
  constructor(message: string, readonly code: string, readonly httpStatus: number, readonly outcome: 'not-created' | 'unknown', options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProjectCreationError';
  }
}

async function recordExists(id: string) {
  try { await fs.lstat(path.join(path.dirname(config.dataFile), 'projects', `${id}.json`)); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
function receipt(project: CaptionProject, reused: boolean): ProjectCreationReceipt {
  return { project, reused, orderSaved: store.projectOrderIsSaved(project.id) };
}

/** One immutable browser File attempt owns one opaque project identity. Metadata
 * detects mismatched reuse; it is not a content hash. The existing project queue
 * serializes duplicate submissions, and only unpublished owned staging is removed. */
export async function createProjectFromUpload(uploaded: UploadedMedia, input: { title?: unknown; creationAttemptId?: unknown; lastModified?: unknown }): Promise<ProjectCreationReceipt> {
  try {
    const supplied = input.creationAttemptId !== undefined;
    if (supplied && (typeof input.creationAttemptId !== 'string' || !/^upload_[a-f0-9]{32}$/.test(input.creationAttemptId))) {
      throw new ProjectCreationError('The upload attempt is invalid. Choose the file again.', 'PROJECT_CREATE_NOT_APPLIED', 400, 'not-created');
    }
    const id = supplied ? input.creationAttemptId as string : nanoid(10);
    const lastModified = input.lastModified === undefined ? null : Number(input.lastModified);
    if (lastModified !== null && (!Number.isSafeInteger(lastModified) || lastModified < 0)) {
      throw new ProjectCreationError('The upload file details are invalid. Choose the file again.', 'PROJECT_CREATE_NOT_APPLIED', 400, 'not-created');
    }
    const source: CreationSource = { name: uploaded.originalname, size: uploaded.size, mimeType: uploaded.mimetype || 'application/octet-stream', lastModified };
    return await store.withProjectWrite(id, async (current, persist) => {
      if (current) {
        const attempt = (current as CreationProject).creationAttempt;
        if (!supplied || attempt?.id !== id || JSON.stringify(attempt.source) !== JSON.stringify(source)) {
          throw new ProjectCreationError('This upload attempt belongs to a different file. Start another upload; the saved project was kept.', 'PROJECT_CREATE_ATTEMPT_MISMATCH', 409, 'not-created');
        }
        return receipt(current, true);
      }
      if (await recordExists(id)) {
        throw new ProjectCreationError('Studio found a saved record for this upload but could not read it. Review saved-project storage before trying again.', 'PROJECT_CREATE_UNCONFIRMED', 409, 'unknown');
      }
      let staged: string | null = null;
      try {
        const profile = await profileStore.get();
        const ext = path.extname(uploaded.originalname);
        const filename = `${id}-${nanoid(10)}${ext}`;
        staged = path.join(config.uploadDir, filename);
        await fs.rename(uploaded.path, staged);
        const now = new Date().toISOString();
        const project: CreationProject = {
          id, title: String(input.title || path.basename(uploaded.originalname, ext)), createdAt: now, updatedAt: now,
          media: { filename, originalName: uploaded.originalname, mimeType: source.mimeType, size: uploaded.size, url: `/media/${encodeURIComponent(filename)}` },
          transcriptionContext: { description: '', vocabulary: profile.defaultVocabulary }, transcript: null, captions: [],
          mode: profile.styles[0]?.mode || 'dynamic', engineVersion: '0.7.10',
          ...(supplied ? { creationAttempt: { id, source } } : {}),
        };
        return receipt(await persist(project, { recoverCreationOrder: true }), false);
      } catch (error) {
        // A persistence rejection can follow publication. Never remove a source
        // while a published or unreadable project pointer may still reference it.
        try {
          const published = await store.get(id);
          if (published) return receipt(published, false);
          if (await recordExists(id)) {
            throw new ProjectCreationError('Studio could not confirm the saved upload. Check this upload again before starting another.', 'PROJECT_CREATE_UNCONFIRMED', 503, 'unknown', { cause: error });
          }
        } catch (inspection) {
          if (inspection instanceof ProjectCreationError) throw inspection;
          throw new ProjectCreationError('Studio could not confirm the saved upload. Check this upload again before starting another.', 'PROJECT_CREATE_UNCONFIRMED', 503, 'unknown', { cause: inspection });
        }
        if (staged) await fs.rm(staged, { force: true }).catch(() => {});
        throw new ProjectCreationError('The project was not created. Try this upload again after checking available storage.', 'PROJECT_CREATE_NOT_APPLIED', 503, 'not-created', { cause: error });
      }
    });
  } catch (error) {
    if (error instanceof ProjectCreationError) throw error;
    throw new ProjectCreationError('Studio could not confirm whether the upload was saved. Check this upload before starting another.', 'PROJECT_CREATE_UNCONFIRMED', 503, 'unknown', { cause: error });
  } finally {
    await fs.rm(uploaded.path, { force: true }).catch(() => {});
  }
}
