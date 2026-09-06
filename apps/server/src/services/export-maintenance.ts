import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

/**
 * No render is running when a new server process starts. Working export folders
 * are therefore crash leftovers, never user-owned completed output. Remove them
 * before interrupted export jobs are offered for resume.
 */
export async function cleanupStaleVideoExportWork() {
  const workingDir = path.join(config.exportDir, '.working');
  await fs.rm(workingDir, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(workingDir, { recursive: true }).catch(() => {});
}
