import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const exportComponentPath = new URL('../apps/web/src/components/ExportWorkspace.tsx', import.meta.url);
const exportCssPath = new URL('../apps/web/src/components/video-export.css', import.meta.url);
const appearanceComponentPath = new URL('../apps/web/src/components/CaptionAppearanceWorkspace.tsx', import.meta.url);
const appearanceCssPath = new URL('../apps/web/src/components/caption-appearance.css', import.meta.url);
const appearancePreviewPath = new URL('../apps/web/src/caption-appearance-preview.ts', import.meta.url);
const appearanceSavePath = new URL('../apps/web/src/caption-appearance-save.ts', import.meta.url);
const jobManagerPath = new URL('../apps/web/src/components/JobManager.tsx', import.meta.url);
const videoExportRoutePath = new URL('../apps/server/src/routes/video-export.ts', import.meta.url);
const appPath = new URL('../apps/web/src/App.tsx', import.meta.url);

const [exportComponent, exportCss, appearanceComponent, appearanceCss, appearancePreview, appearanceSave, jobManager, videoExportRoute, app] = await Promise.all([
  fs.readFile(exportComponentPath, 'utf8'),
  fs.readFile(exportCssPath, 'utf8'),
  fs.readFile(appearanceComponentPath, 'utf8'),
  fs.readFile(appearanceCssPath, 'utf8'),
  fs.readFile(appearancePreviewPath, 'utf8'),
  fs.readFile(appearanceSavePath, 'utf8'),
  fs.readFile(jobManagerPath, 'utf8'),
  fs.readFile(videoExportRoutePath, 'utf8'),
  fs.readFile(appPath, 'utf8'),
]);

test('export keeps video and SRT as explicit accessible output modes', () => {
  assert.match(exportComponent, /aria-label="Export type"/);
  assert.match(exportComponent, /aria-pressed=\{outputMode === 'video'\}/);
  assert.match(exportComponent, /aria-pressed=\{outputMode === 'captions'\}/);
  assert.match(exportComponent, /Captions file \(SRT\)/);
  assert.match(exportComponent, /Captioned video/);
});

test('export is output-focused and points back to project appearance editing', () => {
  assert.match(exportComponent, /<span>Resolution<\/span><select/);
  assert.match(exportComponent, /<span>Frame rate<\/span><select/);
  assert.match(exportComponent, /aria-label="Video quality"/);
  assert.match(exportComponent, /<summary>Advanced video settings<\/summary>/);
  assert.match(exportComponent, /id="export-appearance-title">Caption appearance/);
  assert.match(exportComponent, />Edit appearance<\/button>/);
  assert.doesNotMatch(exportComponent, /<summary>More appearance<\/summary>/);
  assert.doesNotMatch(exportComponent, /<summary>Manage presets<\/summary>/);
  assert.doesNotMatch(exportComponent, /type="color"/);
});

test('appearance is a first-class editor workspace with progressive controls', () => {
  assert.match(app, /WorkspaceTool = [^;]*'appearance'/);
  assert.match(app, /<Palette size=\{16\}\/><span>Appearance<\/span>/);
  assert.match(app, /workspaceTool === 'appearance'[\s\S]*<CaptionAppearanceWorkspace project=\{project\}\/>/);
  assert.match(appearanceComponent, /Style captions while watching the real video above/);
  assert.match(appearanceComponent, /<summary>More appearance<\/summary>/);
  assert.match(appearanceComponent, /<summary>Manage presets<\/summary>/);
  assert.match(appearanceComponent, /<span>Khmer font<\/span>/);
  assert.match(appearanceComponent, /<span>Text color<\/span>/);
  assert.match(appearanceComponent, /<span>Size <b>/);
  assert.match(appearanceComponent, /<span>Position <b>/);
});

test('preset management disclosure keeps the selector full width without dead desktop space', () => {
  assert.match(appearanceComponent, /<details className="appearance-preset-tools"/);
  assert.match(appearanceCss, /\.appearance-preset-bar\{display:block;position:relative;/);
  assert.match(appearanceCss, /\.appearance-preset-bar>label\{min-width:0;max-width:none\}/);
  assert.match(appearanceCss, /\.appearance-preset-bar>label>select\{width:100%\}/);
  assert.match(appearanceCss, /\.appearance-preset-tools summary\{position:absolute;top:14px;right:0\}/);
  assert.match(appearanceCss, /\.appearance-preset-tools\[open\]\{width:100%;min-width:0\}/);
  assert.doesNotMatch(appearanceCss, /\.appearance-preset-bar\{display:flex;align-items:flex-start;/);
  assert.match(appearanceCss, /@media\(max-width:780px\)[\s\S]*\.appearance-preset-tools summary\{position:static\}/);
});

test('project appearance stays on the real video after leaving the Appearance workspace', () => {
  assert.match(appearanceComponent, /applyCaptionAppearancePreview\(appearance\)/);
  assert.match(appearanceComponent, /classList\.add\('caption-appearance-previewing'\)/);
  assert.match(appearanceComponent, /classList\.remove\('caption-appearance-previewing'\)/);
  assert.doesNotMatch(appearanceComponent, /root\.style\.removeProperty/);
  assert.match(appearancePreview, /classList\.add\('caption-project-appearance'\)/);
  assert.match(appearancePreview, /export function clearCaptionAppearancePreview/);
  assert.match(appearanceCss, /caption-project-appearance \.caption-preview-shell/);
  assert.match(appearanceCss, /caption-project-appearance \.caption-preview-shell \.caption-preview/);
  assert.match(appearanceCss, /caption-appearance-previewing \.media-stage::after\{content:'Layout-locked appearance preview'/);
});

test('appearance layout follows the same deterministic line planner as video export', () => {
  assert.match(appearancePreview, /const CAPTION_WRAP_ADVANCE = 0\.72/);
  assert.match(appearancePreview, /const CAPTION_WRAP_FLOOR = 0\.62/);
  assert.match(appearancePreview, /new Intl\.Segmenter\('km', \{ granularity: 'grapheme' \}\)/);
  assert.match(appearancePreview, /export function planCaptionPreviewText/);
  assert.match(appearancePreview, /appearance\.fontSize1080 \* scale/);
  assert.match(appearancePreview, /appearance\.maxWidthPct/);
  assert.match(appearancePreview, /video\.videoWidth/);
  assert.match(appearancePreview, /video\.videoHeight/);
  assert.match(appearancePreview, /new ResizeObserver/);
  assert.match(appearancePreview, /new MutationObserver/);
  assert.match(appearanceCss, /white-space:pre/);
  assert.match(appearanceCss, /overflow-wrap:normal/);
  assert.match(appearanceCss, /word-break:normal/);
  assert.doesNotMatch(appearancePreview, /--caption-live-size', `clamp\(/);
});

test('appearance live preview preserves Khmer glyph paint while using planned lines', () => {
  assert.doesNotMatch(appearanceCss, /\.caption-preview\{display:inline!important/);
  assert.match(appearanceCss, /\.caption-preview\{display:inline-block!important/);
  assert.match(appearanceCss, /paint-order:stroke fill/);
  assert.match(appearanceCss, /line-height:1\.2!important/);
  assert.match(appearanceCss, /\.caption-preview-target\{min-width:0;max-width:100%;padding:0;overflow:visible/);
});

test('appearance autosaves project styling and queues the final workspace value', () => {
  assert.match(appearanceComponent, /Saving automatically…/);
  assert.match(appearanceComponent, /window\.setTimeout\(\(\) => \{ void persistAppearance\(snapshot\); \}, 650\)/);
  assert.match(appearanceComponent, /queueCaptionAppearanceSave\(project\.id, snapshot\)/);
  assert.match(appearanceComponent, /finalSnapshot/);
  assert.match(appearanceComponent, /queueCaptionAppearanceSave\(project\.id, finalSnapshot\)/);
});

test('appearance save barrier serializes writes and recovers the latest failed styling for retry', () => {
  assert.match(appearanceSave, /const queues = new Map<string, Promise<boolean>>\(\)/);
  assert.match(appearanceSave, /const latestSnapshots = new Map<string, CaptionAppearance>\(\)/);
  assert.match(appearanceSave, /latestSnapshots\.set\(projectId, snapshot\)/);
  assert.match(appearanceSave, /const previous = queues\.get\(projectId\)/);
  assert.match(appearanceSave, /await api\.saveCaptionAppearance\(projectId, snapshot\)/);
  assert.match(appearanceSave, /export async function waitForCaptionAppearanceSaves/);
  assert.match(appearanceSave, /export function recoverUnsavedCaptionAppearance/);
  assert.match(appearanceSave, /lastResults\.get\(projectId\) \?\? true/);
  assert.match(appearanceComponent, /await waitForCaptionAppearanceSaves\(project\.id\)/);
  assert.match(appearanceComponent, /recoverUnsavedCaptionAppearance\(project\.id\)/);
});

test('export waits for appearance saves, re-reads saved appearance, and snapshots it into the render request', () => {
  const waits = exportComponent.match(/waitForCaptionAppearanceSaves\(project\.id\)/g) || [];
  assert.ok(waits.length >= 2, `expected Export to wait on appearance during load and render, received ${waits.length}`);
  assert.match(exportComponent, /api\.get\(project\.id\)/);
  assert.match(exportComponent, /setAppearance\(resolvedAppearance\(fresh\)\)/);
  assert.match(exportComponent, /onStartVideoExport\(settings, latestAppearance\)/);
  assert.match(exportComponent, /Your latest caption appearance could not be saved/);
  assert.match(exportComponent, /Choose an available caption font/);
});

test('long-running export and generation work expose progress and elapsed duration', () => {
  assert.match(exportComponent, /className="export-active-progress"/);
  assert.match(exportComponent, /elapsedLabel\(activeExportJob\)/);
  assert.match(exportCss, /\.export-active-progress\{height:5px/);
  assert.match(jobManager, /className="job-progress"/);
  assert.match(jobManager, /Took \$\{formatDuration\(duration\)\}/);
  assert.match(jobManager, /\$\{formatDuration\(duration\)\} elapsed/);
  assert.match(jobManager, /window\.setInterval\(\(\) => setNow\(Date\.now\(\)\), 1000\)/);
});

test('completed captioned-video exports expose a safe obvious Open folder action', () => {
  assert.match(jobManager, /<FolderOpen size=\{13\}\/>Open folder/);
  assert.match(jobManager, /fetch\('\/api\/video-export\/open-folder', \{ method: 'POST' \}\)/);
  assert.match(videoExportRoute, /router\.post\('\/open-folder'/);
  assert.match(videoExportRoute, /process\.platform !== 'win32'/);
  assert.match(videoExportRoute, /spawn\('explorer\.exe', \[config\.exportDir\]/);
  assert.doesNotMatch(videoExportRoute, /req\.body[^\n]*open-folder/);
});

test('selected button states expose semantics instead of relying on color alone', () => {
  const pressedStates = `${exportComponent}\n${appearanceComponent}`.match(/aria-pressed=/g) || [];
  assert.ok(pressedStates.length >= 5, `expected at least five aria-pressed states, received ${pressedStates.length}`);
  assert.match(appearanceComponent, /aria-pressed=\{appearance\.bold\}/);
  assert.match(appearanceComponent, /aria-pressed=\{appearance\.backgroundEnabled\}/);
});

test('export and appearance operational typography never drop below the Studio 10px floor', () => {
  const css = `${exportCss}\n${appearanceCss}`;
  const sizes = [...css.matchAll(/font-size:(\d+(?:\.\d+)?)px/g)].map((match) => Number(match[1]));
  assert.ok(sizes.length > 0, 'expected explicit export/appearance font sizes');
  assert.equal(sizes.filter((size) => size < 10).length, 0, `found font sizes below 10px: ${sizes.filter((size) => size < 10).join(', ')}`);
});

test('desktop and touch controls retain minimum target sizes', () => {
  assert.match(exportCss, /export-quality-choice button\{min-height:36px/);
  assert.match(exportCss, /@media\(max-width:780px\)[\s\S]*export-quality-choice button\{min-height:44px/);
  assert.match(appearanceCss, /appearance-preset-tools-body button,.appearance-workspace-footer button\{min-height:36px/);
  assert.match(appearanceCss, /@media\(max-width:780px\)[\s\S]*toggle-field button,.appearance-workspace-footer button\{min-height:44px/);
});
