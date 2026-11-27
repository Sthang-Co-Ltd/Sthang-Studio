import assert from 'node:assert/strict';
import test from 'node:test';
import { translate, translatePlural } from '../apps/web/src/i18n/translate.js';
import { secureStorageLabelKey } from '../apps/web/src/i18n/messages/en/settings.js';
import { doctorCheckKey, doctorTimingFixKey } from '../apps/web/src/i18n/messages/en/system.js';
import type { MessageKey } from '../apps/web/src/i18n/types.js';

// English before extraction at ef8b2df. Named slots replace the original dynamic values.
const copy: ReadonlyArray<readonly [MessageKey, string]> = [
  ['settings.glossary.truncated', "Some glossary terms were not saved. Shorten the list or long terms, then try again."],
  ['settings.glossary.newerChoices', "Earlier glossary saved. Newer global glossary choices are shown."],
  ['settings.glossary.saved', "Glossary saved."],
  ['settings.glossary.newerDraft', "Earlier glossary saved. Your newer glossary edits are still unsaved."],
  ['settings.glossary.failed', "Could not save the glossary. Your text is kept; try again."],
  ['settings.glossary.saving', "Saving glossary…"],
  ['settings.glossary.save', "Save key terms"],
  ['settings.glossary.label', "Key terms for all projects"],
  ['settings.profileImport.invalid', "This file is not a readable Studio profile. Choose a JSON file created by Export profile. Your settings and drafts are unchanged."],
  ['settings.profileImport.confirmTitle', "Replace your saved profile?"],
  ['settings.profileImport.confirm', "Replace profile"],
  ['settings.profileImport.cancel', "Keep current"],
  ['settings.profileImport.savedWithDraft', "Profile imported. Your unsaved glossary text is still in the form."],
  ['settings.profileImport.saved', "Profile imported."],
  ['settings.profileImport.failed', "Could not confirm the profile import. Your form drafts are kept. Retry this file or choose another."],
  ['settings.profileImport.importing', "Importing…"],
  ['settings.profileImport.open', "Import profile"],
  ['settings.profileImport.retry', "Retry import"],
  ['settings.profileImport.chooseAnother', "Choose another profile"],
  ['settings.profileImport.confirmMessage', "“{file}” will replace your saved vocabulary, correction history and rules, topic packs, presets, and preferences. You’ll need to opt in again to share usage data or contribute Khmer captions."],
  ['settings.loadFailed', "Could not load settings"],
  ['settings.loading', "Loading settings…"],
  ['settings.packs.saving', "Saving topic pack…"],
  ['settings.packs.save', "Save context as pack"],
  ['settings.packs.noDescription', "No description"],
  ['settings.packs.title', "Topic packs"],
  ['settings.packs.description', "Reuse the current context and vocabulary in other projects."],
  ['settings.packs.name', "Topic pack name"],
  ['settings.packs.openProject', "Open a project to apply a topic pack."],
  ['settings.packs.empty', "No topic packs yet."],
  ['settings.packs.apply', "Apply"],
  ['settings.packs.example', "Example: AI / Coding"],
  ['settings.packs.saved', "Saved topic pack “{name}”."],
  ['settings.packs.failed', "Could not save topic pack “{name}”. Your name and current context are kept; try again."],
  ['settings.packs.deleting', "Deleting topic pack “{name}”…"],
  ['settings.packs.deleted', "Deleted topic pack “{name}”."],
  ['settings.packs.deleteFailed', "Could not confirm deletion of topic pack “{name}”. Try deleting it again."],
  ['settings.packs.applyLabel', "Apply {name}"],
  ['settings.packs.deleteLabel', "Delete topic pack {name}"],
  ['settings.title', "Settings"],
  ['settings.tabs.ai', "AI connection"],
  ['settings.tabs.profile', "Profile"],
  ['settings.tabs.privacy', "Privacy"],
  ['settings.tabs.doctor', "System check"],
  ['settings.retry', "Retry settings"],
  ['settings.profile.keyTerms', "key terms"],
  ['settings.profile.rules', "approved rules"],
  ['settings.profile.events', "correction events"],
  ['settings.profile.packs', "topic packs"],
  ['settings.profileExport', "Export profile"],
  ['settings.close', "Close settings"],
  ['settings.sections', "Settings sections"],
  ['privacy.consent.on', "On"],
  ['privacy.consent.off', "Off"],
  ['privacy.consent.unset', "Not chosen"],
  ['privacy.status.privacyFailed', "Privacy choices and contribution status could not be refreshed. The last loaded choices are shown."],
  ['privacy.status.privacyFailedWithProgress', "Privacy choices and contribution status could not be refreshed. The last loaded choices are shown. The last loaded progress is shown."],
  ['privacy.status.contributionFailed', "Contribution status could not be refreshed. Your privacy choices are kept."],
  ['privacy.status.contributionFailedWithProgress', "Contribution status could not be refreshed. Your privacy choices are kept. The last loaded progress is shown."],
  ['privacy.status.refreshing', "Refreshing contribution status…"],
  ['privacy.status.loading', "Loading contribution status…"],
  ['privacy.status.wait', "Contribution status will refresh after this action."],
  ['privacy.status.refreshed', "Contribution status refreshed."],
  ['privacy.status.checking', "Checking status…"],
  ['privacy.status.retry', "Retry status"],
  ['privacy.status.refresh', "Refresh status"],
  ['privacy.saved.analyticsOn', "Product analytics choice saved: on."],
  ['privacy.saved.analyticsOff', "Product analytics choice saved: off."],
  ['privacy.saved.contributionOn', "Khmer Caption Contributor choice saved: on."],
  ['privacy.saved.contributionOff', "Khmer Caption Contributor choice saved: off."],
  ['privacy.saveFailed', "Could not confirm your privacy choice was saved. Try that choice again."],
  ['privacy.withdraw.failed', "Could not request contribution deletion."],
  ['privacy.withdraw.request', "Request deletion"],
  ['privacy.withdraw.help', "Requests deletion of data already sent under this Contributor identity. Local projects stay on your computer."],
  ['privacy.withdraw.pending', "Deletion is pending. The Sthang contribution service has not confirmed it yet."],
  ['privacy.withdraw.confirm', "Stop contributing and request deletion of contribution data already sent to Sthang? Local caption projects are not deleted."],
  ['privacy.withdraw.requesting', "Requesting contribution deletion…"],
  ['privacy.title', "Privacy & contribution"],
  ['privacy.description', "Caption contribution and product analytics are separate. Both stay off until you enable them."],
  ['privacy.contributor.title', "Khmer Caption Contributor"],
  ['privacy.contributor.purpose', "Help make Khmer captions world-class."],
  ['privacy.contributor.data', "If you join, eligible corrections may send matching short audio, generated and corrected wording, timing, and technical quality evidence."],
  ['privacy.contributor.exclusions', "This program excludes your full video, project name, filename, API key, topic context, correction memory, and unrelated captions. Corrections made before you join are not collected retroactively."],
  ['privacy.contributor.verified', "Verified corrections"],
  ['privacy.contributor.speech', "Verified Khmer speech"],
  ['privacy.contributor.submitted', "Awaiting verification"],
  ['privacy.contributor.queued', "Queued locally"],
  ['privacy.contributor.unconfigured', "Contribution hosting is not configured in this build, so the program cannot upload correction audio even if you join."],
  ['privacy.contributor.choiceHelp', "Change this choice anytime. Your access to Studio stays the same."],
  ['privacy.contributor.enabled', "Helping improve Khmer captions"],
  ['privacy.contributor.progress', "Khmer Caption Contributor progress"],
  ['privacy.contributor.duration', "{minutes}m {seconds}s"],
  ['privacy.keepPrivate', "Keep my work private"],
  ['privacy.analytics.title', "Optional product analytics"],
  ['privacy.analytics.purpose', "Help us build a better Studio."],
  ['privacy.analytics.description', "Share limited usage events to help Sthang understand the path from launch to caption export and improve the workflow."],
  ['privacy.analytics.data', "When enabled, Studio sends a random installation ID, approved event names, coarse workflow categories, and Studio/platform versions. Analytics excludes caption text, audio, filenames, project names, local paths, vocabulary or context text, SRT contents, and your Gemini API key. It is separate from Khmer Caption Contributor."],
  ['privacy.analytics.keepOff', "Keep analytics off"],
  ['privacy.analytics.choiceHelp', "You can change this choice anytime in Settings."],
  ['privacy.analytics.enabled', "Product analytics is on"],
  ['privacy.analytics.enable', "Share product analytics"],
  ['privacy.choicesNote', "Both choices are saved separately on this computer. Neither limits Studio's caption features."],
  ['privacy.helpImprove', "Help improve Khmer captions"],
  ['privacy.saving', "Saving your privacy choice…"],
  ['privacy.upgrade.saveFailed', "Could not save your privacy choice"],
  ['privacy.upgrade.reviewFailed', "Could not open privacy choices"],
  ['privacy.upgrade.reviewTitle', "Privacy choices"],
  ['privacy.upgrade.reviewDescription', "Contribution and product analytics remain separate. You can change either choice later in Settings → Privacy."],
  ['privacy.upgrade.version', "What’s new in Studio 0.8"],
  ['privacy.upgrade.description', "Because this Studio installation predates the new Contributor option, we’re asking once before it can collect anything."],
  ['privacy.upgrade.optional', "Contributor is optional"],
  ['privacy.upgrade.optionalDescription', "If you join, only eligible corrections you make after joining can contribute the matching short audio, generated and corrected wording, timing, and technical quality evidence."],
  ['privacy.upgrade.privateProject', "Your project stays private"],
  ['privacy.upgrade.privateProjectDescription', "Full videos, project names, filenames, API keys, topic context, correction memory, and unrelated captions are not contributed through this program."],
  ['privacy.upgrade.analyticsSeparate', "Product analytics is separate"],
  ['privacy.upgrade.analyticsSeparateDescription', "Analytics stays off unless you choose it separately. Joining Contributor never turns analytics on."],
  ['privacy.upgrade.review', "Review privacy & analytics settings"],
  ['privacy.upgrade.dismissHelp', "Closing this doesn’t change either privacy choice. Change them anytime in Settings → Privacy."],
  ['privacy.upgrade.closeReview', "Close privacy settings"],
  ['privacy.upgrade.dismiss', "Not now"],
  ['privacy.promptTitle', "Help make Khmer captions world-class"],
  ['privacy.invitation.saveFailed', "Could not save your choice"],
  ['privacy.invitation.label', "Khmer Caption Contributor invitation"],
  ['privacy.invitation.dismiss', "Dismiss for this session"],
  ['privacy.invitation.purpose', "Your corrections can help improve Khmer caption technology for creators everywhere."],
  ['privacy.invitation.detail', "If you join, Studio may share the short audio around eligible corrections you make <b>after joining</b>, together with generated and corrected text and timing. Full videos, project names, API keys, and unrelated captions are not contributed."],
  ['privacy.invitation.join', "Help improve Khmer"],
  ['system.description', "Checks the app, media tools, caption timing, AI connection, and local storage. The report excludes your API key."],
  ['system.empty', "No report yet"],
  ['system.help', "Run checks after setup or if caption generation fails."],
  ['system.running', "Running checks…"],
  ['system.retry', "Retry system check"],
  ['system.run', "Run checks"],
  ['system.complete', "System check complete."],
  ['system.copy', "Copy diagnostic report"],
  ['system.checking', "Checking system…"],
  ['system.checkingWithReport', "Checking system… The last loaded report remains below."],
  ['system.failure', "System check could not finish."],
  ['system.failureWithReport', "<b>{error}</b> The last loaded report is shown. Try the check again."],
  ['system.failureWithoutReport', "<b>{error}</b> No report is available yet. Try the check again."],
  ['system.overall.ok', "System checks passed"],
  ['system.overall.warning', "Ready with warnings"],
  ['system.overall.error', "Setup needs attention"],
  ['system.stale', "Last loaded report · {summary}"],
  ['system.environment', "{date} · {platform} · Node {node}"],
];

test('Settings, Privacy, both prompts, and System check preserve English copy', () => {
  for (const [key, template] of copy) {
    assert.equal(translate('en', key), template, key);
  }
  assert.equal(translate('en', 'settings.packs.saved', { name: 'Khmer <b>news</b>' }), 'Saved topic pack “Khmer <b>news</b>”.');
  for (const [count, expected] of [[0, '0 terms'], [1, '1 term'], [2, '2 terms']] as const) {
    assert.equal(translatePlural('en', 'settings.packs.summary', count, { description: 'Example' }), expected + ' · Example');
  }
  assert.equal(translate('en', 'privacy.contributor.duration', { minutes: 2, seconds: '03' }), '2m 03s');
  assert.equal(translate('en', 'system.stale', { summary: 'System checks passed' }), 'Last loaded report · System checks passed');
});

const doctorLabels = [
  ['node', "Node.js runtime"],
  ['ffmpeg', "FFmpeg"],
  ['ffmpeg-ass', "FFmpeg native subtitle filter"],
  ['ffprobe', "FFprobe"],
  ['python', "Python timing runtime"],
  ['kfa', "KFA Khmer aligner"],
  ['onnx', "ONNX Runtime"],
  ['kfa-model', "KFA Khmer model"],
  ['whisper', "Local Whisper fallback"],
  ['python-packages', "Local timing packages"],
  ['gemini-key', "Gemini API key"],
  ['gemini-storage', "AI credential storage"],
  ['uploads', "Upload storage"],
  ['cache', "Stage cache storage"],
  ['data', "Project/profile storage"],
  ['history', "Project history storage"],
  ['proposals', "Regeneration preview storage"],
  ['jobs', "Processing queue storage"],
  ['project-readability', "Saved project readability"],
  ['segmenter', "Khmer word segmenter"],
] as const;

test('every doctor check ID reproduces its server label, with an exact unknown-ID fallback', () => {
  for (const [id, label] of doctorLabels) {
    const key = doctorCheckKey(id);
    assert.equal(key, `system.check.${id}`);
    assert.equal(translate('en', key!), label);
  }
  for (const id of ['future-check', 'NODE', 'toString', '__proto__']) {
    assert.equal(doctorCheckKey(id), undefined, id);
  }
});

const platforms = [
  ['win32 x64', 'win32', "Run Install Sthang Studio.bat again from your download, or run setup-local-timing-windows.bat in the Studio folder. Then run the System check again."],
  ['darwin arm64', 'darwin', "In the Studio folder, run bash ./setup-local-timing-macos.sh. Then run the System check again."],
  ['linux x64', 'other', "Install the local timing Python dependencies for this platform."],
] as const;

test('doctor timing fixes require the exact server text for the check and platform', () => {
  for (const [platform, suffix, english] of platforms) {
    for (const id of ['python', 'python-packages', 'kfa', 'kfa-model', 'onnx', 'whisper']) {
      const key = doctorTimingFixKey(id, platform, english);
      assert.equal(key, `system.timingFix.${suffix}`);
      assert.equal(translate('en', key!), english);
      assert.equal(doctorTimingFixKey(id, platform, english + ' '), undefined);
    }
  }
  assert.equal(doctorTimingFixKey('python', 'darwin arm64', platforms[0][2]), undefined);
  assert.equal(doctorTimingFixKey('python', 'win32 x64'), undefined);
  assert.equal(doctorTimingFixKey('kfa-model', 'win32 x64', 'Run the KFA import test or generate captions once while online.'), undefined);
  assert.equal(doctorTimingFixKey('ffmpeg', 'win32 x64', platforms[0][2]), undefined);
});

test('secure-storage labels require the exact server values', () => {
  for (const [suffix, label] of [
    ['win32', "Windows user-protected storage (DPAPI)"],
    ['darwin', "macOS Keychain"],
    ['other', "Environment variable only on this platform"],
  ] as const) {
    const key = secureStorageLabelKey(label);
    assert.equal(key, `settings.secureStorage.${suffix}`);
    assert.equal(translate('en', key!), label);
    assert.equal(secureStorageLabelKey(label + ' '), undefined);
  }
  assert.equal(secureStorageLabelKey('Future storage provider'), undefined);
});
