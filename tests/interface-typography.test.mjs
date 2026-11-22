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

test('Studio bundles variable interface fonts and form controls inherit Jakarta', () => {
  assert.match(css, /^@import '\.\/interface-fonts\.css';/);
  assert.doesNotMatch(css, /@import\s+(?:url\(\s*)?['"]?https?:\/\//i);
  const fontCss = fs.readFileSync(new URL('interface-fonts.css', web), 'utf8');
  const faces = [...fontCss.matchAll(/@font-face\s*\{([^{}]*)\}/g)].map(([, body]) => body);
  const expected = new Map([
    ['Plus Jakarta Sans', { pkg: 'plus-jakarta-sans', max: 800 }],
    ['Noto Sans Khmer', { pkg: 'noto-sans-khmer', max: 700 }],
  ]);
  const families = new Set();
  for (const face of faces) {
    const family = face.match(/font-family:\s*'([^']+)';/)?.[1];
    assert.ok(expected.has(family), `Unexpected family ${family}`);
    families.add(family);
    const { pkg, max } = expected.get(family);
    const range = face.match(/font-weight:\s*(\d+)\s+(\d+);/);
    assert.ok(range && Number(range[1]) <= 400 && Number(range[2]) >= max, family);
    assert.match(face, /font-display:\s*swap;/);
    const urls = [...face.matchAll(/url\(([^)]+)\)/g)].map(([, url]) => url);
    assert.ok(urls.length, family);
    for (const url of urls) {
      assert.match(url, new RegExp(`^'@fontsource-variable/${pkg}/files/[^/]+\\.woff2'$`));
    }
  }
  assert.deepEqual(families, new Set(expected.keys()));
  for (const entry of fs.readdirSync(web, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = `${entry.parentPath}/${entry.name}`;
    assert.doesNotMatch(fs.readFileSync(path, 'utf8'), /fonts\.(?:googleapis|gstatic)\.com/i, path);
  }
  const server = fs.readFileSync(new URL('../apps/server/src/index.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(server, /fonts\.(?:googleapis|gstatic)\.com/i);
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
  assert.match(declarations('.time-stack input'), /width:96px;font-size:13px/);
  assert.match(declarations('.caption-row textarea'), /font-size:15px;line-height:1\.7/);
  assert.match(css, /@media\(max-width:420px\)\{[\s\S]*?\.caption-row \.caption-text-cell\{grid-column:1\/-1;grid-row:2\}/);
});
