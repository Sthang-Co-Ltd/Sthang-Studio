import assert from 'node:assert/strict';
import test from 'node:test';
import { WORKSPACE_NAMES, workspaceBuildManifest } from '../scripts/workspace-retry.mjs';

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
