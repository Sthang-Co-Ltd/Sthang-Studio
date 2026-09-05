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

test('completed job actions live under job metadata instead of floating in a detached column', () => {
  assert.match(manager, /className="job-meta"[\s\S]*className="job-actions"/);
  assert.match(css, /\.job-modal \.job-list article\{display:grid;grid-template-columns:34px minmax\(0,1fr\)/);
  assert.match(css, /\.job-modal \.job-actions\{margin-top:10px;padding-top:10px;border-top:/);
  assert.match(css, /justify-content:flex-end/);
  assert.match(manager, /className="job-action-primary"[\s\S]*Download video/);
  assert.match(manager, /'Open folder'/);
});

test('Activity metadata is deliberately separated into readable lines', () => {
  assert.match(manager, /<div className="job-meta">/);
  assert.match(manager, /job\.resultExport && <small>/);
  assert.match(css, /\.job-modal \.job-meta\{display:flex!important;flex-direction:column;/);
  assert.match(css, /\.job-modal \.job-meta small\{display:block;font-size:10px/);
});

test('Windows export-folder launch uses PowerShell shell association with a bounded timeout', () => {
  assert.match(route, /process\.env\.WINDIR \|\| process\.env\.SystemRoot \|\| 'C:\\\\Windows'/);
  assert.match(route, /path\.join\(windowsRoot, 'System32', 'WindowsPowerShell', 'v1\.0', 'powershell\.exe'\)/);
  assert.match(route, /STHANG_STUDIO_EXPORT_DIR: exportDir/);
  assert.match(route, /Invoke-Item -LiteralPath \$env:STHANG_STUDIO_EXPORT_DIR/);
  assert.match(route, /const OPEN_FOLDER_TIMEOUT_MS = 5000/);
  assert.match(route, /setTimeout\(\(\) => \{/);
  assert.match(route, /child\.kill\(\)/);
  assert.match(route, /child\.once\('error'/);
  assert.match(route, /child\.once\('close'/);
  assert.doesNotMatch(route, /req\.body[^\n]*open-folder/);
  assert.doesNotMatch(route, /start \"\"/);
});

test('folder action scopes Opening state to the clicked job and cannot hang forever', () => {
  assert.match(manager, /const \[openingFolderJobId, setOpeningFolderJobId\] = useState<string \| null>\(null\)/);
  assert.match(manager, /const OPEN_FOLDER_REQUEST_TIMEOUT_MS = 7000/);
  assert.match(manager, /const controller = new AbortController\(\)/);
  assert.match(manager, /controller\.abort\(\)/);
  assert.match(manager, /signal: controller\.signal/);
  assert.match(manager, /const openingThisFolder = openingFolderJobId === job\.id/);
  assert.match(manager, /openExportsFolder\(job\.id\)/);
  assert.match(manager, /openingThisFolder \? 'Opening…' : 'Open folder'/);
  assert.match(manager, /setFolderNotice\('Opened Studio exports in File Explorer\.'\)/);
  assert.match(manager, /className="activity-notice" role="status"/);
  assert.match(manager, /className="activity-error" role="alert"/);
});

test('Activity controls preserve desktop and narrow touch target floors', () => {
  assert.match(css, /\.job-modal \.job-actions button\{min-height:36px/);
  assert.match(css, /@media\(max-width:620px\)[\s\S]*\.job-modal \.job-actions button\{flex:1 1 145px;min-height:44px/);
  assert.match(css, /focus-visible/);
});
