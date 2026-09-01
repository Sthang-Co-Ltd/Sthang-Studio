import { useEffect, useState } from 'react';
import type { AppProfile, ConsentState, ContributionStatus } from '@kcs/shared';
import {
  BarChart3,
  CheckCircle2,
  Clock3,
  LockKeyhole,
  ShieldCheck,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { api } from '../api';

interface ContributorSettingsProps {
  profile: AppProfile;
  busy: boolean;
  onSave(patch: Partial<AppProfile>): void | Promise<void>;
}

function consentPresentation(consent: ConsentState) {
  if (consent === 'granted') return { label: 'On', tone: 'on' } as const;
  if (consent === 'declined') return { label: 'Off', tone: 'off' } as const;
  return { label: 'Not chosen', tone: 'unset' } as const;
}

function durationLabel(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
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
    setWorking(true);
    setError('');
    try {
      await onSave({ preferences: { ...liveProfile.preferences, [key]: consent } });
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Privacy preference update failed');
    } finally {
      setWorking(false);
    }
  };

  const withdraw = async () => {
    if (!window.confirm('Stop contributing and request deletion of contribution data already sent to Sthang? Local caption projects are not deleted.')) return;
    setWorking(true);
    setError('');
    try {
      setStatus(await api.withdrawContributions());
      setLiveProfile(await api.profile());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Withdrawal request failed');
    } finally {
      setWorking(false);
    }
  };

  const contributionConsent = liveProfile.preferences.khmerContributionConsent || 'unset';
  const analyticsConsent = liveProfile.preferences.analyticsConsent || 'unset';
  const contributionState = consentPresentation(contributionConsent);
  const analyticsState = consentPresentation(analyticsConsent);
  const disabled = busy || working;

  return <div className="privacy-settings">
    <div className="privacy-intro">
      <div className="privacy-intro-icon"><ShieldCheck size={22}/></div>
      <div>
        <strong>Privacy &amp; contribution</strong>
        <span>Caption contribution and product analytics are separate choices. Both stay off unless you explicitly turn them on.</span>
      </div>
    </div>

    <section className="privacy-card privacy-card-contributor">
      <div className="privacy-card-layout">
        <div className="privacy-card-icon" aria-hidden="true"><Sparkles size={25}/></div>
        <div className="privacy-card-content">
          <header className="privacy-card-heading">
            <div className="privacy-card-title">
              <strong>Khmer Caption Contributor</strong>
              <span className="privacy-country-badge">KH</span>
            </div>
            <span className={`privacy-status-chip status-${contributionState.tone}`}>
              <i aria-hidden="true"/>{contributionState.label}
            </span>
          </header>

          <p className="privacy-value-line">Help make Khmer captions world-class.</p>
          <p className="privacy-description">After you join, eligible caption corrections can contribute only the matching short audio, generated wording, corrected wording, timing, and technical quality evidence.</p>

          <div className="privacy-boundary">
            <LockKeyhole size={17}/>
            <span>Studio does not contribute your full video, project name, filename, API key, topic context, correction memory, or unrelated captions through this program. Corrections made before you join are not collected retroactively.</span>
          </div>

          {status && <div className="contributor-stats" aria-label="Khmer Caption Contributor progress">
            <div><span className="privacy-stat-icon"><CheckCircle2 size={17}/></span><b>{status.verified}</b><span>Verified corrections</span></div>
            <div><span className="privacy-stat-icon"><Sparkles size={17}/></span><b>{durationLabel(status.verifiedAudioMs)}</b><span>Verified Khmer speech</span></div>
            <div><span className="privacy-stat-icon"><Clock3 size={17}/></span><b>{status.submitted}</b><span>Awaiting verification</span></div>
            <div><span className="privacy-stat-icon"><Clock3 size={17}/></span><b>{status.queued}</b><span>Queued locally</span></div>
          </div>}

          {status && !status.endpointConfigured && <div className="privacy-note">Contribution hosting is not configured in this build, so no correction audio can leave your computer even if you join.</div>}
          {status?.lastError && <div className="privacy-note warning">{status.lastError}</div>}

          <div className="privacy-choice-row">
            <button
              className={`privacy-choice-button privacy-choice-primary privacy-choice-contributor ${contributionConsent === 'granted' ? 'is-selected' : ''}`}
              disabled={disabled}
              aria-pressed={contributionConsent === 'granted'}
              onClick={() => void savePrivacy('khmerContributionConsent', 'granted')}
            >
              {contributionConsent === 'granted' ? <CheckCircle2 size={18}/> : <Sparkles size={18}/>}<span>{contributionConsent === 'granted' ? 'Helping improve Khmer captions' : 'Help improve Khmer captions'}</span>
            </button>
            <button
              className={`privacy-choice-button privacy-choice-secondary ${contributionConsent === 'declined' ? 'is-selected' : ''}`}
              disabled={disabled}
              aria-pressed={contributionConsent === 'declined'}
              onClick={() => void savePrivacy('khmerContributionConsent', 'declined')}
            >
              <LockKeyhole size={18}/><span>Keep my work private</span>
            </button>
          </div>

          <div className="privacy-choice-helper"><ShieldCheck size={14}/><span>You can change this choice anytime. It does not affect access to Studio.</span></div>

          {status && (status.submitted > 0 || status.verified > 0 || status.withdrawalPending) && <div className="privacy-destructive-row">
            <button className="privacy-delete-button" disabled={disabled} onClick={() => void withdraw()}><Trash2 size={15}/>Request deletion</button>
            <span>Removes contribution data already sent under this Contributor identity. Local projects stay on your computer.</span>
          </div>}
          {status?.withdrawalPending && <div className="privacy-note warning">Deletion is pending until the Sthang contribution service can confirm the request.</div>}
        </div>
      </div>
    </section>

    <section className="privacy-card privacy-card-analytics">
      <div className="privacy-card-layout">
        <div className="privacy-card-icon" aria-hidden="true"><BarChart3 size={25}/></div>
        <div className="privacy-card-content">
          <header className="privacy-card-heading">
            <div className="privacy-card-title"><strong>Optional product analytics</strong></div>
            <span className={`privacy-status-chip status-${analyticsState.tone}`}>
              <i aria-hidden="true"/>{analyticsState.label}
            </span>
          </header>

          <p className="privacy-value-line">Help us build a better Studio.</p>
          <p className="privacy-description">Optionally share a small allow-listed set of usage events so Sthang can measure whether Studio gets creators from launch to a successful caption export and which workflow stages need improvement.</p>

          <div className="privacy-boundary">
            <LockKeyhole size={17}/>
            <span>When enabled, Studio creates a random analytics installation ID and sends only event names plus coarse technical buckets. Analytics never includes caption text, audio, filenames, project names, local paths, vocabulary/context text, exports, or your Gemini API key. It is independent from Khmer Caption Contributor.</span>
          </div>

          <div className="privacy-choice-row">
            <button
              className={`privacy-choice-button privacy-choice-primary privacy-choice-analytics ${analyticsConsent === 'granted' ? 'is-selected' : ''}`}
              disabled={disabled}
              aria-pressed={analyticsConsent === 'granted'}
              onClick={() => void savePrivacy('analyticsConsent', 'granted')}
            >
              {analyticsConsent === 'granted' ? <CheckCircle2 size={18}/> : <BarChart3 size={18}/>}<span>{analyticsConsent === 'granted' ? 'Product analytics is on' : 'Share product analytics'}</span>
            </button>
            <button
              className={`privacy-choice-button privacy-choice-secondary ${analyticsConsent === 'declined' ? 'is-selected' : ''}`}
              disabled={disabled}
              aria-pressed={analyticsConsent === 'declined'}
              onClick={() => void savePrivacy('analyticsConsent', 'declined')}
            >
              <ShieldCheck size={18}/><span>Keep analytics off</span>
            </button>
          </div>

          <div className="privacy-choice-helper"><ShieldCheck size={14}/><span>You can change this choice anytime in Settings.</span></div>
        </div>
      </div>
    </section>

    <div className="privacy-control-note"><ShieldCheck size={16}/><span>Your choices are saved on this computer, remain separate, and never limit access to Studio's core caption features.</span></div>
    {error && <div className="privacy-note warning" role="alert">{error}</div>}
  </div>;
}
