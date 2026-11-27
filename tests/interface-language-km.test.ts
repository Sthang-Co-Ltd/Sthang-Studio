import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { type TestContext } from 'node:test';
import { en } from '../apps/web/src/i18n/messages/en/index.js';
import { km } from '../apps/web/src/i18n/messages/km/index.js';
import { pendingKhmerNamespaces } from '../apps/web/src/i18n/pending.js';
import { khmerKeyboardTokens, pendingEnglishValues } from './khmer-catalog-coverage.js';

type Catalog = { readonly [key: string]: string | Catalog };
type PartialCatalog = { readonly [key: string]: string | PartialCatalog | undefined };

function placeholders(text: string) {
  return [...new Set(text.match(/\{[a-zA-Z][a-zA-Z0-9_]*\}/g))].sort();
}

async function checkCatalog(t: TestContext, english: Catalog, khmer: PartialCatalog, parent: string) {
  const plural = typeof english.one === 'string' && typeof english.other === 'string';
  for (const [key, source] of Object.entries(english)) {
    if (plural && key === 'one' && !Object.hasOwn(khmer, key)) continue;
    const path = `${parent}${key}`;
    const translation = khmer[key];
    if (typeof source !== 'string') {
      assert.ok(translation && typeof translation === 'object', `Missing section ${path}`);
      await checkCatalog(t, source, translation, `${path}.`);
      continue;
    }
    await t.test(path, () => {
      assert.ok(typeof translation === 'string' && translation.trim(), 'Missing Khmer value');
      assert.deepEqual(placeholders(translation), placeholders(source), 'Placeholders');
      assert.deepEqual(translation.match(/<\/?(?:b|code)>/g), source.match(/<\/?(?:b|code)>/g), 'Rich tag sequence');
      assert.deepEqual(translation.match(/<code>[\s\S]*?<\/code>/g), source.match(/<code>[\s\S]*?<\/code>/g), 'Code contents');
      assert.doesNotMatch(translation, /[០-៩]/u, 'Use Western digits');
      if (!/[.?!]$/u.test(source.trimEnd())) assert.doesNotMatch(translation.trimEnd(), /។$/u, 'Unexpected sentence ending');
      assert.doesNotMatch(translation, /ម្តង|ប្តូរ|ចាប់ផ្តើម|សេចក្តី|ផ្តល់|ស្តាប់|ផ្តោត/u, 'Use the reviewed spelling');
      assert.doesNotMatch(translation, /\u200b/u, 'Unexpected zero-width space');
    });
  }
}

test('every pending Khmer namespace exists in the English catalog', () => {
  for (const namespace of pendingKhmerNamespaces) {
    assert.ok(Object.hasOwn(en, namespace), `Missing English namespace ${namespace}`);
  }
});

test('the pending allowlist contains complete English values only and disappears when all namespaces are translated', () => {
  const pending = pendingEnglishValues();
  if (pendingKhmerNamespaces.some((namespace: keyof typeof en) => namespace === 'workspace')) {
    assert.ok(pending.has(en.workspace.close));
    assert.ok(!pending.has('Close'));
  }
  assert.deepEqual(pendingEnglishValues([]), new Set());
});

test('coverage keyboard tokens match the glossary, plus F for Ctrl+F and Command+F', () => {
  const glossary = readFileSync('docs/KHMER-UI-GLOSSARY.md', 'utf8');
  const keyboardRule = glossary.split(/\r?\n/).find((line) => line.includes('Keyboard keys and symbols:'));
  assert.ok(keyboardRule, 'The glossary lists the keyboard keys and symbols');
  const glossaryKeys = [...keyboardRule.matchAll(/`([A-Za-z]+)`/g)].map(([, key]) => key);
  assert.deepEqual([...khmerKeyboardTokens], [...glossaryKeys, 'F']);
});

test('every non-pending English namespace has a complete Khmer catalog', async (t) => {
  const pending = new Set<string>(pendingKhmerNamespaces);
  const khmer: PartialCatalog = km;
  for (const [namespace, source] of Object.entries(en)) {
    if (pending.has(namespace)) continue;
    const translation = khmer[namespace];
    assert.ok(translation && typeof translation === 'object', `Missing section ${namespace}`);
    await checkCatalog(t, source, translation, `${namespace}.`);
  }
});
