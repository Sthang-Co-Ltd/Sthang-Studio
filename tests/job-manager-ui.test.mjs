import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const managerPath = new URL('../apps/web/src/components/JobManager.tsx', import.meta.url);
const cssPath = new URL('../apps/web/src/components/job-manager.css', import.meta.url);
const routePath = new URL('../apps/server/src/routes/video-export.ts', import.meta.url);

const [manager, css, route] = await Promise.all([
  fs.readFile(managerPath, 'utf8'),
  fs.readFile(cssPath, 'utf8'),
  fs.readFile(routePath, 'utf8'),
]);

test('Activity header keeps title and supporting copy in a readable vertical stack', () => {
  assert.match(manager, /className="job-modal-heading-copy"><strong>Activity<\/strong><span>\{queueSummary\}<\/span>/);
  assert.match(css, /\.job-modal-heading-copy\{display:flex!important;flex-direction:column;/);
  assert.match(css, /\.job-modal-heading-copy strong\{font-size:14px/);
  assert.match(css, /\.job-modal-heading-copy span\{font-size:10\.5px;line-height:1\.4/);
});

test('completed job actions live under job metadata instead of floating in a detached column', () => {
  assert.match(manager, /className="job-meta"[\s\S]*className="job-actions"/);
  assert.match(css, /\.job-modal \.job-list article\{display:grid;grid-template-columns:34px minmax\(0,1fr\)/);
  assert.match(css, /\.job-modal \.job-actions\{margin-top:10px;padding-top:10px;border-top:/);
  assert.match(css, /justify-content:flex-end/);
  assert.match(manager, /className="job-action-primary"[\s\S]*Download video/);
  assert.match(manager, /<FolderOpen size=\{13\}\/>Open folder/);
});

test('Activity metadata is deliberately separated into readable lines', () => {
  assert.match(manager, /<div className="job-meta">/);
  assert.match(manager, /job\.resultExport && <small>/);
  assert.match(css, /\.job-modal \.job-meta\{display:flex!important;flex-direction:column;/);
  assert.match(css, /\.job-modal \.job-meta small\{display:block;font-size:10px/);
});

test('Windows export-folder launch is visible and waits for Explorer to actually spawn', () => {
  assert.match(route, /process\.env\.WINDIR \|\| process\.env\.SystemRoot \|\| 'C:\\\\Windows'/);
  assert.match(route, /path\.join\(windowsRoot, 'explorer\.exe'\)/);
  assert.match(route, /await fs\.access\(explorerPath\)/);
  assert.match(route, /spawn\(explorerPath, \[exportDir\]/);
  assert.match(route, /child\.once\('error', reject\)/);
  assert.match(route, /child\.once\('spawn'/);
  assert.doesNotMatch(route, /windowsHide\s*:\s*true/);
  assert.doesNotMatch(route, /req\.body[^\n]*open-folder/);
});

test('Activity controls preserve desktop and narrow touch target floors', () => {
  assert.match(css, /\.job-modal \.job-actions button\{min-height:36px/);
  assert.match(css, /@media\(max-width:620px\)[\s\S]*\.job-modal \.job-actions button\{flex:1 1 145px;min-height:44px/);
  assert.match(css, /focus-visible/);
});
