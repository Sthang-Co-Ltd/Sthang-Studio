import { useEffect, useRef, useState } from 'react';
import { PRIVACY_UPGRADE_NOTICE_VERSION } from '@kcs/shared';
import type { AppProfile, ConsentState } from '@kcs/shared';
import { BarChart3, LockKeyhole, ShieldCheck, HandHeart, X } from 'lucide-react';
import { api } from '../api';
import { LocaleProvider, messagesFor } from '../i18n';
import { readInterfaceLanguage } from '../i18n/language-storage';
import { CONTRIBUTION_PROMPT_SESSION_KEY, shouldShowPrivacyUpgradeNotice } from '../privacy-onboarding';
import { ContributorSettings } from './ContributorSettings';
import { useModalFocus } from '../use-modal-focus';
import './contribution.css';

export function PrivacyUpgradeHost() {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<'intro' | 'review'>('intro');
  const [profile, setProfile] = useState<AppProfile | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<{ text: string; server?: boolean } | null>(null);
  const locale = profile?.preferences.interfaceLanguage ?? readInterfaceLanguage() ?? 'en';
  const { t } = messagesFor(locale);
  const dialogRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let disposed = false;
    const inspect = async () => {
      try {
        const [currentProfile, status] = await Promise.all([api.profile(), api.contributionStatus()]);
        if (disposed || !status.endpointConfigured) return;
        if (currentProfile.preferences.privacyUpgradeNoticeVersion === PRIVACY_UPGRADE_NOTICE_VERSION) return;

        if (!shouldShowPrivacyUpgradeNotice(currentProfile)) {
          await api.patchProfile({
            preferences: {
              ...currentProfile.preferences,
              privacyUpgradeNoticeVersion: PRIVACY_UPGRADE_NOTICE_VERSION,
            },
          }).catch(() => {});
          return;
        }

        try { sessionStorage.setItem(CONTRIBUTION_PROMPT_SESSION_KEY, '1'); } catch { /* optional browser storage */ }
        setProfile(currentProfile);
        setOpen(true);
      } catch {
        // This introduction is optional UX. Startup must remain usable if its local checks fail.
      }
    };
    void inspect();
    return () => { disposed = true; };
  }, []);

  const saveResolution = async (consent?: Exclude<ConsentState, 'unset'>) => {
    const current = await api.profile();
    const next = await api.patchProfile({
      preferences: {
        ...current.preferences,
        privacyUpgradeNoticeVersion: PRIVACY_UPGRADE_NOTICE_VERSION,
        ...(consent ? { khmerContributionConsent: consent } : {}),
      },
    });
    setProfile(next);
    return next;
  };

  const choose = async (consent: Exclude<ConsentState, 'unset'>) => {
    setWorking(true);
    setError(null);
    try {
      await saveResolution(consent);
      setOpen(false);
    } catch (reason) {
      setError(reason instanceof Error ? { text: reason.message, server: true } : { text: t('privacy.upgrade.saveFailed') });
    } finally {
      setWorking(false);
    }
  };

  const dismiss = async () => {
    if (working) return;
    setWorking(true);
    setError(null);
    try {
      await saveResolution();
    } catch {
      // Recording the optional notice must not prevent an explicit dismissal.
    } finally {
      setOpen(false);
      setWorking(false);
    }
  };

  const review = async () => {
    setWorking(true);
    setError(null);
    try {
      await saveResolution();
      setView('review');
    } catch (reason) {
      setError(reason instanceof Error ? { text: reason.message, server: true } : { text: t('privacy.upgrade.reviewFailed') });
    } finally {
      setWorking(false);
    }
  };

  const saveReviewPatch = async (patch: Partial<AppProfile>) => {
    const updated = await api.patchProfile(patch);
    setProfile(updated);
    return updated;
  };

  // Root focus avoids visually preselecting either consent decision.
  useModalFocus(open && Boolean(profile), dialogRef, () => {
    if (view === 'review') setOpen(false);
    else void dismiss();
  }, dialogRef);
  useEffect(() => { if (open) dialogRef.current?.focus({ preventScroll: true }); }, [view]);

  if (!open || !profile) return null;

  if (view === 'review') {
    return <div className="privacy-upgrade-backdrop">
      <section ref={dialogRef} tabIndex={-1} style={{ outline: 'none' }} className="privacy-upgrade-dialog review-mode" role="dialog" aria-modal="true" aria-labelledby="privacy-upgrade-review-title">
        <button className="privacy-upgrade-close" aria-label={t('privacy.upgrade.closeReview')} onClick={() => setOpen(false)}><X size={19}/></button>
        <header className="privacy-upgrade-review-head">
          <span aria-hidden="true"><ShieldCheck size={20}/></span>
          <div><strong id="privacy-upgrade-review-title">{t('privacy.upgrade.reviewTitle')}</strong><small>{t('privacy.upgrade.reviewDescription')}</small></div>
        </header>
        <LocaleProvider locale={locale}><ContributorSettings profile={profile} busy={working} showIntro={false} onSave={saveReviewPatch}/></LocaleProvider>
      </section>
    </div>;
  }

  return <div className="privacy-upgrade-backdrop">
    <section ref={dialogRef} tabIndex={-1} style={{ outline: 'none' }} className="privacy-upgrade-dialog" role="dialog" aria-modal="true" aria-labelledby="privacy-upgrade-title" aria-describedby="privacy-upgrade-description">
      <button className="privacy-upgrade-close" aria-label={t('privacy.upgrade.dismiss')} disabled={working} onClick={() => void dismiss()}><X size={19}/></button>

      <div className="privacy-upgrade-hero">
        <div className="privacy-upgrade-mark" aria-hidden="true"><ShieldCheck size={29}/></div>
        <span className="privacy-upgrade-kicker">{t('privacy.upgrade.version')}</span>
        <h2 id="privacy-upgrade-title">{t('privacy.promptTitle')}</h2>
        <p id="privacy-upgrade-description">{t('privacy.upgrade.description')}</p>
      </div>

      <div className="privacy-upgrade-facts">
        <div className="privacy-upgrade-fact">
          <span aria-hidden="true"><HandHeart size={18}/></span>
          <div><strong>{t('privacy.upgrade.optional')}</strong><small>{t('privacy.upgrade.optionalDescription')}</small></div>
        </div>
        <div className="privacy-upgrade-fact">
          <span aria-hidden="true"><LockKeyhole size={18}/></span>
          <div><strong>{t('privacy.upgrade.privateProject')}</strong><small>{t('privacy.upgrade.privateProjectDescription')}</small></div>
        </div>
        <div className="privacy-upgrade-fact">
          <span aria-hidden="true"><BarChart3 size={18}/></span>
          <div><strong>{t('privacy.upgrade.analyticsSeparate')}</strong><small>{t('privacy.upgrade.analyticsSeparateDescription')}</small></div>
        </div>
      </div>

      <div className="privacy-upgrade-actions">
        <button className="privacy-upgrade-action primary" disabled={working} onClick={() => void choose('granted')}><HandHeart size={18}/>{t('privacy.helpImprove')}</button>
        <button className="privacy-upgrade-action" disabled={working} onClick={() => void choose('declined')}><LockKeyhole size={18}/>{t('privacy.keepPrivate')}</button>
        <button className="privacy-upgrade-action tertiary" disabled={working} onClick={() => void review()}><ShieldCheck size={16}/>{t('privacy.upgrade.review')}</button>
      </div>

      <div className="privacy-upgrade-foot"><ShieldCheck size={14}/><span>{t('privacy.upgrade.dismissHelp')}</span></div>
      {error?.text && <div className="privacy-upgrade-error" role="alert" data-server-text={error.server}>{error.text}</div>}
    </section>
  </div>;
}
