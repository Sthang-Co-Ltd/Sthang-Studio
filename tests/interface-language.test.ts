import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement, Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AppProfile, CaptionSegment } from '@kcs/shared';
import { createTranslator, translate, translatePlural } from '../apps/web/src/i18n/translate.js';
import { en } from '../apps/web/src/i18n/messages/en/index.js';
import { km } from '../apps/web/src/i18n/messages/km/index.js';
import { reconcileProfileAcknowledgement } from '../apps/web/src/profile-state.js';
import { analyzeCaptions, QA_PROFILES, type ReviewReasonCode } from '../apps/web/src/review.js';

test('messages interpolate named parameters and fall back to English for missing Khmer values', () => {
  assert.equal(translate('en', 'home.launcher.startupFailed', { services: 'Preferences, Projects' }),
    'Could not load: Preferences, Projects. Other tools remain available.');
  assert.equal(translate('en', 'home.launcher.projectCaptions'), '{count} captions');
  assert.equal(translate('km', 'home.upload.title'), km.home.upload.title);
  assert.equal(translate('km', 'home.launcher.projectCaptions', { count: 1234 }),
    km.home.launcher.projectCaptions.replace('{count}', '1234'));
  const fallback = createTranslator({ en, km: { home: { upload: { lead: 'localized fixture' } } } });
  assert.equal(fallback.translate('km', 'home.upload.title'), en.home.upload.title);
  assert.equal(fallback.translate('km', 'home.launcher.projectCaptions', { count: 1234 }), '1234 captions');
});

test('plural messages preserve English fallback grammar and accept a Khmer other form', () => {
  const fallback = createTranslator({ en, km: {} });
  for (const [count, english] of [[0, '0 captions'], [1, '1 caption'], [12, '12 captions']] as const) {
    assert.equal(translatePlural('en', 'editor.captions.count', count), english);
    assert.equal(fallback.translatePlural('km', 'editor.captions.count', count), english);
    assert.equal(translatePlural('km', 'editor.captions.count', count),
      km.editor.captions.count.other.replace('{count}', String(count)));
  }
  const fixture = createTranslator({ en, km: { editor: { captions: { count: { other: '{count} items (localized fixture)' } } } } });
  assert.equal(fixture.translatePlural('km', 'editor.captions.count', 1), '1 items (localized fixture)');
  assert.equal(fixture.translatePlural('km', 'editor.captions.count', 12), '12 items (localized fixture)');
});

test('rich messages render only allowed tags and escape parameters', () => {
  const { translateRich } = createTranslator({ en, km: { setup: { home: { other: '<b>{value}</b> <code>{value}</code> <em>literal</em>' } } } });
  const nodes = translateRich('km', 'setup.home.other', { value: '<b>typed</b>' }, {
    b: (text) => createElement('strong', null, text),
  });
  assert.equal(renderToStaticMarkup(createElement(Fragment, null, ...nodes)),
    '<strong>&lt;b&gt;typed&lt;/b&gt;</strong> <code>&lt;b&gt;typed&lt;/b&gt;</code> &lt;em&gt;literal&lt;/em&gt;');
});

test('every Review reason reproduces its English label and hint, including measurements and aliases', () => {
  const captions: CaptionSegment[] = [
    { id: 'empty', text: '', startMs: -50, endMs: 100, timingQuality: 'low' },
    { id: 'overlap', text: 'ខ្មែរ AI  cap cut\nsecond\nthird', startMs: 80, endMs: 320, timingQuality: 'medium' },
    { id: 'long', text: 'Duplicated text', startMs: 330, endMs: 7000 },
    { id: 'duplicate', text: 'Duplicated text', startMs: 7000, endMs: 8000 },
  ];
  const settings = { ...QA_PROFILES['khmer-tiktok-comfortable'], maxCharsPerLine: 6 };
  const reasons = analyzeCaptions(captions, ['CapCut | cap cut'], settings, 7500).flatMap((issue) => issue.reasons);
  const codes = new Set<ReviewReasonCode>();
  for (const { code, label, hint, params } of reasons) {
    codes.add(code);
    assert.equal(translate('en', `review.reason.${code}.label`, params), label, code);
    assert.equal(translate('en', `review.reason.${code}.hint`, params), hint, code);
  }
  assert.deepEqual([...codes].sort(), Object.keys(en.review.reason).sort());
  assert.equal(codes.size, 17);
});

test('language acknowledgements use the pre-request profile and preserve a concurrent waveform change', () => {
  const profile: AppProfile = {
    version: 1, defaultVocabulary: [], styles: [], topicPacks: [], correctionRules: [],
    correctionEvents: [], captionAppearances: [],
    preferences: { reviewPreRollMs: 100, reviewPostRollMs: 100, autoLoopReview: false, waveformZoom: 1 },
    updatedAt: '2026-11-22T00:00:00Z',
  };
  for (const [before, next] of [[undefined, 'en'], [undefined, 'km'], ['en', 'km'], ['km', 'en']] as const) {
    const basis = { ...profile, preferences: { ...profile.preferences, ...(before ? { interfaceLanguage: before } : {}) } };
    const current = { ...basis, preferences: { ...basis.preferences, waveformZoom: 3 } };
    const patch = { preferences: { interfaceLanguage: next } };
    const received = { ...basis, preferences: { ...basis.preferences, ...patch.preferences } };
    assert.deepEqual(reconcileProfileAcknowledgement(current, basis, received, patch).preferences,
      { ...profile.preferences, waveformZoom: 3, interfaceLanguage: next });
  }
});
