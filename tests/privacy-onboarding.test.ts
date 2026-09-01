import assert from 'node:assert/strict';
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
