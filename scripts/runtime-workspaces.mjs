import fs from 'node:fs/promises';
import path from 'node:path';

const WORKSPACE_LINKS = [
  { link: ['node_modules', '@kcs', 'server'], target: ['apps', 'server'] },
  { link: ['node_modules', '@kcs', 'shared'], target: ['packages', 'shared'] },
  { link: ['node_modules', '@kcs', 'web'], target: ['apps', 'web'] },
];

function samePath(left, right) {
  const a = path.resolve(left).replace(/[\\/]+$/, '');
  const b = path.resolve(right).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * npm creates Windows workspace junctions with absolute targets. OTA preparation
 * installs dependencies beneath updates/work/.../source, then atomically moves
 * that complete source tree into versions/<version>. Refresh only npm's known
 * workspace links after that relocation so runtime imports resolve inside the
 * immutable version directory instead of the retired work directory.
 */
export async function ensureRuntimeWorkspaceLinks(root) {
  for (const workspace of WORKSPACE_LINKS) {
    const link = path.join(root, ...workspace.link);
    const target = await fs.realpath(path.join(root, ...workspace.target));
    let stat;
    try {
      stat = await fs.lstat(link);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }

    if (stat && !stat.isSymbolicLink()) continue;
    if (stat) {
      try {
        const existing = await fs.realpath(link);
        if (samePath(existing, target)) continue;
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      await fs.unlink(link);
    }

    await fs.mkdir(path.dirname(link), { recursive: true });
    await fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  }
}
