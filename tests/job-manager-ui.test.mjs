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

test('Activity header keeps title and supporting copy in a readable vertical stack without a redundant status badge', () => {
  assert.match(manager, /className="job-modal-heading-copy"><strong>Activity<\/strong><span>\{queueSummary\}<\/span>/);
  assert.doesNotMatch(manager, /job-modal-heading-icon/);
  assert.doesNotMatch(manager, /const headerIcon/);
  assert.match(css, /\.job-modal-heading-copy\{display:flex!important;flex-direction:column;/);
  assert.match(css, /\.job-modal-heading-copy strong\{font-size:15px/);
  assert.match(css, /\.job-modal-heading-copy span\{font-size:11px;line-height:1\.45/);
});

test('Activity uses a Studio-styled close control instead of the generic modal button treatment', () => {
  assert.match(manager, /className="job-modal-close" aria-label="Close Activity"/);
  assert.match(css, /\.job-modal-close\{width:36px!important;height:36px!important/);
  assert.match(css, /background:#15191e!important/);
  assert.match(css, /\.job-modal-close:hover/);
  assert.match(css, /@media\(max-width:620px\)[\s\S]*\.job-modal-close\{width:44px!important;height:44px!important/);
});

test('completed job actions live under job metadata with Download video as the export result action', () => {
  assert.match(manager, /className="job-meta"[\s\S]*className="job-actions"/);
  assert.match(css, /\.job-modal \.job-list article\{display:grid;grid-template-columns:34px minmax\(0,1fr\)/);
  assert.match(css, /\.job-modal \.job-actions\{margin-top:10px;padding-top:10px;border-top:/);
  assert.match(css, /justify-content:flex-end/);
  assert.match(manager, /className="job-action-primary"[\s\S]*Download video/);
  assert.doesNotMatch(manager, /Open folder/);
  assert.doesNotMatch(manager, /openExportsFolder/);
});

test('Activity metadata is deliberately separated into readable lines', () => {
  assert.match(manager, /<div className="job-meta">/);
  assert.match(manager, /job\.resultExport && <small>/);
  assert.match(css, /\.job-modal \.job-meta\{display:flex!important;flex-direction:column;/);
  assert.match(css, /\.job-modal \.job-meta small\{display:block;font-size:10px/);
});

test('Activity lists Studio fixed export directory instead of trying to launch a desktop shell', () => {
  assert.match(manager, /fetch\('\/api\/video-export\/location'\)/);
  assert.match(manager, /className="activity-export-location"/);
  assert.match(manager, /<span>Exports folder<\/span>/);
  assert.match(manager, /exportDirectory \|\| exportDirectoryError \|\| 'Loading location…'/);
  assert.match(css, /\.activity-export-location\{margin:10px 14px 0/);
  assert.match(css, /\.activity-export-location code\{font-size:10\.5px/);
  assert.match(route, /router\.get\('\/location'/);
  assert.match(route, /res\.json\(\{ directory: config\.exportDir \}\)/);
  assert.doesNotMatch(route, /open-folder/);
  assert.doesNotMatch(route, /spawn\(/);
  assert.doesNotMatch(route, /powershell/i);
});

test('Activity controls preserve desktop and narrow touch target floors', () => {
  assert.match(css, /\.job-modal \.job-actions button\{min-height:36px/);
  assert.match(css, /@media\(max-width:620px\)[\s\S]*\.job-modal \.job-actions button\{flex:1 1 145px;min-height:44px/);
  assert.match(css, /focus-visible/);
});
