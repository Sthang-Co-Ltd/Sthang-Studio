import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const translatedKeyPattern = new RegExp(
  String.raw`\bcase\s+(?:t|tn|tr)\s*\(`
    + String.raw`|\bevent\s*\.\s*key\s*(?:===|!==)\s*(?:t|tn|tr)\s*\(`
    + String.raw`|\b(?:t|tn|tr)\s*\((?:[^()]|\([^()]*\))*\)\s*(?:===|!==)\s*event\s*\.\s*key\b`,
  'g',
);

function translatedKeyLines(source: string): number[] {
  return [...source.matchAll(translatedKeyPattern)].map(({ index }) => source.slice(0, index).split('\n').length);
}

test('translated labels never participate in a case label or physical key comparison', () => {
  const root = path.resolve('apps/web/src');
  const filenames = readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((name) => /\.tsx?$/.test(name) && name.split(path.sep)[0] !== 'i18n');
  assert.ok(filenames.length > 0);
  const violations = filenames.flatMap((name) =>
    translatedKeyLines(readFileSync(path.join(root, name), 'utf8')).map((line) => name + ':' + line));
  assert.deepEqual(violations, []);
});

test('the source guard detects translated comparisons in either order and translated case labels', () => {
  const source = [
    "if (event.key === 'End') {}",
    "if (event.key === t('timing.end')) {}",
    "if (event.key !== tn('timing.end', 2)) {}",
    "if (t('timing.end') === event.key) {}",
    "if (tn('timing.home', count()) !== event.key) {}",
    "switch (event.key) { case tr('timing.end', {}, {}): break; }",
    "switch (event.key) { case t('timing.end'): break; }",
    "switch (event.key) { case tn('timing.end', 1): break; }",
  ].join('\n');
  assert.deepEqual(translatedKeyLines(source), [2, 3, 4, 5, 6, 7, 8]);
});
