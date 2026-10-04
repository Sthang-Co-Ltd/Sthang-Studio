import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import test from 'node:test';
import { maintainedWindowsNode, reexecReviewedWindowsNode } from '../scripts/windows-node-bootstrap.mjs';

function host(version = '24.13.0') {
  return Object.assign(new EventEmitter(), {
    platform: 'win32', versions: { node: version }, arch: 'x64',
    env: { LOCALAPPDATA: 'C:\\Users\\Review & Test\\AppData\\Local', PATH: 'C:\\old-node', USER_VALUE: 'retained' },
    execArgv: ['--enable-source-maps'], argv: ['C:\\old-node\\node.exe', 'C:\\Studio\\versions\\1.2.3\\scripts\\dev.mjs', '--production'],
  });
}

for (const [version, arch, accepted] of [
  ['24.13.0', 'x64', false], ['24.20.9', 'x64', false], ['24.21.0', 'x64', true],
  ['24.22.1', 'x64', true], ['25.0.0', 'x64', false], ['26.0.0', 'x64', false],
  ['24.21.0-beta', 'x64', false], ['24.21.0', 'arm64', false], ['22.23.3', 'x64', false],
]) test(`Windows Node policy ${version}/${arch}`, () => assert.equal(maintainedWindowsNode(version, arch), accepted));

for (const version of ['24.13.0', '25.0.0']) {
  test(`old broker ${version} reexecs reviewed private Node and preserves update exit42`, async () => {
    const h = host(version);
    let child;
    const code = await reexecReviewedWindowsNode({ host: h,
      spawnSync: (file) => {
        assert.match(file, /Sthang Studio\\tools\\node-v24\.21\.0-win-x64\\node\.exe$/);
        return { status: 0, stdout: '24.21.0 x64\n' };
      },
      spawn: (file, args, options) => {
        assert.deepEqual(args, ['--enable-source-maps', ...h.argv.slice(1)]);
        assert.equal(options.env.USER_VALUE, 'retained');
        assert.equal(options.env.STHANG_STUDIO_NODE_BOOTSTRAP, '1');
        assert.ok(options.env.PATH.startsWith(file.slice(0, -9)));
        child = new EventEmitter(); child.kill = (signal) => { assert.equal(signal, 'SIGTERM'); };
        queueMicrotask(() => { h.emit('SIGTERM'); child.emit('close', 42, null); });
        return child;
      },
    });
    assert.equal(code, 42);
    assert.equal(h.listenerCount('SIGTERM'), 0);
  });
}

test('current reviewed Node and non-Windows never bootstrap', async () => {
  for (const h of [host('24.21.0'), Object.assign(host(), { platform: 'darwin' }), Object.assign(host(), { platform: 'linux' })]) {
    assert.equal(await reexecReviewedWindowsNode({ host: h, spawnSync: () => assert.fail('must not probe') }), null);
  }
});

test('missing/stale private Node fails safely without another executable or download', async () => {
  for (const probe of [{ error: new Error('ENOENT') }, { status: 0, stdout: '25.0.0 x64' }, { status: 0, stdout: '24.20.0 x64' }]) {
    await assert.rejects(reexecReviewedWindowsNode({ host: host(), spawnSync: () => probe, spawn: () => assert.fail('must not launch') }), /unavailable or outdated/);
  }
});

test('bootstrap marker bounds retries and setup/launch use the reviewed module', async () => {
  const h = host(); h.env.STHANG_STUDIO_NODE_BOOTSTRAP = '1';
  await assert.rejects(reexecReviewedWindowsNode({ host: h, spawnSync: () => assert.fail('must not retry') }), /Reviewed Node/);
  assert.match(fs.readFileSync(new URL('../scripts/dev.mjs', import.meta.url), 'utf8'), /await reexecReviewedWindowsNode\(\)/);
  const launcher = fs.readFileSync(new URL('../scripts/launch-studio.ps1', import.meta.url), 'utf8');
  assert.match(launcher, /Get-StudioManagedNode -NoDownload/);
  assert.doesNotMatch(launcher, /& node /);
  const prepare = fs.readFileSync(new URL('../scripts/prepare-studio-update.ps1', import.meta.url), 'utf8');
  assert.ok(prepare.indexOf('Get-StudioManagedNode') < prepare.indexOf('& $ReviewedNpm ci'));
});

for (const entry of ['dev', 'build', 'typecheck']) {
  test(`legacy broker ${entry} entrypoint selects the prepared runtime before work`, async () => {
    const source = fs.readFileSync(new URL(`../scripts/${entry}.mjs`, import.meta.url), 'utf8');
    assert.match(source, /import \{ reexecReviewedWindowsNode \} from '\.\/windows-node-bootstrap\.mjs'/);
    const handoff = source.indexOf('await reexecReviewedWindowsNode()');
    const firstWork = entry === 'build' ? source.indexOf('fs.rmSync(output')
      : entry === 'typecheck' ? source.indexOf('const result = spawnSync(node') : source.indexOf('const root =');
    assert.ok(handoff >= 0 && handoff < firstWork);
    const h = host(); h.argv[1] = `C:\\Studio & Review\\updates\\work\\1.2.3\\source\\scripts\\${entry}.mjs`;
    let forwarded;
    const code = await reexecReviewedWindowsNode({ host: h,
      spawnSync: () => ({ status: 0, stdout: '24.21.0 x64' }),
      spawn: (_file, args) => {
        forwarded = args;
        const child = new EventEmitter(); child.kill = () => {};
        queueMicrotask(() => child.emit('close', entry === 'dev' ? 42 : 0));
        return child;
      },
    });
    assert.equal(code, entry === 'dev' ? 42 : 0);
    assert.deepEqual(forwarded, [...h.execArgv, ...h.argv.slice(1)]);
  });
}


test('released old preparer timing step provisions Node before build/bootstrap', () => {
  const timing = fs.readFileSync(new URL('../scripts/setup-local-timing-windows.ps1', import.meta.url), 'utf8');
  assert.ok(timing.indexOf('Get-StudioManagedNode') < timing.indexOf('provision-timing.py'));
  const batch = fs.readFileSync(new URL('../setup-local-timing-windows.bat', import.meta.url), 'utf8');
  assert.match(batch, /scripts\\setup-local-timing-windows\.ps1/);
});
