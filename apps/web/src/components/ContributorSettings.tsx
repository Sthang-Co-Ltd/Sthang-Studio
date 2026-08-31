import { useEffect, useState } from 'react';
import type { AppProfile, ConsentState, ContributionStatus } from '@kcs/shared';
import { BarChart3, ShieldCheck, Sparkles, Trash2 } from 'lucide-react';
import { api } from '../api';

interface ContributorSettingsProps {
  profile: AppProfile;
  busy: boolean;
  onSave(patch: Partial<AppProfile>): void | Promise<void>;
}

function consentLabel(consent: ConsentState) {
  if (consent === 'granted') return 'On';
  if (consent === 'declined') return 'Off';
  return 'Not chosen';
}

export function ContributorSettings({ profile, busy, onSave }: ContributorSettingsProps) {
  const [liveProfile, setLiveProfile] = useState(profile);
  const [status, setStatus] = useState<ContributionStatus | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');

  const refresh = async () => {
    const [nextProfile, nextStatus] = await Promise.all([api.profile(), api.contributionStatus()]);
    setLiveProfile(nextProfile);
    setStatus(nextStatus);
  };

  useEffect(() => {
    setLiveProfile(profile);
    void refresh().catch(() => {});
  }, [profile.updatedAt]);

  const savePrivacy = async (key: 'analyticsConsent' | 'khmerContributionConsent', consent: ConsentState) => {
    setWorking(true); setError('');
    try {
      await onSave({ preferences: { ...liveProfile.preferences, [key]: consent } });
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Privacy preference update failed');
    } finally { setWorking(false); }
  };

  const withdraw = async () => {
    if (!window.confirm('Stop contributing and request deletion of contribution data already sent to Sthang? Local caption projects are not deleted.')) return;
    setWorking(true); setError('');
    try {
      setStatus(await api.withdrawContributions());
      setLiveProfile(await api.profile());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Withdrawal request failed');
    } finally { setWorking(false); }
  };

  const contributionConsent = liveProfile.preferences.khmerContributionConsent || 'unset';
  const analyticsConsent = liveProfile.preferences.analyticsConsent || 'unset';
  const disabled = busy || working;

  return <div className="privacy-settings">
    <div className="privacy-intro">
      <ShieldCheck size={24}/>
      <div><strong>Privacy & contribution</strong><span>Caption contribution and product analytics are separate choices. Both stay off unless you explicitly turn them on.</span></div>
    </div>

    <section className="privacy-card contributor-card">
      <div className="privacy-card-head"><Sparkles size={19}/><div><strong>Khmer Caption Contributor 🇰🇭</strong><span>{consentLabel(contributionConsent)}</span></div></div>
      <p><b>Help make Khmer captions world-class.</b> After you join, eligible caption corrections can contribute only the matching short audio, the generated wording, your corrected wording, timing, and technical quality evidence.</p>
      <p className="privacy-fine">Studio does not contribute your full video, project name, filename, API key, topic context, correction memory, or unrelated captions through this program. Corrections made before you join are not collected retroactively.</p>
      {status && <div className="contributor-stats">
        <div><b>{status.verified}</b><span>verified corrections</span></div>
        <div><b>{status.submitted}</b><span>awaiting verification</span></div>
        <div><b>{status.queued}</b><span>queued locally</span></div>
      </div>}
      {status && !status.endpointConfigured && <div className="privacy-note">Contribution hosting is not configured in this build, so no correction audio can leave your computer even if you join.</div>}
      <div className="privacy-actions">
        <button className={contributionConsent === 'granted' ? 'primary' : ''} disabled={disabled} onClick={() => void savePrivacy('khmerContributionConsent', 'granted')}>Help improve Khmer captions</button>
        <button disabled={disabled} onClick={() => void savePrivacy('khmerContributionConsent', 'declined')}>Keep my work private</button>
        {status && (status.submitted > 0 || status.verified > 0 || status.withdrawalPending) && <button className="danger-quiet" disabled={disabled} onClick={() => void withdraw()}><Trash2 size={14}/>Request deletion</button>}
      </div>
      {status?.withdrawalPending && <div className="privacy-note warning">Deletion is pending until the Sthang contribution service can confirm the request.</div>}
    </section>

    <section className="privacy-card">
      <div className="privacy-card-head"><BarChart3 size={19}/><div><strong>Anonymous product analytics</strong><span>{consentLabel(analyticsConsent)}</span></div></div>
      <p>Optionally share a small allow-listed set of usage events so Sthang can measure whether Studio gets creators from launch to a successful caption export and which workflow stages need improvement.</p>
      <p className="privacy-fine">Analytics never includes caption text, audio, filenames, project names, local paths, vocabulary/context text, exports, or your Gemini API key. This setting is independent from Khmer Caption Contributor.</p>
      <div className="privacy-actions">
        <button className={analyticsConsent === 'granted' ? 'primary' : ''} disabled={disabled} onClick={() => void savePrivacy('analyticsConsent', 'granted')}>Share product analytics</button>
        <button disabled={disabled} onClick={() => void savePrivacy('analyticsConsent', 'declined')}>Keep analytics off</button>
      </div>
    </section>

    {error && <div className="privacy-note warning">{error}</div>}
  </div>;
}
