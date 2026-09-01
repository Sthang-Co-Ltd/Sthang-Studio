import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { PRIVACY_UPGRADE_NOTICE_VERSION } from '@kcs/shared';
import type { AppProfile, ConsentState } from '@kcs/shared';
import { shouldShowPrivacyUpgradeNotice } from '../apps/web/src/privacy-onboarding';

function profile(contribution: ConsentState, noticeVersion?: string): AppProfile {
  return {
    version: 1,
    defaultVocabulary: [],
    styles: [],
    topicPacks: [],
    correctionRules: [],
    correctionEvents: [],
    preferences: {
      reviewPreRollMs: 450,
      reviewPostRollMs: 300,
      autoLoopReview: true,
      analyticsConsent: 'unset',
      khmerContributionConsent: contribution,
      privacyUpgradeNoticeVersion: noticeVersion,
    },
    updatedAt: new Date(0).toISOString(),
  };
}

function profileFromIsolatedStateRoot(stateRoot: string) {
  const script = [
    "const { profileStore } = await import('./apps/server/src/services/profile-store.ts');",
    'const profile = await profileStore.get();',
    "console.log('PROFILE_RESULT:' + JSON.stringify(profile));",
  ].join('\n');
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
    cwd: process.cwd(),
    env: { ...process.env, STHANG_STUDIO_STATE_ROOT: stateRoot, DOTENV_CONFIG_QUIET: 'true' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const line = result.stdout.split(/\r?\n/).find((value) => value.startsWith('PROFILE_RESULT:'));
  assert.ok(line, `isolated profile result missing from: ${result.stdout}`);
  return JSON.parse(line.slice('PROFILE_RESULT:'.length)) as AppProfile;
}

test('existing-user privacy introduction appears only for an unset Contributor choice', () => {
  assert.equal(shouldShowPrivacyUpgradeNotice(profile('unset')), true);
  assert.equal(shouldShowPrivacyUpgradeNotice(profile('granted')), false);
  assert.equal(shouldShowPrivacyUpgradeNotice(profile('declined')), false);
});

test('handled v0.8 introduction never reappears while consent remains unset', () => {
  assert.equal(shouldShowPrivacyUpgradeNotice(profile('unset', PRIVACY_UPGRADE_NOTICE_VERSION)), false);
});

test('analytics consent never controls the Contributor upgrade introduction', () => {
  const value = profile('unset');
  value.preferences.analyticsConsent = 'granted';
  assert.equal(shouldShowPrivacyUpgradeNotice(value), true);
});

test('fresh v0.8 state is stamped so first-use onboarding stays post-export', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sthang-fresh-v08-'));
  try {
    const value = profileFromIsolatedStateRoot(root);
    assert.equal(value.preferences.privacyUpgradeNoticeVersion, PRIVACY_UPGRADE_NOTICE_VERSION);
    assert.equal(shouldShowPrivacyUpgradeNotice(value), false);
    assert.equal(fs.existsSync(path.join(root, 'data', 'profile.json')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('pre-existing project evidence keeps the v0.8 upgrade introduction eligible', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sthang-existing-v08-'));
  try {
    const projectDir = path.join(root, 'data', 'projects');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'existing-project.json'), '{}\n', 'utf8');
    const value = profileFromIsolatedStateRoot(root);
    assert.equal(value.preferences.privacyUpgradeNoticeVersion, undefined);
    assert.equal(shouldShowPrivacyUpgradeNotice(value), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
