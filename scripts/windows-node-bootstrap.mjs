import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

export function maintainedWindowsNode(version, arch) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version || '');
  return Boolean(match && Number(match[1]) === 24 && Number(match[2]) >= 21 && arch === 'x64');
}

// Old installed brokers launch candidate dev.mjs with their PATH Node. Re-exec
// the already prepared private runtime before starting any Studio services.
// No download, global PATH write, or arbitrary environment-supplied executable.
export async function reexecReviewedWindowsNode(options = {}) {
  const host = options.host ?? process;
  if (host.platform !== 'win32' || maintainedWindowsNode(host.versions.node, host.arch)) return null;
  const base = host.env.LOCALAPPDATA || host.env.USERPROFILE;
  if (!base || host.env.STHANG_STUDIO_NODE_BOOTSTRAP === '1') {
    throw new Error('Reviewed Node 24.21+ (24.x) is required. Run the current Windows installer to repair Studio.');
  }
  const node = path.win32.join(base, 'Sthang Studio', 'tools', 'node-v24.21.0-win-x64', 'node.exe');
  const probe = (options.spawnSync ?? spawnSync)(node, ['-p', 'process.versions.node + " " + process.arch'], {
    encoding: 'utf8', windowsHide: true, timeout: 15_000,
  });
  const [version, arch, extra] = (probe.stdout || '').trim().split(/\s+/);
  if (probe.error || probe.status !== 0 || extra || !maintainedWindowsNode(version, arch)) {
    throw new Error('The prepared private Node runtime is unavailable or outdated. Run the current Windows installer to repair Studio.');
  }
  return await new Promise((resolve, reject) => {
    const child = (options.spawn ?? spawn)(node, [...host.execArgv, ...host.argv.slice(1)], {
      stdio: 'inherit', windowsHide: false,
      env: { ...host.env, STHANG_STUDIO_NODE_BOOTSTRAP: '1', PATH: `${path.win32.dirname(node)};${host.env.PATH || host.env.Path || ''}` },
    });
    const forwardInt = () => child.kill('SIGINT');
    const forwardTerm = () => child.kill('SIGTERM');
    host.on('SIGINT', forwardInt);
    host.on('SIGTERM', forwardTerm);
    const cleanup = () => {
      host.removeListener('SIGINT', forwardInt);
      host.removeListener('SIGTERM', forwardTerm);
    };
    child.once('error', (error) => { cleanup(); reject(error); });
    child.once('close', (code, signal) => {
      cleanup();
      resolve(signal ? 128 + (os.constants.signals[signal] || 1) : (code ?? 1));
    });
  });
}
