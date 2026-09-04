import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const componentPath = new URL('../apps/web/src/components/ExportWorkspace.tsx', import.meta.url);
const cssPath = new URL('../apps/web/src/components/video-export.css', import.meta.url);

const [component, css] = await Promise.all([
  fs.readFile(componentPath, 'utf8'),
  fs.readFile(cssPath, 'utf8'),
]);

test('export keeps video and SRT as explicit accessible output modes', () => {
  assert.match(component, /aria-label="Export type"/);
  assert.match(component, /aria-pressed=\{outputMode === 'video'\}/);
  assert.match(component, /aria-pressed=\{outputMode === 'captions'\}/);
  assert.match(component, /Captions file \(SRT\)/);
  assert.match(component, /Captioned video/);
});

test('common export choices stay compact while specialist controls remain progressive', () => {
  assert.match(component, /<span>Resolution<\/span><select/);
  assert.match(component, /<span>Frame rate<\/span><select/);
  assert.match(component, /aria-label="Video quality"/);
  assert.match(component, /<summary>Advanced video settings<\/summary>/);
  assert.match(component, /<summary>More appearance<\/summary>/);
  assert.match(component, /<summary>Manage presets<\/summary>/);
});

test('selected button states expose semantics instead of relying on color alone', () => {
  const pressedStates = component.match(/aria-pressed=/g) || [];
  assert.ok(pressedStates.length >= 5, `expected at least five aria-pressed states, received ${pressedStates.length}`);
  assert.match(component, /aria-pressed=\{appearance\.bold\}/);
  assert.match(component, /aria-pressed=\{appearance\.backgroundEnabled\}/);
});

test('export operational typography never drops below the Studio 10px floor', () => {
  const sizes = [...css.matchAll(/font-size:(\d+(?:\.\d+)?)px/g)].map((match) => Number(match[1]));
  assert.ok(sizes.length > 0, 'expected explicit export font sizes');
  assert.equal(sizes.filter((size) => size < 10).length, 0, `found export font sizes below 10px: ${sizes.filter((size) => size < 10).join(', ')}`);
});

test('desktop and touch export controls retain minimum target sizes', () => {
  assert.match(css, /export-quality-choice button,.toggle-field button\{min-height:36px/);
  assert.match(css, /@media\(max-width:780px\)[\s\S]*export-quality-choice button\{min-height:44px/);
});
