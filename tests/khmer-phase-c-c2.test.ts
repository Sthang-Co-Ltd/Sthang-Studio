import assert from 'node:assert/strict';
import test from 'node:test';
import type { CaptionSegment } from '@kcs/shared';
import { CaptionHandoffError, captionHandoffApi } from '../apps/web/src/caption-handoff-client.js';
import { planCaptionTimingEdit } from '../apps/web/src/caption-timing-transaction.js';
import { en } from '../apps/web/src/i18n/messages/en/index.js';
import { km } from '../apps/web/src/i18n/messages/km/index.js';
import { createTranslator, translate, translatePlural } from '../apps/web/src/i18n/translate.js';
import type { MessageKey, MessageParams } from '../apps/web/src/i18n/types.js';
import { playbackFailure, playbackFailureMessage } from '../apps/web/src/media-playback-recovery.js';
import { storageCheckFailure } from '../apps/web/src/project-storage.js';
import { createUploadRecoveryStore } from '../apps/web/src/upload-recovery.js';
import { projectBinErrorNotice } from '../apps/web/src/use-project-bin.js';

function expectEnglish(message: { key: MessageKey; params?: MessageParams } | undefined, english: string) {
  assert.ok(message);
  assert.equal(translate('en', message.key, message.params), english, message.key);
}

test('project-bin operation and server codes retain the exact client notices', () => {
  const codes = [
    ['job_active', "Finish or cancel this project's active work in Activity, then try again."],
    ['storage_blocked', "Studio can't change saved projects right now."],
    ['expired', 'This project can no longer be restored.'],
    ['purging', 'This project is being removed.'],
    ['instance_mismatch', 'This item changed. Try loading Recently deleted again.'],
    ['purge_incomplete', 'Studio could not finish removing this project. It will try again automatically.'],
  ] as const;
  for (const [code, english] of codes) {
    const notice = projectBinErrorNotice(code, 'move');
    assert.equal(notice.message, english);
    expectEnglish(notice.messageMetadata, english);
    assert.equal(notice.reviewStorage, code === 'storage_blocked');
  }
  const refreshed = projectBinErrorNotice('instance_mismatch', 'restore', true);
  assert.equal(refreshed.message, 'This item changed. The list has been updated.');
  expectEnglish(refreshed.messageMetadata, refreshed.message);
  const fallbacks = {
    move: 'Studio could not move this project. It was not changed.',
    restore: 'Studio could not restore this project.',
    delete: 'Studio could not delete this project.',
  } as const;
  for (const operation of ['move', 'restore', 'delete'] as const) {
    for (const code of [undefined, 'unknown', 'constructor']) {
      const notice = projectBinErrorNotice(code, operation);
      assert.equal(notice.message, fallbacks[operation]);
      expectEnglish(notice.messageMetadata, fallbacks[operation]);
    }
  }
  expectEnglish({ key: 'notices.bin.moveUnconfirmed' }, 'Studio could not confirm the move. Check All projects and Recently deleted.');
  expectEnglish({ key: 'notices.bin.restored', params: { title: 'Field notes' } }, 'Restored “Field notes”.');
  expectEnglish({ key: 'notices.bin.deleted', params: { title: 'Field notes' } }, '“Field notes” was deleted.');
});

test('browser media errors preserve the English notice for every code and the default', () => {
  const reasons = [
    [1, 'Playback was interrupted.'],
    [2, 'The browser could not read the playback file.'],
    [3, 'The browser could not decode the playback file.'],
    [4, 'The browser could not open the playback file.'],
    [undefined, 'Playback could not continue.'],
    [999, 'Playback could not continue.'],
  ] as const;
  for (const [code, reason] of reasons) {
    const english = `${reason} Retry playback to restart the player. Your source file and captions are unchanged.`;
    assert.equal(playbackFailureMessage(code), english);
    expectEnglish(playbackFailure(code), english);
  }
});

test('every caption timing limit retains its English with the catalog metadata attached', () => {
  const a: CaptionSegment = { id: 'a', text: 'One', startMs: 1000, endMs: 2000 };
  const b: CaptionSegment = { id: 'b', text: 'Two', startMs: 2100, endMs: 3000 };
  const shared = { sharedBoundary: true };
  const cases = [
    [planCaptionTimingEdit([{ ...a, timingLocked: true }], 'a', 'start', 1500, 5000), 'Unlock this caption’s timing before changing it.'],
    [planCaptionTimingEdit([a], 'a', 'start', 1500, 5000, shared), 'There is no previous caption to share this edge.'],
    [planCaptionTimingEdit([a], 'a', 'end', 1500, 5000, shared), 'There is no next caption to share this edge.'],
    [planCaptionTimingEdit([a, { ...b, timingLocked: true }], 'a', 'end', 2300, 5000, shared), 'The neighboring caption’s timing is locked. Both edges were kept.'],
    [planCaptionTimingEdit([a, { ...b, endMs: 1030 }], 'a', 'end', 1030, 5000, shared), 'These captions do not have enough time for a shared boundary.'],
    [planCaptionTimingEdit([{ ...a, startMs: -10 }, b], 'a', 'end', 2300, 5000, shared), 'This boundary cannot be moved without invalidating a caption.'],
    [planCaptionTimingEdit([{ ...a, id: 'earlier', startMs: 900, endMs: 2250 }, a, b], 'a', 'end', 2300, 5000, shared), 'Another caption blocks this shared boundary. Its timing was kept.'],
    [planCaptionTimingEdit([a, b], 'a', 'end', 4000, 5000, shared), 'Reached the minimum caption duration.'],
    [planCaptionTimingEdit([a], 'a', 'start', -100, 5000), 'Reached the start of the media.'],
    [planCaptionTimingEdit([a], 'a', 'end', 6000, 5000), 'Reached the end of the media.'],
    [planCaptionTimingEdit([a, b], 'a', 'end', 2400, 5000), 'Reached the neighboring caption. Adjust the shared boundary or enable Allow overlaps to continue.'],
  ] as const;
  for (const [result, english] of cases) {
    assert.equal(result.limited, english);
    expectEnglish(result.limitedMessage, english);
  }
  assert.equal(planCaptionTimingEdit([a], 'a', 'end', 2100, 5000).limitedMessage, undefined);
});

test('project storage and both upload recovery failures carry exact English', () => {
  assert.equal(storageCheckFailure.error, 'Saved project storage could not be checked. Your files were not changed.');
  expectEnglish(storageCheckFailure.errorMessage, storageCheckFailure.error);
  const unavailable = createUploadRecoveryStore(() => null).read();
  assert.equal(unavailable.error, 'Upload recovery could not be kept for restart. Keep this page open until the upload result is confirmed.');
  expectEnglish(unavailable.errorMessage, unavailable.error);

  const values = new Map<string, string>();
  const store = createUploadRecoveryStore(() => ({
    get length() { return values.size; },
    key: (index) => Array.from(values.keys())[index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  }));
  const details = { name: 'video.mp4', size: 1024, type: 'video/mp4', lastModified: 1 };
  for (let index = 0; index < 5; index++) assert.ok(store.keep(details, 'upload_' + String(index).padStart(32, '0')).entry);
  const full = store.keep(details, 'upload_' + 'f'.repeat(32));
  assert.equal(full.entry, null);
  assert.equal(full.error, 'Upload recovery is full. Earlier reminders are kept; forget one you no longer need to keep this upload for restart.');
  expectEnglish(full.errorMessage, full.error);
});

test('handoff errors keep provider prose separate from the three client-authored messages', async (context) => {
  const basis = { expectedMedia: { filename: 'video.mp4', size: 1024 }, expectedRevision: 'reviewed' };
  const cases = [
    [new Response(null, { status: 503 }), 'Caption transfer failed (503).', 'notices.transfer.httpFailed'],
    [new Response(null, { headers: { 'content-length': String(18 * 1024 * 1024) } }), 'The caption handoff file exceeded its supported size.', 'notices.transfer.fileTooLarge'],
    [new Response(null), 'The caption file was empty. Retry the export.', 'notices.transfer.emptyFile'],
    [Response.json({ error: 'Synthetic server detail.' }, { status: 409 }), 'Synthetic server detail.', undefined],
  ] as const;
  for (const [response, english, key] of cases) {
    const mock = context.mock.method(globalThis, 'fetch', async () => response);
    try {
      await assert.rejects(captionHandoffApi.export('demo', 'srt', basis), (error) => {
        assert.ok(error instanceof CaptionHandoffError);
        assert.equal(error.message, english);
        if (key) {
          assert.equal(error.messageMetadata?.key, key);
          expectEnglish(error.messageMetadata, english);
        } else assert.equal(error.messageMetadata, undefined);
        return true;
      });
    } finally {
      mock.mock.restore();
    }
  }
});

test('notice and dialog plurals preserve English inflections when translations are absent', () => {
  const partial = createTranslator({ en, km: { ...km, dialogs: undefined, notices: undefined } });
  for (const locale of ['en', 'km'] as const) {
    assert.equal(partial.translatePlural(locale, 'notices.corrections.captured', 1), '1 correction captured in the Inbox.');
    assert.equal(partial.translatePlural(locale, 'notices.corrections.captured', 2), '2 corrections captured in the Inbox.');
    assert.equal(partial.translatePlural(locale, 'dialogs.media.resetCount', 1), 'Clear 1 caption, approvals, locks, and the transcript. Generate new captions when ready.');
    assert.equal(partial.translatePlural(locale, 'dialogs.media.resetCount', 2), 'Clear 2 captions, approvals, locks, and the transcript. Generate new captions when ready.');
    assert.equal(partial.translatePlural(locale, 'dialogs.renderWarnings.message', 1, { profile: 'Balanced' }),
      '1 timing/format warning remain under “Balanced”. Studio can render anyway, but the finished video will use the current caption text and timing.');
  }
  for (const count of [1, 2]) {
    assert.equal(translatePlural('km', 'notices.corrections.captured', count), km.notices.corrections.captured.other.replace('{count}', String(count)));
    assert.equal(translatePlural('km', 'dialogs.media.resetCount', count), km.dialogs.media.resetCount.other.replace('{count}', String(count)));
  }
  assert.equal(translatePlural('km', 'dialogs.renderWarnings.message', 1, { profile: 'Balanced' }),
    km.dialogs.renderWarnings.message.other.replace('{count}', '1').replace('{profile}', 'Balanced'));
});
