import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { planReplacement } from '../apps/web/src/find-replace.js';
import { translate, translatePlural, translateRich } from '../apps/web/src/i18n/translate.js';
import type { MessageKey } from '../apps/web/src/i18n/types.js';

test('B3 English catalog reproduces representative project tool copy', () => {
  const strings: [MessageKey, string][] = [
    ['accuracy.explicitModelHelp', 'For this project only. Uses only this model for new caption generation and regeneration. Global settings stay unchanged.'],
    ['details.alignmentActive', 'KFA Khmer alignment active'],
    ['grouping.phraseDescription', 'Natural short phrases'],
    ['activity.openingSavedResult', 'Opening saved result… Close Activity to cancel.'],
    ['history.help', 'Checkpoints saved before edits, regeneration, and timing changes'],
    ['find.help', 'Preview every occurrence. Locked text stays unchanged.'],
    ['inbox.rememberGlobal', 'Remember for all projects'],
    ['updates.help', 'Signed releases. You choose when to install.'],
    ['guide.inboxHelp', 'Learns from edits after you approve each suggestion.'],
    ['library.loadFailedHelp', 'Your saved projects have not been changed. Try loading the list again.'],
  ];
  for (const [key, original] of strings) assert.equal(translate('en', key), original, key);
  assert.equal(translate('en', 'accuracy.termCount', { count: 1 }), '1 terms');
  assert.equal(translatePlural('en', 'history.savedVersions', 1), '1 saved version');
  assert.equal(translatePlural('en', 'history.savedVersions', 2), '2 saved versions');
  assert.equal(translatePlural('en', 'find.updatedWithLockedMatches', 1, { locked: 2 }), 'Updated 1 caption; 2 locked matches preserved.');
  assert.equal(translatePlural('en', 'library.captions', 1), '1 caption');
  assert.equal(translatePlural('en', 'library.projectCount', 2), '2 projects');
  assert.equal(translate('en', 'activity.progressStatus', { progress: 75, status: 'Working' }), '75% · Working');
  assert.equal(translate('en', 'inbox.reportContext', { before: '', text: 'កម្ពុជា', after: 'OK' }), 'Context: …  [កម្ពុជា] OK …');
  assert.equal(translate('en', 'updates.installedVersion', { version: '0.90.0' }), 'Installed version 0.90.0');
  assert.equal(renderToStaticMarkup(translateRich('en', 'accuracy.aliasesHelp', {}, {})),
    'One term per line. Aliases use <code>Canonical | alias | phonetic alias</code>.');
  assert.equal(renderToStaticMarkup(translateRich('en', 'grouping.targetMaxCharacters', { count: 23 }, {})),
    'Target maximum characters <b>23</b>');
});

test('replacement planning keeps its original English diagnostic alongside its catalog key', () => {
  for (const pattern of ['[', '(']) {
    const plan = planReplacement([], pattern, '', 'regex');
    assert.equal(plan.error, 'Invalid regular expression. Check the Find pattern.');
    assert.ok(plan.errorKey);
    assert.equal(translate('en', plan.errorKey), plan.error);
  }
  assert.equal(planReplacement([], '[', '', 'literal').error, '');
});

test('Details compatibility and grouping keys preserve the legacy English variants', () => {
  const cases: [MessageKey, number, string][] = [
    ['details.compatibilityTermsOnly', 0, 'Protected terms were used as recognition hints'],
    ['details.compatibilityTermsAndHint', 1, 'Protected terms and 1 selected name/model hint from your Accuracy context were used as recognition hints'],
    ['details.compatibilityTermsAndHints', 2, 'Protected terms and 2 selected name/model hints from your Accuracy context were used as recognition hints'],
    ['details.compatibilityHint', 1, '1 selected name/model hint from your Accuracy context was used for recognition'],
    ['details.compatibilityHints', 2, '2 selected name/model hints from your Accuracy context were used for recognition'],
  ];
  for (const [key, count, sources] of cases) {
    assert.equal(translate('en', key, { count }),
      'Studio used compatibility transcription. ' + sources + ', but the full topic description was not available to Transcribe. Review ambiguous names.');
  }
  assert.equal(translate('en', 'details.compatibilityAudioOnly'),
    'Studio used compatibility transcription without Accuracy recognition hints. Review ambiguous names.');
  assert.equal(translate('en', 'details.modelsWithFallbackAndDevice', { textModel: 'Gemini', timingModel: 'KFA', device: 'cpu' }),
    'Text: Gemini (fallback) · Timing: KFA · cpu');
  for (const [key, label, descKey, description] of [
    ['grouping.dynamic', 'Dynamic', 'grouping.dynamicDescription', 'Fast TikTok rhythm'],
    ['grouping.word', 'Word', 'grouping.wordDescription', 'One word at a time'],
    ['grouping.phrase', 'Phrase', 'grouping.phraseDescription', 'Natural short phrases'],
    ['grouping.line', 'Line', 'grouping.lineDescription', 'Longer single-line groups'],
  ] as const) {
    assert.equal(translate('en', key), label);
    assert.equal(translate('en', descKey), description);
    assert.equal(translate('en', 'grouping.currentGrouping', { mode: label }),
      'Current grouping: ' + label + '. Locked captions stay as they are. History keeps the previous version.');
  }
});
