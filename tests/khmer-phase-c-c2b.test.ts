import assert from 'node:assert/strict';
import test from 'node:test';
import { translate } from '../apps/web/src/i18n/translate.js';
import type { MessageKey, MessageParams } from '../apps/web/src/i18n/types.js';
import { checkMediaPreviewCopy, MediaPreviewClientError, requestMediaPreview } from '../apps/web/src/media-preview-client.js';

test('media catalog retains the exact English for every extracted message', () => {
  const cases: [MessageKey, string, MessageParams?][] = [
    ['media.playback.preparationFailed', 'Playback preparation failed.'],
    ['media.playback.preparationSlow', 'Playback preparation is taking longer than expected. Check progress or cancel preparation.'],
    ['media.playback.progressUnavailable', 'Playback progress is unavailable. Retry or cancel preparation.'],
    ['media.playback.cancelFailed', 'Could not cancel preparation. Try again.'],
    ['media.playback.unavailable', 'Playback is unavailable. Try again.'],
    ['media.playback.preparing', 'Preparing browser playback…'],
    ['media.playback.preparingProgress', 'Preparing browser playback · 32.5%', { progress: 32.5 }],
    ['media.playback.restarting', 'Restarting playback…'],
    ['media.playback.stalled', 'Playback stopped making progress. Retry playback to continue from this position. Your source file and captions are unchanged.'],
    ['media.playback.missingPicture', 'Picture missing? Prepare a local playback copy. Your original stays unchanged.'],
    ['media.playback.checkProgress', 'Check progress'],
    ['media.playback.cancelPreparation', 'Cancel preparation'],
    ['media.playback.retryAgain', 'Retry again'],
    ['media.playback.retry', 'Retry playback'],
    ['media.playback.prepare', 'Prepare playback'],
    ['media.playback.requestUnavailable', 'Playback preparation is unavailable.'],
    ['media.playback.requestTimeout', 'Playback preparation did not respond. Check progress or try again.'],
    ['media.playback.sourceChanged', 'The source media changed. Reopen this project.'],
    ['media.caption.reviewing', 'Reviewing'],
    ['media.caption.refining', 'Interactive preview · refining layout…'],
    ['media.caption.updating', 'Updating caption appearance…'],
    ['media.caption.preparing', 'Preparing caption preview…'],
    ['media.caption.chooseFont', 'Choose another font'],
    ['media.caption.retry', 'Retry preview'],
    ['media.caption.invalidResponse', 'Caption preview returned an invalid response. Retry preview.'],
    ['media.caption.incompleteResponse', 'Caption preview returned an incomplete response. Retry preview.'],
    ['media.caption.reconnecting', 'Caption preview service is reconnecting. Studio will retry automatically.'],
    ['media.caption.connectionInterrupted', 'Caption preview connection was interrupted. Studio will retry automatically.'],
    ['media.caption.unavailable', 'Caption preview is unavailable.'],
    ['media.caption.renderFailedStatus', 'Caption preview could not render. (503).', { status: 503 }],
    ['media.caption.frameLimit', 'This caption preview exceeds its local image limit. Choose a smaller preview resolution.'],
    ['media.caption.incompleteFrames', 'Caption preview returned an incomplete set of frames. Retry preview.'],
    ['media.caption.replayFailedStatus', 'The effect preview could not be prepared. Try Replay effect again. (400).', { status: 400 }],
    ['media.caption.replayIncompleteFrames', 'The effect preview returned an incomplete set of frames. Try again.'],
    ['media.caption.replayFrameLimit', 'The effect preview exceeds its local image limit. Choose a smaller preview resolution.'],
    ['media.caption.replayTooLarge', 'This effect preview is too large to prepare at once. Choose a smaller preview resolution.'],
    ['media.caption.replayTimeout', 'Preparing the effect preview took too long. Try Replay effect again.'],
    ['media.caption.replayInterrupted', 'Preparing the effect preview was interrupted. Try Replay effect again.'],
    ['notices.playback.effectPreparationFailed', 'The effect preview could not be prepared.'],
  ];
  for (const [key, english, params] of cases) {
    assert.equal(translate('en', key, params), english, key);
  }
});

test('media preview errors retain their English and identify only client messages with catalog metadata', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch');
  const request = () => requestMediaPreview('test', 'test.mp4', 'POST');
  const expectClientError = async (result: Promise<unknown>, key: MessageKey, english: string) => {
    await assert.rejects(result, (error: unknown) => {
      assert.ok(error instanceof MediaPreviewClientError);
      assert.equal(error.message, english);
      assert.deepEqual(error.messageMetadata, { key });
      assert.equal(translate('en', key), error.message);
      return true;
    });
  };
  for (const response of [
    () => new Response(null, { status: 500 }),
    () => new Response('invalid JSON'),
    () => Response.json({ source: 'test.mp4' }),
    () => Response.json({}, { status: 500 }),
    () => Response.json({ error: 'x'.repeat(4097) }, { status: 500 }),
  ]) {
    fetch.mock.mockImplementation(async () => response());
    await expectClientError(request(), 'media.playback.requestUnavailable', 'Playback preparation is unavailable.');
  }
  await expectClientError(checkMediaPreviewCopy('//invalid/copy.mp4'), 'media.playback.requestUnavailable', 'Playback preparation is unavailable.');
  fetch.mock.mockImplementation(async () => Response.json({ source: 'changed.mp4' }));
  await expectClientError(request(), 'media.playback.sourceChanged', 'The source media changed. Reopen this project.');

  fetch.mock.mockImplementation(async (_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
  }));
  const timeout = 'Playback preparation did not respond. Check progress or try again.';
  await expectClientError(requestMediaPreview('test', 'test.mp4', 'POST', undefined, false, 1), 'media.playback.requestTimeout', timeout);
  await expectClientError(checkMediaPreviewCopy('/media/copy.mp4', undefined, 1), 'media.playback.requestTimeout', timeout);

  const serverMessage = '  Synthetic server detail.  ';
  for (const message of [serverMessage, '']) {
    fetch.mock.mockImplementation(async () => Response.json({ error: message }, { status: 400 }));
    await assert.rejects(request(), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, message);
      assert.equal((error as MediaPreviewClientError).messageMetadata, undefined);
      return true;
    });
  }
});
