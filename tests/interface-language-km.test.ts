import assert from 'node:assert/strict';
import test from 'node:test';
import { en } from '../apps/web/src/i18n/messages/en/index.js';
import { km } from '../apps/web/src/i18n/messages/km/index.js';

type Catalog = { readonly [key: string]: string | Catalog };

function placeholders(text: string) {
  return [...new Set(text.match(/\{[a-zA-Z][a-zA-Z0-9_]*\}/g))].sort();
}

function checkCatalog(english: Catalog, khmer: Catalog, parent = '') {
  const plural = typeof english.one === 'string' && typeof english.other === 'string';
  for (const [key, source] of Object.entries(english)) {
    if (plural && key === 'one' && !Object.hasOwn(khmer, key)) continue;
    const path = `${parent}${key}`;
    const translation = khmer[key];
    if (typeof source !== 'string') {
      assert.ok(translation && typeof translation === 'object', `Missing section ${path}`);
      checkCatalog(source, translation, `${path}.`);
      continue;
    }
    test(path, () => {
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

checkCatalog(en, km);
