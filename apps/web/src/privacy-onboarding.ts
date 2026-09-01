import { PRIVACY_UPGRADE_NOTICE_VERSION } from '@kcs/shared';
import type { AppProfile } from '@kcs/shared';

export const CONTRIBUTION_PROMPT_SESSION_KEY = 'sthang:contribution-prompt-shown:v1';

export function shouldShowPrivacyUpgradeNotice(profile: AppProfile) {
  const contributionConsent = profile.preferences.khmerContributionConsent || 'unset';
  return contributionConsent === 'unset'
    && profile.preferences.privacyUpgradeNoticeVersion !== PRIVACY_UPGRADE_NOTICE_VERSION;
}
