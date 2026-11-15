import { useEffect, useRef, useState } from 'react';
import type { AppProfile, ConsentState, ContributionStatus } from '@kcs/shared';
import {
  BarChart3,
  CheckCircle2,
  Clock3,
  LockKeyhole,
  ShieldCheck,
  AudioLines,
  HandHeart,
  Trash2,
} from 'lucide-react';
import { api } from '../api';
import { reconcileProfileAcknowledgement } from '../profile-state';

interface ContributorSettingsProps {
  profile: AppProfile;
  busy: boolean;
  showIntro?: boolean;
  onSave(patch: Partial<AppProfile>): Promise<AppProfile | null>;
}

type PrivacyChoice = 'analyticsConsent' | 'khmerContributionConsent';

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

export function ContributorSettings({ profile, busy, showIntro = true, onSave }: ContributorSettingsProps) {
  const [profileSnapshot, setProfileSnapshot] = useState({ owner: profile, value: profile });
  // A newer parent profile takes precedence immediately, including before effects run.
  const liveProfile = profileSnapshot.owner === profile ? profileSnapshot.value : profile;
  const [status, setStatus] = useState<ContributionStatus | null>(null);
  const [working, setWorking] = useState<PrivacyChoice | 'withdraw' | ''>('');
  const [reading, setReading] = useState(true);
  const [readError, setReadError] = useState('');
  const [hasReadFailure, setHasReadFailure] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const mounted = useRef(true);
  const profileOwner = useRef(profile);
  profileOwner.current = profile;
  const currentProfile = useRef(liveProfile);
  currentProfile.current = liveProfile;
  const acknowledgedParents = useRef<AppProfile[]>([]);
  const retryReadsProfile = useRef(true);
  const readRequest = useRef<symbol | null>(null);
  const mutationRequest = useRef<symbol | null>(null);

  const refresh = async (readProfile = true) => {
    if (!mounted.current || readRequest.current || mutationRequest.current) return;
    const token = Symbol('privacy status read');
    const owner = profileOwner.current;
    readRequest.current = token;
    retryReadsProfile.current = readProfile;
    setReading(true);
    setReadError('');
    const owns = () => mounted.current && readRequest.current === token && profileOwner.current === owner && !mutationRequest.current;
    try {
      const [nextProfile, nextStatus] = await Promise.all([
        readProfile ? api.profile() : Promise.resolve(null),
        api.contributionStatus(),
      ]);
      if (!owns()) return;
      if (nextProfile) {
        currentProfile.current = nextProfile;
        setProfileSnapshot({ owner, value: nextProfile });
      }
      setStatus(nextStatus);
    } catch {
      if (owns()) {
        setReadError(readProfile
          ? 'Privacy choices and contribution status could not be refreshed. The last loaded choices are shown.'
          : 'Contribution status could not be refreshed. Your privacy choices are kept.');
        setHasReadFailure(true);
      }
    } finally {
      if (readRequest.current === token) {
        readRequest.current = null;
        if (mounted.current && profileOwner.current === owner) setReading(false);
      }
    }
  };

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; readRequest.current = null; mutationRequest.current = null; };
  }, []);
  useEffect(() => {
    const acknowledgements = acknowledgedParents.current;
    acknowledgedParents.current = [];
    readRequest.current = null;
    // Only this choice's reconciled parent acknowledgement can reuse its fresh
    // receipt. Other parent changes may still contain older privacy preferences.
    if (!mutationRequest.current) void refresh(!acknowledgements.some((acknowledged) => JSON.stringify(profile) === JSON.stringify(acknowledged)));
    else setReading(false);
    // A retry may have replaced the opening read. Release the whole old owner.
    return () => { readRequest.current = null; };
  }, [profile]);

  const acceptChoice = (basis: AppProfile, key: PrivacyChoice, consent: ConsentState) => {
    if (currentProfile.current.preferences[key] !== basis.preferences[key]) return;
    // A receipt acknowledges this choice only; keep unrelated newer preferences.
    const next = { ...currentProfile.current, preferences: { ...currentProfile.current.preferences, [key]: consent } };
    currentProfile.current = next;
    setProfileSnapshot({ owner: profileOwner.current, value: next });
  };

  const savePrivacy = async (key: PrivacyChoice, consent: ConsentState) => {
    if (mutationRequest.current || busy) return;
    const token = Symbol('privacy choice save');
    const owner = profileOwner.current;
    const basis = currentProfile.current;
    const patch = { preferences: { ...basis.preferences, [key]: consent } };
    mutationRequest.current = token;
    acknowledgedParents.current = [];
    readRequest.current = null;
    setReading(false);
    setWorking(key);
    setMessage('');
    setError('');
    const owns = () => mounted.current && mutationRequest.current === token;
    try {
      const saved = await onSave(patch);
      if (!owns()) return;
      if (!saved || saved.preferences[key] !== consent) throw new Error('Privacy choice was not acknowledged.');
      const parent = profileOwner.current;
      const acknowledgements = [saved, reconcileProfileAcknowledgement(parent, owner, saved, patch)];
      // The parent may already have committed its acknowledgement before this
      // continuation. Otherwise recognize its next transition by reconciled data,
      // not by identity with the raw receipt returned by onSave.
      acknowledgedParents.current = parent !== owner && acknowledgements.some((acknowledged) => JSON.stringify(parent) === JSON.stringify(acknowledged)) ? [] : acknowledgements;
      acceptChoice(basis, key, consent);
      setMessage(`${key === 'analyticsConsent' ? 'Product analytics' : 'Khmer Caption Contributor'} choice saved: ${consent === 'granted' ? 'on' : 'off'}.`);
    } catch {
      if (owns()) setError('Could not confirm your privacy choice was saved. Try that choice again.');
    } finally {
      if (owns()) {
        mutationRequest.current = null;
        setWorking('');
        void refresh(false);
      }
    }
  };

  const withdraw = async () => {
    if (mutationRequest.current || busy) return;
    if (!window.confirm('Stop contributing and request deletion of contribution data already sent to Sthang? Local caption projects are not deleted.')) return;
    const token = Symbol('contribution withdrawal');
    const basis = currentProfile.current;
    mutationRequest.current = token;
    acknowledgedParents.current = [];
    readRequest.current = null;
    setReading(false);
    setWorking('withdraw');
    setMessage('');
    setError('');
    const owns = () => mounted.current && mutationRequest.current === token;
    try {
      const nextStatus = await api.withdrawContributions();
      if (!owns()) return;
      setStatus(nextStatus);
      acceptChoice(basis, 'khmerContributionConsent', nextStatus.consent);
    } catch (reason) {
      if (owns()) setError(reason instanceof Error ? reason.message : 'Could not request contribution deletion.');
    } finally {
      if (owns()) {
        mutationRequest.current = null;
        setWorking('');
        void refresh();
      }
    }
  };

  const contributionConsent = liveProfile.preferences.khmerContributionConsent || 'unset';
  const analyticsConsent = liveProfile.preferences.analyticsConsent || 'unset';
  const contributionState = consentPresentation(contributionConsent);
  const analyticsState = consentPresentation(analyticsConsent);
  const disabled = busy || Boolean(working);

  return <div className="privacy-settings">
    {showIntro && <div className="privacy-intro">
      <div className="privacy-intro-icon"><ShieldCheck size={22}/></div>
      <div>
        <strong>Privacy &amp; contribution</strong>
        <span>Caption contribution and product analytics are separate. Both stay off until you enable them.</span>
      </div>
    </div>}

    <section className="privacy-card privacy-card-contributor">
      <div className="privacy-card-layout">
        <div className="privacy-card-icon" aria-hidden="true"><HandHeart size={25}/></div>
        <div className="privacy-card-content">
          <header className="privacy-card-heading">
            <div className="privacy-card-title">
              <strong>Khmer Caption Contributor</strong>
            </div>
            <span className={`privacy-status-chip status-${contributionState.tone}`}>
              <i aria-hidden="true"/>{contributionState.label}
            </span>
          </header>

          <p className="privacy-value-line">Help make Khmer captions world-class.</p>
          <p className="privacy-description">If you join, eligible corrections may send matching short audio, generated and corrected wording, timing, and technical quality evidence.</p>

          <div className="privacy-boundary">
            <LockKeyhole size={17}/>
            <span>This program excludes your full video, project name, filename, API key, topic context, correction memory, and unrelated captions. Corrections made before you join are not collected retroactively.</span>
          </div>

          {status && <div className="contributor-stats" aria-label="Khmer Caption Contributor progress">
            <div><span className="privacy-stat-icon"><CheckCircle2 size={17}/></span><b>{status.verified}</b><span>Verified corrections</span></div>
            <div><span className="privacy-stat-icon"><AudioLines size={17}/></span><b>{durationLabel(status.verifiedAudioMs)}</b><span>Verified Khmer speech</span></div>
            <div><span className="privacy-stat-icon"><Clock3 size={17}/></span><b>{status.submitted}</b><span>Awaiting verification</span></div>
            <div><span className="privacy-stat-icon"><Clock3 size={17}/></span><b>{status.queued}</b><span>Queued locally</span></div>
          </div>}

          {(reading || readError || hasReadFailure) && <div className={`privacy-note${readError ? ' warning' : ''}`}>
            <p className="privacy-description" role={readError ? 'alert' : 'status'}>{reading
              ? (status ? 'Refreshing contribution status…' : 'Loading contribution status…')
              : readError || (working ? 'Contribution status will refresh after this action.' : 'Contribution status refreshed.')}{readError && status ? ' The last loaded progress is shown.' : ''}</p>
            {hasReadFailure && <div className="privacy-choice-row"><button className="privacy-choice-button privacy-choice-secondary"
              aria-disabled={reading || disabled || undefined} aria-busy={reading || undefined}
              onClick={() => { if (!disabled) void refresh(retryReadsProfile.current); }}>
              {reading ? 'Checking status…' : readError ? 'Retry status' : 'Refresh status'}
            </button></div>}
          </div>}

          {status && !status.endpointConfigured && <div className="privacy-note">Contribution hosting is not configured in this build, so the program cannot upload correction audio even if you join.</div>}
          {status?.lastError && <div className="privacy-note warning">{status.lastError}</div>}

          <div className="privacy-choice-row">
            <button
              className={`privacy-choice-button privacy-choice-primary privacy-choice-contributor ${contributionConsent === 'granted' ? 'is-selected' : ''}`}
              disabled={disabled}
              aria-pressed={contributionConsent === 'granted'}
              onClick={() => void savePrivacy('khmerContributionConsent', 'granted')}
            >
              {contributionConsent === 'granted' ? <CheckCircle2 size={18}/> : <HandHeart size={18}/>}<span>{contributionConsent === 'granted' ? 'Helping improve Khmer captions' : 'Help improve Khmer captions'}</span>
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

          <div className="privacy-choice-helper"><ShieldCheck size={14}/><span>Change this choice anytime. Your access to Studio stays the same.</span></div>

          {status && (status.submitted > 0 || status.verified > 0 || status.withdrawalPending) && <div className="privacy-destructive-row">
            <button className="privacy-delete-button" disabled={disabled} onClick={() => void withdraw()}><Trash2 size={15}/>Request deletion</button>
            <span>Requests deletion of data already sent under this Contributor identity. Local projects stay on your computer.</span>
          </div>}
          {status?.withdrawalPending && <div className="privacy-note warning">Deletion is pending. The Sthang contribution service has not confirmed it yet.</div>}
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
          <p className="privacy-description">Share limited usage events to help Sthang understand the path from launch to caption export and improve the workflow.</p>

          <div className="privacy-boundary">
            <LockKeyhole size={17}/>
            <span>When enabled, Studio sends a random installation ID, approved event names, coarse workflow categories, and Studio/platform versions. Analytics excludes caption text, audio, filenames, project names, local paths, vocabulary or context text, SRT contents, and your Gemini API key. It is separate from Khmer Caption Contributor.</span>
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

    <div className="privacy-control-note"><ShieldCheck size={16}/><span>Both choices are saved separately on this computer. Neither limits Studio's caption features.</span></div>
    {working && <p className="privacy-description" role="status">{working === 'withdraw' ? 'Requesting contribution deletion…' : 'Saving your privacy choice…'}</p>}
    {message && <p className="privacy-description" role="status">{message}</p>}
    {error && <div className="privacy-note warning"><p className="privacy-description" role="alert">{error}</p></div>}
  </div>;
}
