import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';

const comparisons = new Set([
  ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken,
]);
const translators = new Set(['t', 'tn', 'tr']);

function anyNode(node: ts.Node, predicate: (item: ts.Node) => boolean): boolean {
  return predicate(node) || ts.forEachChild(node, (child) => anyNode(child, predicate) || undefined) === true;
}

function translatedComparisons(source: ts.SourceFile) {
  const offenses: string[] = [];
  const hasTranslation = (node: ts.Node) => anyNode(node, (item) => {
    if (!ts.isCallExpression(item)) return false;
    const target = item.expression;
    return ts.isIdentifier(target) ? translators.has(target.text)
      : ts.isPropertyAccessExpression(target) && translators.has(target.name.text);
  });
  const hasKey = (node: ts.Node) => anyNode(node, (item) =>
    ts.isPropertyAccessExpression(item) && item.name.text === 'key'
    || ts.isElementAccessExpression(item) && ts.isStringLiteral(item.argumentExpression) && item.argumentExpression.text === 'key');

  function visit(node: ts.Node) {
    if (ts.isCaseClause(node) && hasTranslation(node.expression)
      || ts.isBinaryExpression(node) && comparisons.has(node.operatorToken.kind)
        && (hasKey(node.left) && hasTranslation(node.right) || hasKey(node.right) && hasTranslation(node.left))) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      offenses.push(`${source.fileName}:${line + 1}`);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return offenses;
}

test('translated labels never participate in a case label or physical key comparison', () => {
  const root = path.resolve('apps/web/src');
  const filenames = readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((name) => /\.[cm]?[jt]sx?$/.test(name));
  assert.ok(filenames.length > 0);
  const violations = filenames.flatMap((name) => translatedComparisons(ts.createSourceFile(
    name, readFileSync(path.join(root, name), 'utf8'), ts.ScriptTarget.Latest,
  )));
  assert.deepEqual(violations, []);
});

test('the source guard detects translated comparisons in either order and translated case labels', () => {
  const source = ts.createSourceFile('example.ts', [
    "if (event.key === 'End') {}",
    "if (event.key === t('timing.end')) {}",
    "if (tn('timing.home', 1) !== event['key']) {}",
    "switch (event.key) { case tr('timing.end', {}, {}): break; }",
  ].join('\n'), ts.ScriptTarget.Latest);
  assert.deepEqual(translatedComparisons(source), ['example.ts:2', 'example.ts:3', 'example.ts:4']);
});
