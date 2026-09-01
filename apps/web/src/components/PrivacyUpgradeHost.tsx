import { useEffect, useRef, useState } from 'react';
import { PRIVACY_UPGRADE_NOTICE_VERSION } from '@kcs/shared';
import type { AppProfile, ConsentState } from '@kcs/shared';
import { BarChart3, LockKeyhole, ShieldCheck, Sparkles, X } from 'lucide-react';
import { api } from '../api';
import { CONTRIBUTION_PROMPT_SESSION_KEY, shouldShowPrivacyUpgradeNotice } from '../privacy-onboarding';
import { ContributorSettings } from './ContributorSettings';
import './contribution.css';

export function PrivacyUpgradeHost() {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<'intro' | 'review'>('intro');
  const [profile, setProfile] = useState<AppProfile | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const primaryRef = useRef<HTMLButtonElement | null>(null);

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

  useEffect(() => {
    if (!open || view !== 'intro') return;
    window.setTimeout(() => primaryRef.current?.focus(), 0);
  }, [open, view]);

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
    setError('');
    try {
      await saveResolution(consent);
      setOpen(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not save your privacy choice');
    } finally {
      setWorking(false);
    }
  };

  const dismiss = async () => {
    if (working) return;
    setWorking(true);
    setError('');
    try {
      await saveResolution();
      setOpen(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not save this notice');
    } finally {
      setWorking(false);
    }
  };

  const review = async () => {
    setWorking(true);
    setError('');
    try {
      await saveResolution();
      setView('review');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not open privacy choices');
    } finally {
      setWorking(false);
    }
  };

  const saveReviewPatch = async (patch: Partial<AppProfile>) => {
    const updated = await api.patchProfile(patch);
    setProfile(updated);
  };

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      if (view === 'review') setOpen(false);
      else void dismiss();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [open, view, working]);

  if (!open || !profile) return null;

  if (view === 'review') {
    return <div className="privacy-upgrade-backdrop">
      <section className="privacy-upgrade-dialog review-mode" role="dialog" aria-modal="true" aria-labelledby="privacy-upgrade-review-title">
        <button className="privacy-upgrade-close" aria-label="Close privacy settings" onClick={() => setOpen(false)}><X size={19}/></button>
        <header className="privacy-upgrade-review-head">
          <span aria-hidden="true"><ShieldCheck size={20}/></span>
          <div><strong id="privacy-upgrade-review-title">Privacy choices</strong><small>Contribution and product analytics remain separate. You can change either choice later in Settings → Privacy.</small></div>
        </header>
        <ContributorSettings profile={profile} busy={working} onSave={saveReviewPatch}/>
      </section>
    </div>;
  }

  return <div className="privacy-upgrade-backdrop">
    <section className="privacy-upgrade-dialog" role="dialog" aria-modal="true" aria-labelledby="privacy-upgrade-title" aria-describedby="privacy-upgrade-description">
      <button className="privacy-upgrade-close" aria-label="Not now" disabled={working} onClick={() => void dismiss()}><X size={19}/></button>

      <div className="privacy-upgrade-hero">
        <div className="privacy-upgrade-mark" aria-hidden="true"><ShieldCheck size={29}/></div>
        <span className="privacy-upgrade-kicker">What’s new in Studio 0.8</span>
        <h2 id="privacy-upgrade-title">Help make Khmer captions world-class 🇰🇭</h2>
        <p id="privacy-upgrade-description">Because this Studio installation predates the new Contributor option, we’re asking once before it can collect anything.</p>
      </div>

      <div className="privacy-upgrade-facts">
        <div className="privacy-upgrade-fact">
          <span aria-hidden="true"><Sparkles size={18}/></span>
          <div><strong>Contributor is optional</strong><small>If you join, only eligible corrections you make after joining can contribute the matching short audio, generated and corrected wording, timing, and technical quality evidence.</small></div>
        </div>
        <div className="privacy-upgrade-fact">
          <span aria-hidden="true"><LockKeyhole size={18}/></span>
          <div><strong>Your project stays private</strong><small>Full videos, project names, filenames, API keys, topic context, correction memory, and unrelated captions are not contributed through this program.</small></div>
        </div>
        <div className="privacy-upgrade-fact">
          <span aria-hidden="true"><BarChart3 size={18}/></span>
          <div><strong>Product analytics is separate</strong><small>Analytics stays off unless you choose it separately. Joining Contributor never turns analytics on.</small></div>
        </div>
      </div>

      <div className="privacy-upgrade-actions">
        <button ref={primaryRef} className="privacy-upgrade-action primary" disabled={working} onClick={() => void choose('granted')}><Sparkles size={18}/>Help improve Khmer captions</button>
        <button className="privacy-upgrade-action" disabled={working} onClick={() => void choose('declined')}><LockKeyhole size={18}/>Keep my work private</button>
        <button className="privacy-upgrade-action tertiary" disabled={working} onClick={() => void review()}><ShieldCheck size={16}/>Review privacy &amp; analytics settings</button>
      </div>

      <div className="privacy-upgrade-foot"><ShieldCheck size={14}/><span>Closing this one-time notice keeps both choices off. You can change them later in Settings → Privacy.</span></div>
      {error && <div className="privacy-upgrade-error" role="alert">{error}</div>}
    </section>
  </div>;
}
