import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { WORKSPACE_NAMES, workspaceBuildManifest, workspaceRetryPlugin } from '../scripts/workspace-retry.mjs';

function fixture() {
  const bundle = {
    'assets/index.js': { type: 'chunk', fileName: 'assets/index.js', isEntry: true, moduleIds: ['/app/src/main.tsx'], imports: ['assets/react.js'], dynamicImports: [], exports: [], viteMetadata: { importedCss: new Set(['assets/core.css']) } },
    'assets/react.js': { type: 'chunk', fileName: 'assets/react.js', moduleIds: [], imports: [], dynamicImports: [], exports: [] },
  };
  for (const name of WORKSPACE_NAMES) bundle[`assets/${name}.js`] = {
    type: 'chunk', fileName: `assets/${name}.js`, moduleIds: [`/app/src/components/${name}.tsx`],
    imports: ['assets/index.js', 'assets/react.js'], dynamicImports: [], exports: [name], viteMetadata: { importedCss: new Set([`assets/${name}.css`]) },
  };
  return bundle;
}

test('retry metadata binds distinct leaves to the artifact and ordered styles', () => {
  const result = workspaceBuildManifest(fixture(), 'exact-artifact');
  assert.equal(result.buildId, 'exact-artifact');
  assert.deepEqual(result.tools.WaveformEditor.css, ['/assets/core.css', '/assets/WaveformEditor.css']);
  assert.equal(new Set(Object.values(result.tools).map((tool) => tool.entry)).size, 4);
});

for (const mutation of ['private child', 'nested dynamic import', 'eager tool', 'missing export', 'merged tools']) test(`build rejects ${mutation}`, () => {
  const bundle = fixture();
  const tool = bundle['assets/WaveformEditor.js'];
  if (mutation === 'private child') tool.imports.push('assets/not-yet-loaded.js');
  if (mutation === 'nested dynamic import') tool.dynamicImports.push('assets/child.js');
  if (mutation === 'eager tool') bundle['assets/index.js'].imports.push(tool.fileName);
  if (mutation === 'missing export') tool.exports = [];
  if (mutation === 'merged tools') {
    tool.moduleIds.push('/app/src/components/ExportWorkspace.tsx');
    tool.exports.push('ExportWorkspace');
    delete bundle['assets/ExportWorkspace.js'];
  }
  assert.throws(() => workspaceBuildManifest(bundle, 'exact-artifact'), /workspace/i);
});

test('development retry decodes filesystem URLs once while retaining canonical browser imports', async () => {
  const runtime = '/@fs/E:/Desktop%20Code%20&%20Script/Studio/runtime.js';
  const privateDependency = '/src/components/private%20timing.js';
  const modules = new Map([
    ['/src/main.tsx', `import ${JSON.stringify(runtime)};`],
    [decodeURI(runtime), 'export const runtime = true;'],
    [decodeURI(privateDependency), 'export const ready = true;'],
    ...WORKSPACE_NAMES.map((name) => [`/src/components/${name}.tsx`,
      `import ${JSON.stringify(runtime)};${name === 'WaveformEditor' ? `import ${JSON.stringify(privateDependency)};` : ''}export const ${name} = true;`]),
  ]);
  const transformed = [];
  let middleware;
  workspaceRetryPlugin(fileURLToPath(new URL('..', import.meta.url))).configureServer({
    watcher: { on() {} },
    middlewares: { use(value) { middleware = value; } },
    async transformRequest(url) {
      transformed.push(url);
      assert.ok(modules.has(url), `Vite expects a decoded module URL: ${url}`);
      return { code: modules.get(url) };
    },
  });
  async function request(url) {
    const headers = new Map();
    const response = { statusCode: 200, setHeader(name, value) { headers.set(name, value); }, end(body) { this.body = body; } };
    await middleware({ url, method: 'GET' }, response, () => assert.fail('Retry request must be handled.'));
    return { ...response, headers };
  }
  const manifest = await request('/studio-workspaces.json');
  assert.equal(manifest.statusCode, 200);
  assert.equal(JSON.parse(manifest.body).tools.WaveformEditor.entry, '/src/components/WaveformEditor.tsx');
  assert.ok(transformed.includes(decodeURI(runtime)));
  assert.ok(transformed.includes(decodeURI(privateDependency)));
  assert.ok(!transformed.includes(runtime));
  for (const attempt of ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']) {
    const query = `studio-retry=${attempt}&studio-tool=WaveformEditor`;
    const entry = await request(`/src/components/WaveformEditor.tsx?${query}`);
    assert.equal(entry.statusCode, 200);
    assert.equal(entry.headers.get('Cache-Control'), 'no-store');
    assert.ok(entry.body.includes(JSON.stringify(runtime)), 'Shared runtime retains its canonical browser URL.');
    assert.ok(entry.body.includes(JSON.stringify(`${privateDependency}?${query}`)), 'Private imports retain encoded paths and get the fresh attempt.');
    const child = await request(`${privateDependency}?${query}`);
    assert.equal(child.statusCode, 200);
    assert.equal(child.body, modules.get(decodeURI(privateDependency)));
  }
  const foreignTool = await request(`${privateDependency}?studio-retry=11111111-1111-4111-8111-111111111111&studio-tool=ExportWorkspace`);
  assert.equal(foreignTool.statusCode, 503);
  assert.equal(transformed.length, modules.size, 'The validated graph remains cached across explicit retries.');
});
