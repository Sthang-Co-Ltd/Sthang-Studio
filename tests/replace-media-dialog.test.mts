import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// UI CSS belongs to Vite; this smoke suite checks the actual React markup.
registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
  return nextLoad(url, context);
} });
(globalThis as unknown as { React: typeof React }).React = React;
const { ReplaceMediaDialog, RestoreMediaDialog } = await import('../apps/web/src/components/ReplaceMediaDialog.js');
const noop = () => {};
const replace = (extra = {}) => renderToStaticMarkup(React.createElement(ReplaceMediaDialog, {
  filename: 'new-visual-edit.mp4', captionCount: 18, working: '', error: '', onCancel: noop, onModeChange: noop, onReplace: noop, ...extra,
}));
const restore = (extra = {}) => renderToStaticMarkup(React.createElement(RestoreMediaDialog, {
  checkpoints: [], loading: false, working: '', error: '', onCancel: noop, onReload: noop, onRestore: noop, onDelete: noop, ...extra,
}));
const input = (html: string, value: string) => [...html.matchAll(/<input\b[^>]*>/g)].map((match) => match[0]).find((tag) => tag.includes(`value="${value}"`))!;
const button = (html: string, label: string) => [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map((match) => match[0]).find((tag) => tag.endsWith(`>${label}</button>`))!;

test('replacement starts in preserve mode with ordinary verification and no advance audio override', () => {
  const html = replace();
  assert.match(input(html, 'preserve'), /checked=""/);
  assert.doesNotMatch(input(html, 'reset'), /checked=/);
  assert.doesNotMatch(html, /type="checkbox"/);
  assert.doesNotMatch(button(html, 'Replace and keep captions'), /disabled=/);
  assert.doesNotMatch(button(html, 'Cancel'), /disabled=/);
  assert.match(html, /Studio checks the new audio first/);
  assert.match(html, /No captions are generated automatically/);
  assert.match(html, /role="dialog"[^>]*aria-modal="true"[^>]*aria-labelledby="replace-media-title"/);
});

test('only a supplied audio mismatch confirmation reveals an unchecked honest timing warning', () => {
  const html = replace({ preserveAudioConfirmation: { token: 'opaque-selected-file-and-revision', expiresAt: '2099-01-01T00:00:00.000Z' } });
  assert.match(html, /Keep old timing with different audio\?/);
  assert.match(html, /Caption and word times will stay unchanged/);
  assert.match(html, /You must check their alignment against the new audio/);
  assert.match(html, /I accept the existing times and will check their alignment\./);
  const checkbox = [...html.matchAll(/<input\b[^>]*>/g)].map((match) => match[0]).find((tag) => tag.includes('type="checkbox"'))!;
  assert.ok(checkbox);
  assert.doesNotMatch(checkbox, /checked=/);
  assert.match(button(html, 'Replace and keep existing times'), /disabled=""/);
  assert.equal(button(html, 'Replace and clear captions'), undefined);
  assert.doesNotMatch(html, /audio.{0,15}(?:verified|unchanged)|alignment.{0,15}verified/i);
});

test('an expired audio confirmation requires checking again instead of accepting a stale warning', () => {
  const html = replace({ preserveAudioConfirmation: { token: 'expired', expiresAt: '2020-01-01T00:00:00.000Z' } });
  assert.doesNotMatch(html, /type="checkbox"/);
  assert.doesNotMatch(button(html, 'Check replacement again'), /disabled=/);
  assert.equal(button(html, 'Replace and keep existing times'), undefined);
});

test('pending replacement disables its form and cancel without pretending the request was cancelled', () => {
  const html = replace({ working: 'Checking audio locally…' });
  assert.match(html, /<fieldset disabled=""/);
  assert.match(button(html, 'Cancel'), /disabled=""/);
  assert.match(button(html, 'Replace and keep captions'), /disabled=""/);
  assert.match(html, /aria-label="Cancel media replacement" disabled=""/);
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /role="status"/);
  assert.match(html, /Stay on this page until the result is confirmed/);
});

test('compatibility rejection remains visible and cannot select reset as a fallback', () => {
  const html = replace({ error: 'The audio differs. This media change was not applied.' });
  assert.match(html, /role="alert">The audio differs/);
  assert.match(input(html, 'preserve'), /checked=""/);
  assert.doesNotMatch(input(html, 'reset'), /checked=/);
  assert.doesNotMatch(html, /<button[^>]*>Replace and clear captions/);
  assert.doesNotMatch(html, /type="checkbox"/);
  assert.equal(button(html, 'Replace and keep existing times'), undefined);
});

test('source filenames and server error text are escaped rather than interpreted', () => {
  const html = replace({ filename: '<img src=x onerror=run()>.mp4', error: '<script>run()</script>' });
  assert.match(html, /&lt;img/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<img|<script/);
});

test('empty and loading recovery states cannot restore or delete an arbitrary backup', () => {
  const empty = restore();
  assert.match(empty, /No replacement backups yet/);
  assert.match(button(empty, 'Restore selected backup'), /disabled=""/);
  assert.equal(button(empty, 'Delete backup'), undefined);
  const loading = restore({ loading: true });
  assert.match(loading, /Loading backups/);
  assert.match(button(loading, 'Restore selected backup'), /disabled=""/);
});

test('recovery offers explicit restore and delete actions and communicates the whole-project scope', () => {
  const html = restore({ checkpoints: [{ id: 'backup-1', mode: 'preserve', createdAt: '2026-10-15T00:00:00Z', previousOriginalName: 'original & reviewed.mp4', retainedBytes: 1024 * 1024 }] });
  assert.match(html, /original &amp; reviewed\.mp4/);
  assert.match(html, /1\.0 MB/);
  assert.match(html, /name="replacement-backup" checked=""/);
  assert.doesNotMatch(button(html, 'Restore selected backup'), /disabled=/);
  assert.doesNotMatch(button(html, 'Delete backup'), /disabled=/);
  assert.match(html, /captions, approvals, timing, and appearance/);
  assert.match(html, /current saved project becomes another backup/);
  assert.match(html, /Studio keeps up to five local backups/);
});

test('a pending restore blocks both deletion and closing while keeping progress visible', () => {
  const html = restore({ working: 'Restoring previous media…', checkpoints: [{ id: 'backup-1', mode: 'restore', createdAt: '2026-10-15T00:00:00Z', previousOriginalName: 'reviewed.mp4' }] });
  for (const label of ['Close', 'Delete backup', 'Restore selected backup']) assert.match(button(html, label), /disabled=""/);
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /role="status"/);
});
