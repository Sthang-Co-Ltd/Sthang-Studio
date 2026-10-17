import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const web = new URL('../apps/web/src/', import.meta.url);
const css = fs.readFileSync(new URL('styles.css', web), 'utf8');
const waveform = fs.readFileSync(new URL('components/WaveformEditor.tsx', web), 'utf8');

function declarations(selector) {
  return [...css.replace(/^@import[^\n]+/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, selectors]) => selectors.trim().split(',').some((item) => item.trim() === selector))
    .map(([, , body]) => body).join(';');
}

test('English UI loads Jakarta through the existing provider and inherits it in form controls', () => {
  const url = new URL(css.match(/@import url\('([^']+)'\)/)[1]);
  assert.equal(url.origin, 'https://fonts.googleapis.com');
  assert.deepEqual(url.searchParams.getAll('family'), [
    'Noto Sans Khmer:wght@400;500;600;700', 'Plus Jakarta Sans:wght@400..800',
  ]);
  assert.equal(url.searchParams.get('display'), 'swap');
  assert.match(declarations(':root'), /font-family:'Plus Jakarta Sans','Noto Sans Khmer',system-ui,sans-serif/);
  for (const selector of ['button', 'a', 'input', 'textarea', 'select']) {
    assert.match(declarations(selector), /font:inherit/);
  }
});

test('explicit font shorthands cannot reintroduce Inter anywhere in web source', () => {
  for (const name of fs.readdirSync(web, { recursive: true })) {
    if (!/\.(?:css|tsx?|html)$/.test(name)) continue;
    assert.doesNotMatch(fs.readFileSync(new URL(name, web), 'utf8'), /\bInter\b/, name);
  }
  for (const selector of ['.quality-dot', '.row-actions .micro', '.zoom-label', '.menu-micro', '.review-focus-label']) {
    assert.match(declarations(selector), /font:[^;]*'Plus Jakarta Sans',sans-serif/, selector);
  }
});

test('caption-content stacks stay Khmer-first while timing remains monospace', () => {
  for (const selector of ['.caption-row textarea', '.correction-pair p', '.find-preview p', '.diff-pair p', '.regen-comparison p', '.regen-comparison textarea', '.regen-candidates article p']) {
    assert.match(declarations(selector), /font(?:-family)?:[^;]*'Noto Sans Khmer','Plus Jakarta Sans',sans-serif/, selector);
  }
  assert.match(waveform, /ctx\.font = '11px "Noto Sans Khmer", "Plus Jakarta Sans", sans-serif'/);
  assert.match(declarations('.time-stack input'), /font:[^;]*ui-monospace,monospace/);
  assert.match(waveform, /ctx\.font = '11px ui-monospace, monospace'/);
});

test('operational type roles preserve readable controls, timecodes and caption sizing without root scaling', () => {
  assert.doesNotMatch(declarations(':root'), /font-size\s*:/);
  assert.match(declarations('.header-actions button'), /font-size:13px/);
  assert.match(declarations('.context-field textarea'), /font-size:13px/);
  assert.match(declarations('.modal-head strong'), /font-size:14px/);
  assert.match(declarations('.quality-dot'), /font:700 10px/);
  assert.match(declarations('.time-stack input'), /width:86px;font-size:11px/);
  assert.match(declarations('.caption-row textarea'), /font-size:15px;line-height:1\.7/);
  assert.match(css, /@media\(max-width:420px\)\{[\s\S]*?\.caption-row \.caption-text-cell\{grid-column:1\/-1;grid-row:2\}/);
});
