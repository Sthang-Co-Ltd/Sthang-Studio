import assert from 'node:assert/strict';
import test from 'node:test';
import { CAPTION_LOOKS } from '@kcs/shared';
import { createElement, Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { en } from '../apps/web/src/i18n/messages/en/index.js';
import { km } from '../apps/web/src/i18n/messages/km/index.js';
import { createTranslator, translate, translatePlural, translateRich } from '../apps/web/src/i18n/translate.js';

test('Appearance keeps its save, font import, and preset copy', () => {
  assert.equal(translate('en', 'appearance.workspace.saveState.saved'), 'Saved automatically');
  assert.equal(translate('en', 'appearance.workspace.presetSaved', { name: 'Clean Khmer' }), 'Saved “Clean Khmer”.');
  assert.equal(
    translatePlural('en', 'appearance.workspace.fontAddedSelected', 1, { font: 'Khmer UI' }),
    'Added “Khmer UI”. Khmer UI is selected.',
  );
  assert.equal(
    translatePlural('en', 'appearance.workspace.fontAddedRegular', 2, { font: 'Khmer UI' }),
    'Added 2 Khmer font families. Khmer UI is selected. No Bold face; using Regular. Other settings are unchanged.',
  );
});

test('Looks keeps its English cards and the current look emphasis', () => {
  for (const look of CAPTION_LOOKS) {
    assert.equal(translate('en', `appearance.looks.description.${look.id}`), look.description);
  }
  const current = translateRich('en', 'appearance.looks.current', { look: 'Bold Outline' }, {});
  assert.equal(renderToStaticMarkup(createElement(Fragment, null, current)), 'Current look <b>Bold Outline</b>');
});

test('Appearance range keeps exact values, punctuation, and units', () => {
  assert.equal(translate('en', 'appearance.range.slider', { label: 'Glow width' }), 'Glow width slider');
  assert.equal(
    translate('en', 'appearance.range.rounded', { value: 3.5, unit: ' px', step: 0.5 }),
    'Rounded to 3.5 px: nearest 0.5 px step.',
  );
  assert.equal(
    translate('en', 'appearance.range.resetTitle', { label: 'position', value: 13, unit: ' %' }),
    'Reset position to 13 % (Studio default)',
  );
});

test('Font search keeps its count and result descriptions', () => {
  assert.equal(
    translate('en', 'appearance.fontSearch.placeholder', { count: 27 }),
    'Find among 27 installed Khmer fonts…',
  );
  assert.equal(translate('en', 'appearance.fontSearch.addedRegular'), 'Added to Studio · Regular only');
});

test('Word highlight preparation keeps progress and coverage in English', () => {
  assert.equal(translate('en', 'appearance.highlight.checking', { completed: 2, total: 3 }), 'Checking captions… 2 of 3');
  assert.equal(translatePlural('en', 'appearance.highlight.coverageIndividual', 1), 'Highlighting 1 caption');
  assert.equal(translatePlural('en', 'appearance.highlight.coverageIndividual', 2), 'Highlighting 2 captions');
  assert.equal(translatePlural('km', 'appearance.highlight.coverageIndividual', 1),
    km.appearance.highlight.coverageIndividual.other.replace('{count}', '1'));
  const fallback = createTranslator({ en, km: { appearance: { highlight: {} } } });
  assert.equal(fallback.translatePlural('km', 'appearance.highlight.coverageIndividual', 1), 'Highlighting 1 caption');
});

test('Waveform editing keeps its edge labels and fixed-precision duration', () => {
  assert.equal(translate('en', 'timing.waveform.edge.start.earlier', { step: 50 }), 'Move start earlier by 50 milliseconds');
  assert.equal(translate('en', 'timing.waveform.edge.end.field'), 'Fine timing end');
  assert.equal(translate('en', 'timing.waveform.duration', { seconds: '0.800' }), 'Duration 0.800 s');
});

test('Word timing keeps caption text and the repair time range', () => {
  assert.equal(translate('en', 'timing.words.numberGroup', { number: 2, text: 'កម្ពុជា' }), 'Word group 2: កម្ពុជា');
  const range = { start: '00:00.200', end: '00:01.000' };
  assert.equal(
    translatePlural('en', 'timing.words.suggestionRange', 1, range),
    'This caption will run from 00:00.200 to 00:01.000. Applying clears Review approval on this caption.',
  );
  assert.equal(
    translatePlural('en', 'timing.words.suggestionRange', 3, range),
    'This caption will run from 00:00.200 to 00:01.000. Applying clears Review approval on 3 captions.',
  );
});
