import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export interface FontFaceFile { source: string; name: string }
interface Entry { directory: string; bytes: number; users: number; touched: number; files: Array<{ name: string; size: number }> }
export interface FontLease { directory: string; release(): void }

/** Font-only immutable staging. Never contains ASS, caption text, frames or source media. */
export class PreviewFontCache {
  private entries = new Map<string, Entry>();
  private queue: Promise<void> = Promise.resolve();
  constructor(private maxEntries = 4, private maxBytes = 16 * 1024 * 1024) {}

  acquire(root: string, faces: FontFaceFile[]): Promise<FontLease | null> {
    const task = this.queue.then(() => this.acquireExclusive(root, faces));
    this.queue = task.then(() => undefined, () => undefined);
    return task;
  }

  private async acquireExclusive(root: string, faces: FontFaceFile[]): Promise<FontLease | null> {
    if (!faces.length) return null;
    const files: Array<{ name: string; data: Buffer }> = [];
    let bytes = 0;
    // Hash the bytes, not only mtime/size: replacing a font with equal metadata
    // must never make an older face silently stand in for the selected one.
    for (const face of faces) {
      if (!/^(regular|bold)\.(ttf|otf)$/i.test(face.name)) throw new Error('Invalid staged font name.');
      const stat = await fs.stat(face.source);
      if (!stat.isFile() || bytes + stat.size > this.maxBytes) return null;
      const data = await fs.readFile(face.source);
      const after = await fs.stat(face.source);
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs || data.length !== after.size) return null;
      bytes += data.length;
      if (bytes > this.maxBytes) return null;
      files.push({ name: face.name, data });
    }
    const hash = createHash('sha256');
    for (const file of files) hash.update(file.name).update('\0').update(String(file.data.length)).update('\0').update(file.data);
    const key = `${path.resolve(root)}:${hash.digest('hex')}`;
    let entry = this.entries.get(key);
    if (entry) {
      const intact = await Promise.all(entry.files.map((file) => fs.stat(path.join(entry!.directory, file.name))
        .then((stat) => stat.isFile() && stat.size === file.size).catch(() => false)));
      if (intact.every(Boolean)) return this.lease(entry);
      // Startup cleanup can remove old scratch paths. Never delete a directory
      // still held by another render; fall back to that render's own work folder.
      if (entry.users) return null;
      await fs.rm(entry.directory, { recursive: true, force: true });
      this.entries.delete(key);
    }
    let used = [...this.entries.values()].reduce((sum, item) => sum + item.bytes, 0);
    for (const [oldKey, old] of [...this.entries.entries()].sort((a, b) => a[1].touched - b[1].touched)) {
      if (this.entries.size < this.maxEntries && used + bytes <= this.maxBytes) break;
      if (old.users) continue;
      await fs.rm(old.directory, { recursive: true, force: true });
      this.entries.delete(oldKey); used -= old.bytes;
    }
    if (this.entries.size >= this.maxEntries || used + bytes > this.maxBytes) return null;
    await fs.mkdir(root, { recursive: true });
    const directory = await fs.mkdtemp(path.join(root, 'preview-fonts-'));
    try {
      for (const file of files) await fs.writeFile(path.join(directory, file.name), file.data);
    } catch (error) {
      await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    entry = { directory, bytes, users: 0, touched: Date.now(), files: files.map((file) => ({ name: file.name, size: file.data.length })) };
    this.entries.set(key, entry);
    return this.lease(entry);
  }

  private lease(entry: Entry): FontLease {
    entry.users += 1;
    entry.touched = Date.now();
    let released = false;
    return {
      directory: entry.directory,
      release() {
        if (released) return;
        released = true; entry.users -= 1; entry.touched = Date.now();
      },
    };
  }
}
