import assert from 'node:assert/strict';
import test from 'node:test';
import { CAPTION_LOOKS } from '@kcs/shared';
import { translate } from '../apps/web/src/i18n/translate.js';
import {
  activityMessageKey, activityStageNameKey, candidateLabelKey, historyLabelKey,
  historySourceKey, lookNameKey, selectedCandidateReasonKey,
} from '../apps/web/src/server-labels.js';

test('Activity keeps the English job message and localizes every known stage in Khmer mode', () => {
  const stageSentences = {
    queued: 'This job is waiting to start.',
    starting: 'Starting the job.',
    audio: 'Preparing audio.',
    transcription: 'Listening to the audio for caption wording.',
    alignment: 'Checking caption wording against the audio timing.',
    diff: 'Preparing the comparison for review.',
    grouping: 'Grouping the caption wording and timing.',
    complete: 'The result is ready.',
    'video-export': 'Preparing the captioned video.',
    'checking-export-completion': 'Checking whether this video finished before Studio stopped. No render is being restarted.',
    'export-completion-uncertain': 'Studio could not verify that the video finished. Check the export folder before starting another render.',
    interrupted: 'This job was interrupted.',
    cancelled: 'This job was cancelled.',
    failed: 'This job could not finish.',
  };
  for (const [code, sentence] of Object.entries(stageSentences)) {
    assert.equal(activityMessageKey('en', code), undefined);
    const message = activityMessageKey('km', code);
    assert.ok(message);
    assert.equal(message, `server.stage.${code}`);
    assert.equal(translate('en', message), sentence);
    const name = activityStageNameKey(code);
    assert.ok(name);
    assert.equal(name, `server.stageName.${code}`);
    assert.equal(translate('en', name), code.replaceAll('-', ' '));
  }
});

test('History source codes and checkpoint labels keep their exact English display', () => {
  const sources = ['manual-save', 'autosave', 'text-edit', 'regeneration', 'regroup',
    'cleanup', 'timing-fix', 'restore', 'system', 'word-highlight', 'word-highlight-auto'];
  for (const source of sources) {
    const key = historySourceKey(source);
    assert.ok(key);
    assert.equal(key, `server.historySource.${source}`);
    assert.equal(translate('en', key), source.replaceAll('-', ' '));
  }
  const labels = {
    autosave: 'Autosave',
    textCorrection: 'Before text correction',
    manualSave: 'Before manual save',
    restore: 'Before restoring an earlier version',
    portableRestore: 'Before portable caption restore',
    spacingCleanup: 'Before Khmer spacing cleanup',
    regroup: 'Before caption regrouping',
    fullRegeneration: 'Before full regeneration',
    applyRegeneration: 'Before applying regeneration (all)',
    applyRegenerationText: 'Before applying regeneration (text-only)',
    applyRegenerationTiming: 'Before applying regeneration (timing-only)',
    applyHighlights: 'Before applying word highlights',
    updateHighlights: 'Before updating word highlights after edits',
    undoHighlights: 'Before undoing word highlights',
    undoPreparedTimings: 'Before undoing prepared word timings',
    applyPreparedTimings: 'Before applying prepared word timings',
  };
  for (const [id, english] of Object.entries(labels)) {
    const key = historyLabelKey(english);
    assert.ok(key);
    assert.equal(key, `server.historyLabel.${id}`);
    assert.equal(translate('en', key), english);
  }
});

test('Compare candidate labels and reasons keep their exact English display', () => {
  const labels = {
    exactWording: 'Your exact wording',
    strictAcoustic: 'Strict acoustic pass',
    contextAware: 'Context-aware pass',
    alternative: 'Alternative take',
    initial: 'Initial proposal',
  };
  for (const [id, english] of Object.entries(labels)) {
    const key = candidateLabelKey(english);
    assert.ok(key);
    assert.equal(key, `server.candidateLabel.${id}`);
    assert.equal(translate('en', key), english);
  }
  const reasons = {
    advisoryRanking: 'Selected using local alignment coverage, alignment score, low-confidence rate, and a small continuity bonus for user-accepted wording. This ranking is advisory—not proof of semantic correctness.',
    exactWording: 'Your exact wording was preserved and only its timing was aligned locally.',
  };
  for (const [id, english] of Object.entries(reasons)) {
    const key = selectedCandidateReasonKey(english);
    assert.ok(key);
    assert.equal(key, `server.selectedCandidateReason.${id}`);
    assert.equal(translate('en', key), english);
  }
});

test('every Look name matches the shared recipe in English', () => {
  assert.equal(CAPTION_LOOKS.length, 6);
  for (const { id, label } of CAPTION_LOOKS) {
    const key = lookNameKey(id);
    assert.ok(key);
    assert.equal(key, `looks.${id}`);
    assert.equal(translate('en', key), label);
  }
});

test('unknown values and near matches have no catalog key', () => {
  const examples = [
    [(code: string) => activityMessageKey('km', code), 'Alignment'],
    [activityStageNameKey, 'alignment '],
    [historySourceKey, 'manual save'],
    [historyLabelKey, 'Before timing cleanup: Custom profile'],
    [candidateLabelKey, 'Alternative Take'],
    [selectedCandidateReasonKey, 'Unrecognized selection evidence.'],
    [lookNameKey, 'bold outline'],
  ] as const;
  for (const [keyFor, value] of examples) {
    assert.equal(keyFor(value), undefined);
    assert.equal(keyFor('constructor'), undefined);
    assert.equal(keyFor('__proto__'), undefined);
  }
});
