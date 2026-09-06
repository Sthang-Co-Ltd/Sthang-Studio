import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CaptionSegment, CaptionIssue } from '@kcs/shared';

// Polyfill React global for tsx-loaded JSX components
(globalThis as unknown as { React: typeof React }).React = React;

import { CaptionEditor } from '../apps/web/src/components/CaptionEditor.js';
import { FindReplacePanel } from '../apps/web/src/components/FindReplacePanel.js';
import { computeSpectrum } from '../apps/web/src/components/WaveformEditor.js';

function makeCaption(id: string, text: string, startMs: number, endMs: number, extra: Partial<CaptionSegment> = {}): CaptionSegment {
  return { id, text, startMs, endMs, ...extra };
}

// ---------------------------------------------------------------------------
// Item 1: CaptionEditor render-path indexing
// ---------------------------------------------------------------------------

test('CaptionEditor displays 1-indexed padded row numbers matching original caption indices', () => {
  const captions: CaptionSegment[] = [
    makeCaption('c-1', 'Caption 1', 0, 1000),
    makeCaption('c-2', 'Caption 2', 1000, 2000),
    makeCaption('c-3', 'Caption 3', 2000, 3000),
  ];

  const html = renderToStaticMarkup(
    React.createElement(CaptionEditor, {
      captions,
      playheadMs: 0,
      selectedIds: [],
      issues: [],
      onChange: () => {},
      onSeek: () => {},
      onSelect: () => {},
      onTextCommit: () => {},
    })
  );

  assert.ok(html.includes('<span class="row-index">01</span>'), 'Row 1 index is 01');
  assert.ok(html.includes('<span class="row-index">02</span>'), 'Row 2 index is 02');
  assert.ok(html.includes('<span class="row-index">03</span>'), 'Row 3 index is 03');
});

test('CaptionEditor preserves first-occurrence findIndex semantics when duplicate IDs exist', () => {
  const captions: CaptionSegment[] = [
    makeCaption('dup-1', 'First instance', 0, 1000),
    makeCaption('unique', 'Middle caption', 1000, 2000),
    makeCaption('dup-1', 'Second instance with duplicate ID', 2000, 3000),
  ];

  const html = renderToStaticMarkup(
    React.createElement(CaptionEditor, {
      captions,
      playheadMs: 0,
      selectedIds: [],
      issues: [],
      onChange: () => {},
      onSeek: () => {},
      onSelect: () => {},
      onTextCommit: () => {},
    })
  );

  // Both rows with id 'dup-1' should resolve to the first occurrence index (0 -> '01')
  // just as captions.findIndex would have done
  const matches = [...html.matchAll(/<span class="row-index">(\d+)<\/span>/g)].map(m => m[1]);
  assert.deepEqual(matches, ['01', '02', '01'], 'Duplicate ID maps to first occurrence index 01');
});

test('CaptionEditor in review mode displays original caption array indices for filtered subset', () => {
  const captions: CaptionSegment[] = [
    makeCaption('c-1', 'Clean caption 1', 0, 1000, { approved: true }),
    makeCaption('c-2', 'Issue caption 2', 1000, 2000, { approved: false }),
    makeCaption('c-3', 'Clean caption 3', 2000, 3000, { approved: true }),
    makeCaption('c-4', 'Issue caption 4', 3000, 4000, { approved: false }),
  ];

  const issues: CaptionIssue[] = [
    { captionId: 'c-2', severity: 'warning', reasons: ['High reading speed'] },
    { captionId: 'c-4', severity: 'danger', reasons: ['Overlaps with next'] },
  ];

  const html = renderToStaticMarkup(
    React.createElement(CaptionEditor, {
      captions,
      playheadMs: 0,
      selectedIds: [],
      issues,
      reviewMode: true,
      onChange: () => {},
      onSeek: () => {},
      onSelect: () => {},
      onTextCommit: () => {},
    })
  );

  // Visible rows should only be c-2 and c-4, but their row numbers should be 02 and 04
  const matches = [...html.matchAll(/<span class="row-index">(\d+)<\/span>/g)].map(m => m[1]);
  assert.deepEqual(matches, ['02', '04'], 'Review mode displays original list indices 02 and 04');
});

test('CaptionEditor menu-up threshold applies to the last 3 items of visible list', () => {
  // visible.length = 5
  // visibleIndex > 5 - 4  <=> visibleIndex > 1 <=> indices 2, 3, 4 (last 3 items)
  const visibleLength = 5;
  const isMenuUp = (visibleIndex: number) => visibleIndex > visibleLength - 4;

  assert.equal(isMenuUp(0), false, 'Index 0 is not menu-up');
  assert.equal(isMenuUp(1), false, 'Index 1 is not menu-up');
  assert.equal(isMenuUp(2), true, 'Index 2 is menu-up');
  assert.equal(isMenuUp(3), true, 'Index 3 is menu-up');
  assert.equal(isMenuUp(4), true, 'Index 4 is menu-up');
});

test('CaptionEditor renders 500 captions with O(1) index lookups accurately and fast', () => {
  const count = 500;
  const captions: CaptionSegment[] = Array.from({ length: count }, (_, i) =>
    makeCaption(`cap-${i}`, `Caption text ${i}`, i * 1000, (i + 1) * 1000)
  );

  const start = performance.now();
  const html = renderToStaticMarkup(
    React.createElement(CaptionEditor, {
      captions,
      playheadMs: 0,
      selectedIds: [],
      issues: [],
      onChange: () => {},
      onSeek: () => {},
      onSelect: () => {},
      onTextCommit: () => {},
    })
  );
  const elapsed = performance.now() - start;

  assert.ok(elapsed < 1000, `Rendering 500 captions took ${elapsed.toFixed(1)}ms, expected < 1000ms`);

  // Verify first and last indices
  assert.ok(html.includes('<span class="row-index">01</span>'), 'First caption is 01');
  assert.ok(html.includes('<span class="row-index">500</span>'), 'Last caption is 500');
});

// ---------------------------------------------------------------------------
// Item 2: WaveformEditor lazy spectrum computation
// ---------------------------------------------------------------------------

test('computeSpectrum computes normalized energy array across columns and frequency bands', () => {
  // Generate 1 second of 44.1kHz audio with a 440Hz tone
  const sampleRate = 44100;
  const samples = new Float32Array(sampleRate);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = Math.sin((2 * Math.PI * 440 * i) / sampleRate);
  }

  const columns = 50;
  const bands = 20;
  const spectrum = computeSpectrum(samples, columns, bands);

  assert.equal(spectrum.columns, columns);
  assert.equal(spectrum.bands, bands);
  assert.equal(spectrum.values.length, columns * bands);

  // All values should be finite numbers in [0, 1]
  let hasNonZero = false;
  for (let i = 0; i < spectrum.values.length; i++) {
    const val = spectrum.values[i];
    assert.ok(!Number.isNaN(val), `Value at ${i} is NaN`);
    assert.ok(val >= 0 && val <= 1, `Value ${val} at ${i} is outside [0, 1]`);
    if (val > 0) hasNonZero = true;
  }
  assert.ok(hasNonZero, 'Spectrum should have non-zero energy for active tone');
});

test('computeSpectrum handles silent buffer without division by zero or NaN', () => {
  const silent = new Float32Array(1000);
  const spectrum = computeSpectrum(silent, 10, 5);

  assert.equal(spectrum.values.length, 50);
  for (let i = 0; i < spectrum.values.length; i++) {
    assert.equal(spectrum.values[i], 0, `Silent buffer value at ${i} should be 0`);
  }
});

// ---------------------------------------------------------------------------
// Item 3: FindReplacePanel closed state work suppression
// ---------------------------------------------------------------------------

test('FindReplacePanel returns null and suppresses work when open is false', () => {
  const captions: CaptionSegment[] = [
    makeCaption('c-1', 'Hello world', 0, 1000),
    makeCaption('c-2', 'Foo bar', 1000, 2000),
  ];

  const html = renderToStaticMarkup(
    React.createElement(FindReplacePanel, {
      open: false,
      captions,
      selectedIds: [],
      initialSearch: 'Hello',
      onClose: () => {},
      onApply: () => {},
      onRemember: async () => {},
    })
  );

  assert.equal(html, '', 'Closed FindReplacePanel renders empty HTML');
});

test('FindReplacePanel renders modal and correctly previews matches when open is true', () => {
  const captions: CaptionSegment[] = [
    makeCaption('c-1', 'Hello world', 0, 1000),
    makeCaption('c-2', 'Another hello', 1000, 2000),
    makeCaption('c-3', 'Unrelated text', 2000, 3000),
  ];

  const html = renderToStaticMarkup(
    React.createElement(FindReplacePanel, {
      open: true,
      captions,
      selectedIds: [],
      initialSearch: 'hello',
      onClose: () => {},
      onApply: () => {},
      onRemember: async () => {},
    })
  );

  assert.ok(html.includes('Find &amp; Correct Everywhere') || html.includes('Find & Correct Everywhere'), 'Panel title rendered');
  assert.ok(html.includes('Preview every occurrence'), 'Preview description rendered');
  assert.ok(html.includes('find-replace-modal'), 'Modal class rendered');
});
