import { useEffect, useState } from 'react';
import { ShieldCheck, Sparkles, X } from 'lucide-react';
import { api } from '../api';
import { CONTRIBUTION_PROMPT_SESSION_KEY } from '../privacy-onboarding';
import './contribution.css';

export function ContributionPromptHost() {
  const [open, setOpen] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let disposed = false;
    const maybeOffer = async () => {
      try {
        if (sessionStorage.getItem(CONTRIBUTION_PROMPT_SESSION_KEY) === '1') return;
        const [profile, status] = await Promise.all([api.profile(), api.contributionStatus()]);
        if (disposed || !status.endpointConfigured) return;
        if ((profile.preferences.khmerContributionConsent || 'unset') !== 'unset') return;
        sessionStorage.setItem(CONTRIBUTION_PROMPT_SESSION_KEY, '1');
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
    setWorking(true); setError('');
    try {
      const profile = await api.profile();
      await api.patchProfile({ preferences: { ...profile.preferences, khmerContributionConsent: consent } });
      setOpen(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not save your choice');
    } finally { setWorking(false); }
  };

  if (!open) return null;
  return <aside className="contribution-prompt" aria-label="Khmer Caption Contributor invitation">
    <button className="contribution-prompt-close" aria-label="Dismiss for this session" onClick={() => setOpen(false)}><X size={17}/></button>
    <div className="contribution-prompt-icon"><Sparkles size={22}/></div>
    <div className="contribution-prompt-copy">
      <strong>Help make Khmer captions world-class</strong>
      <p>Your corrections can help improve Khmer caption technology for creators everywhere.</p>
      <p className="contribution-prompt-detail"><ShieldCheck size={14}/>If you join, Studio may share the short audio around eligible corrections you make <b>after joining</b>, together with generated and corrected text and timing. Full videos, project names, API keys, and unrelated captions are not contributed.</p>
    </div>
    <div className="contribution-prompt-actions">
      <button className="primary" disabled={working} onClick={() => void choose('granted')}>Help improve Khmer</button>
      <button disabled={working} onClick={() => void choose('declined')}>Keep my work private</button>
    </div>
    {error && <span className="contribution-prompt-error">{error}</span>}
  </aside>;
}
