import fs from 'node:fs/promises';
import path from 'node:path';
import type { CaptionProject } from '@kcs/shared';
import { config } from '../config.js';
import { ensureNormalizedAudio, mediaFingerprint } from './cache.js';
import { prewarmLocalTiming } from './local-timing.js';

const scheduled = new Map<string, NodeJS.Timeout>();

/**
 * Start local-only preparation shortly after new/replacement media is persisted.
 * No Gemini upload is performed. The short delay keeps the upload response fast
 * and lets immediate replace/delete actions cancel the scheduled work naturally.
 */
export function scheduleProjectMediaPrewarm(project: CaptionProject) {
  const fingerprint = mediaFingerprint(project);
  const existing = scheduled.get(project.id);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    scheduled.delete(project.id);
    void (async () => {
      try {
        await Promise.all([
          ensureNormalizedAudio(project),
          prewarmLocalTiming(project.id),
        ]);
        // If the source disappeared while the non-destructive preparation was
        // running, leave cleanup to the project's normal invalidation path.
        await fs.stat(path.join(config.uploadDir, project.media.filename));
        console.log(`[prewarm] Local audio ready for project ${project.id} (${fingerprint}).`);
      } catch (error) {
        // Prewarming is optional; Generate performs the same preparation again and
        // provides the user-facing recovery message if something is truly wrong.
        console.warn(`[prewarm] Local preparation skipped for project ${project.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
  }, 350);
  scheduled.set(project.id, timer);
}

export function cancelScheduledProjectPrewarm(projectId: string) {
  const timer = scheduled.get(projectId);
  if (!timer) return;
  clearTimeout(timer);
  scheduled.delete(projectId);
}
