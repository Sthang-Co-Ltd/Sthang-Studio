import { useEffect, useState } from 'react';
import { ShieldCheck, HandHeart, X } from 'lucide-react';
import { api } from '../api';
import { messagesFor, type Locale } from '../i18n';
import { readInterfaceLanguage } from '../i18n/language-storage';
import { CONTRIBUTION_PROMPT_SESSION_KEY } from '../privacy-onboarding';
import './contribution.css';

export function ContributionPromptHost() {
  const [open, setOpen] = useState(false);
  const [locale, setLocale] = useState<Locale>('en');
  const { t, tr } = messagesFor(locale);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<{ text: string; server?: boolean } | null>(null);

  useEffect(() => {
    let disposed = false;
    const maybeOffer = async () => {
      try {
        if (sessionStorage.getItem(CONTRIBUTION_PROMPT_SESSION_KEY) === '1') return;
        const [profile, status] = await Promise.all([api.profile(), api.contributionStatus()]);
        if (disposed || !status.endpointConfigured) return;
        if ((profile.preferences.khmerContributionConsent || 'unset') !== 'unset') return;
        sessionStorage.setItem(CONTRIBUTION_PROMPT_SESSION_KEY, '1');
        setLocale(profile.preferences.interfaceLanguage ?? readInterfaceLanguage() ?? 'en');
        setOpen(true);
      } catch {
        // Contribution onboarding is optional and must never interfere with export.
      }
    };
    const onClick = (event: MouseEvent) => {
      const target = event.target as Element | null;
      const anchor = target?.closest?.('a[href*="/export.srt"]') as HTMLAnchorElement | null;
      if (!anchor) return;
      window.setTimeout(() => { void maybeOffer(); }, 0);
    };
    document.addEventListener('click', onClick, true);
    return () => { disposed = true; document.removeEventListener('click', onClick, true); };
  }, []);

  const choose = async (consent: 'granted' | 'declined') => {
    setWorking(true); setError(null);
    try {
      await api.patchProfile({ preferences: { khmerContributionConsent: consent } });
      setOpen(false);
    } catch (reason) {
      setError(reason instanceof Error ? { text: reason.message, server: true } : { text: t('privacy.invitation.saveFailed') });
    } finally { setWorking(false); }
  };

  if (!open) return null;
  return <aside className="contribution-prompt" aria-label={t('privacy.invitation.label')}>
    <button className="contribution-prompt-close" aria-label={t('privacy.invitation.dismiss')} onClick={() => setOpen(false)}><X size={17}/></button>
    <div className="contribution-prompt-icon"><HandHeart size={22}/></div>
    <div className="contribution-prompt-copy">
      <strong>{t('privacy.promptTitle')}</strong>
      <p>{t('privacy.invitation.purpose')}</p>
      <p className="contribution-prompt-detail"><ShieldCheck size={14}/>{tr('privacy.invitation.detail', {}, {})}</p>
    </div>
    <div className="contribution-prompt-actions">
      <button className="primary" disabled={working} onClick={() => void choose('granted')}>{t('privacy.invitation.join')}</button>
      <button disabled={working} onClick={() => void choose('declined')}>{t('privacy.keepPrivate')}</button>
    </div>
    {error?.text && <span className="contribution-prompt-error" data-server-text={error.server}>{error.text}</span>}
  </aside>;
}
