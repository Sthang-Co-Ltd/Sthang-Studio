import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement, Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DEFAULT_CAPTION_APPEARANCE, type CaptionSegment } from '../packages/shared/src/index.js';
import { buildExportCaptionIssues } from '../apps/web/src/export-checks.js';
import { translate, translatePlural, translateRich } from '../apps/web/src/i18n/translate.js';
import { analyzeCaptions } from '../apps/web/src/review.js';

test('Export video controls and dynamic copy match the existing English', () => {
  assert.equal(translate('en', 'export.workspace.videoOutput'), 'MP4 · keeps styling');
  assert.equal(translate('en', 'export.workspace.matchSourceFrameRate', { rate: '29.97' }), 'Match source (29.97 fps)');
  assert.equal(translate('en', 'export.workspace.resolutionUpscaled', { label: 'HD', width: 1280, height: 720 }),
    'HD · 1280×720 · Upscaled');
  assert.equal(translate('en', 'export.workspace.elapsedHours', { hours: 1, minutes: 2 }), '1h 2m elapsed');
  assert.equal(translate('en', 'export.workspace.presetUpdated', { name: 'Vertical' }), 'Updated video preset “Vertical”.');
  assert.equal(translate('en', 'export.workspace.progressComplete', { progress: 45 }), '45% complete');
  assert.equal(renderToStaticMarkup(createElement(Fragment, null, ...translateRich('en', 'export.workspace.diskSummary',
    { estimate: '38 MB', free: '1.2 GB' }, {}))), '≈ <b>38 MB</b> · 1.2 GB free');
  assert.equal(translatePlural('en', 'export.workspace.highlightPlain', 1),
    'Word highlights appear in captioned video. 1 caption will remain plain because word timing needs review.');
});

test('Caption handoff and restore retain English guidance, options and number agreement', () => {
  assert.equal(translate('en', 'export.handoff.srtStyle'), 'Text and timing only. Set visual styling in the destination editor.');
  assert.equal(translate('en', 'export.destinations.capcut-desktop.step2'),
    'In CapCut Desktop, use Captions → Add Captions to import it.');
  assert.equal(translate('en', 'export.formats.word-vtt.label'), 'One word per caption (VTT)');
  assert.equal(translate('en', 'export.handoff.started', { format: 'SRT' }), 'SRT download started.');
  assert.equal(translatePlural('en', 'export.handoff.wordReadiness', 2, { ready: 1 }),
    '1 of 2 captions with text ready for word-timed export.');
  assert.equal(translatePlural('en', 'export.handoff.needWordReview', 1), '1 caption need word timing review');
  assert.equal(translate('en', 'export.restore.title'), 'Review caption import');
  assert.equal(translatePlural('en', 'export.restore.replaceSummary', 1, { incoming: 4 }),
    'Replace 1 current caption with 4 from this file. Your video, audio, and appearance stay unchanged.');
  assert.equal(translate('en', 'export.restore.moreCaptions', { count: 1 }), '1 more captions not shown.');
});

test('Export checks preserve English findings, repair instructions and paging', () => {
  assert.equal(translate('en', 'export.checks.goToCaption', { position: 3 }), 'Go to caption 3');
  assert.equal(translate('en', 'export.checks.pageRange', { start: 9, end: 16, total: 17 }), '9–16 of 17');
  assert.equal(translate('en', 'export.checks.countsWithSuggestions', {
    blockers: translatePlural('en', 'export.checks.blockerCount', 1),
    suggestions: translatePlural('en', 'export.checks.suggestionCount', 2),
  }), '1 blocker · 2 review suggestions.');
  const captions: CaptionSegment[] = [
    { id: 'first', text: 'Earlier caption', startMs: 0, endMs: 1500 },
    { id: 'second', text: 'Later caption', startMs: 1000, endMs: 2000, timingQuality: 'low' },
    { id: 'empty', text: '', startMs: 2200, endMs: 3600 },
  ];
  const findings = buildExportCaptionIssues({
    captions, reviewIssues: analyzeCaptions(captions, []), format: 'word-srt', appearance: DEFAULT_CAPTION_APPEARANCE,
  });
  const overlap = findings.find((issue) => issue.id.startsWith('overlap:'));
  assert.equal(overlap?.title, 'Overlapping captions');
  assert.deepEqual(overlap?.reasons, ['These captions overlap in the source timeline. Some destination editors cannot keep overlapping cues.']);
  assert.ok(findings.some((issue) => issue.title === 'Caption has no text'));
  assert.ok(findings.some((issue) => issue.reasons.includes('Word-timed download requires usable timing for every caption.')));
  assert.ok(findings.some((issue) => issue.id.startsWith('review:') && issue.titleMessage));
  for (const { title, titleMessage, reasons, reasonMessages, remedy, remedyMessage } of findings) {
    if (titleMessage) assert.equal(translate('en', titleMessage.key, titleMessage.params), title);
    reasonMessages?.forEach((message, index) => {
      if (message) assert.equal(translate('en', message.key, message.params), reasons[index]);
    });
    assert.ok(remedyMessage);
    assert.equal(translate('en', remedyMessage.key, remedyMessage.params), remedy);
  }
});

test('Export history preserves freshness, loading and timestamp text', () => {
  assert.equal(translate('en', 'export.history.needsUpdating', { count: 2 }), 'Export history · 2 need updating');
  assert.equal(translatePlural('en', 'export.history.recorded', 1), '1 recorded export');
  assert.equal(translatePlural('en', 'export.history.recorded', 0), '0 recorded exports');
  assert.equal(translate('en', 'export.history.prepared', { date: '1/2/2026, 3:04:05 PM' }), 'Prepared 1/2/2026, 3:04:05 PM');
  assert.equal(translate('en', 'export.history.lastLoadedRecord', { status: translate('en', 'export.history.matches') }),
    'Last loaded record: Matches open project content.');
  assert.equal(translate('en', 'export.history.earlierVideo'), 'Changed since export. This video contains earlier content.');
});

test('App media alignment and export repair keep their original English', () => {
  const alignment = translateRich('en', 'export.repair.alignmentNotice', {}, {
    b: (text) => createElement('strong', null, text),
  });
  assert.equal(renderToStaticMarkup(createElement(Fragment, null, ...alignment)),
    '<strong>Audio alignment not verified.</strong> Existing caption and word times were kept. Check them against the edited audio before exporting.');
  assert.equal(translate('en', 'export.repair.dismissAlignmentLabel'), 'Dismiss audio alignment warning');
  assert.equal(translate('en', 'export.repair.fixCaption', { position: 2 }), 'Fixing an export issue · Caption 2');
  assert.equal(translate('en', 'export.repair.back'), 'Back to export');
});

test('Compare keeps the English choices, counts and navigation', () => {
  assert.equal(translate('en', 'compare.dock.usePartLabel'), 'Use part of the proposal');
  assert.equal(translatePlural('en', 'compare.dock.textChanges', 1), '1 text change');
  assert.equal(translatePlural('en', 'compare.dock.timingChanges', 2), '2 timing changes');
  assert.equal(translatePlural('en', 'compare.dock.locksKept', 2), '2 locked captions kept');
  assert.equal(translate('en', 'compare.dock.changePosition', { position: 1, total: 3 }), 'Change 1 of 3');
  assert.equal(translate('en', 'compare.dock.playChange', { range: '0:01.000 – 0:02.000' }), 'Play this change, 0:01.000 – 0:02.000');
  assert.equal(translate('en', 'compare.dock.candidateTiming', { score: 83, flagged: 1, total: 3 }),
    'Timing match 83% · 1/3 words flagged');
  assert.equal(renderToStaticMarkup(createElement(Fragment, null, ...translateRich('en', 'compare.dock.accuracyHint', {},
    { b: (text) => createElement('i', null, text) }))), 'Accuracy hint <i>optional</i>');
});
