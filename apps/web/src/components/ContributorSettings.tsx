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
import { useI18n } from '../i18n';
import { reconcileProfileAcknowledgement } from '../profile-state';

interface ContributorSettingsProps {
  profile: AppProfile;
  busy: boolean;
  showIntro?: boolean;
  onSave(patch: Partial<AppProfile>): Promise<AppProfile | null>;
}

type PrivacyChoice = 'analyticsConsent' | 'khmerContributionConsent';

function consentPresentation(consent: ConsentState) {
  if (consent === 'granted') return { labelKey: 'privacy.consent.on', tone: 'on' } as const;
  if (consent === 'declined') return { labelKey: 'privacy.consent.off', tone: 'off' } as const;
  return { labelKey: 'privacy.consent.unset', tone: 'unset' } as const;
}

function durationParts(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return { minutes, seconds: String(seconds % 60).padStart(2, '0') };
}

export function ContributorSettings({ profile, busy, showIntro = true, onSave }: ContributorSettingsProps) {
  const { t } = useI18n();
  const [profileSnapshot, setProfileSnapshot] = useState({ owner: profile, value: profile });
  // A newer parent profile takes precedence immediately, including before effects run.
  const liveProfile = profileSnapshot.owner === profile ? profileSnapshot.value : profile;
  const [status, setStatus] = useState<ContributionStatus | null>(null);
  const [working, setWorking] = useState<PrivacyChoice | 'withdraw' | ''>('');
  const [reading, setReading] = useState(true);
  const [readError, setReadError] = useState<'profile' | 'contribution' | null>(null);
  const [hasReadFailure, setHasReadFailure] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState<{ text: string; server?: boolean } | null>(null);
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
    setReadError(null);
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
        setReadError(readProfile ? 'profile' : 'contribution');
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
    setError(null);
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
      setMessage(t(key === 'analyticsConsent'
        ? (consent === 'granted' ? 'privacy.saved.analyticsOn' : 'privacy.saved.analyticsOff')
        : (consent === 'granted' ? 'privacy.saved.contributionOn' : 'privacy.saved.contributionOff')));
    } catch {
      if (owns()) setError({ text: t('privacy.saveFailed') });
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
    if (!window.confirm(t('privacy.withdraw.confirm'))) return;
    const token = Symbol('contribution withdrawal');
    const basis = currentProfile.current;
    mutationRequest.current = token;
    acknowledgedParents.current = [];
    readRequest.current = null;
    setReading(false);
    setWorking('withdraw');
    setMessage('');
    setError(null);
    const owns = () => mounted.current && mutationRequest.current === token;
    try {
      const nextStatus = await api.withdrawContributions();
      if (!owns()) return;
      setStatus(nextStatus);
      acceptChoice(basis, 'khmerContributionConsent', nextStatus.consent);
    } catch (reason) {
      if (owns()) setError(reason instanceof Error ? { text: reason.message, server: true } : { text: t('privacy.withdraw.failed') });
    } finally {
      if (owns()) {
        mutationRequest.current = null;
        setWorking('');
        void refresh();
      }
    }
  };

  const readErrorKey = readError === 'profile'
    ? (status ? 'privacy.status.privacyFailedWithProgress' : 'privacy.status.privacyFailed')
    : (status ? 'privacy.status.contributionFailedWithProgress' : 'privacy.status.contributionFailed');
  const contributionConsent = liveProfile.preferences.khmerContributionConsent || 'unset';
  const analyticsConsent = liveProfile.preferences.analyticsConsent || 'unset';
  const contributionState = consentPresentation(contributionConsent);
  const analyticsState = consentPresentation(analyticsConsent);
  const disabled = busy || Boolean(working);

  return <div className="privacy-settings">
    {showIntro && <div className="privacy-intro">
      <div className="privacy-intro-icon"><ShieldCheck size={22}/></div>
      <div>
        <strong>{t('privacy.title')}</strong>
        <span>{t('privacy.description')}</span>
      </div>
    </div>}

    <section className="privacy-card privacy-card-contributor">
      <div className="privacy-card-layout">
        <div className="privacy-card-icon" aria-hidden="true"><HandHeart size={25}/></div>
        <div className="privacy-card-content">
          <header className="privacy-card-heading">
            <div className="privacy-card-title">
              <strong>{t('privacy.contributor.title')}</strong>
            </div>
            <span className={`privacy-status-chip status-${contributionState.tone}`}>
              <i aria-hidden="true"/>{t(contributionState.labelKey)}
            </span>
          </header>

          <p className="privacy-value-line">{t('privacy.contributor.purpose')}</p>
          <p className="privacy-description">{t('privacy.contributor.data')}</p>

          <div className="privacy-boundary">
            <LockKeyhole size={17}/>
            <span>{t('privacy.contributor.exclusions')}</span>
          </div>

          {status && <div className="contributor-stats" aria-label={t('privacy.contributor.progress')}>
            <div><span className="privacy-stat-icon"><CheckCircle2 size={17}/></span><b>{status.verified}</b><span>{t('privacy.contributor.verified')}</span></div>
            <div><span className="privacy-stat-icon"><AudioLines size={17}/></span><b>{t('privacy.contributor.duration', durationParts(status.verifiedAudioMs))}</b><span>{t('privacy.contributor.speech')}</span></div>
            <div><span className="privacy-stat-icon"><Clock3 size={17}/></span><b>{status.submitted}</b><span>{t('privacy.contributor.submitted')}</span></div>
            <div><span className="privacy-stat-icon"><Clock3 size={17}/></span><b>{status.queued}</b><span>{t('privacy.contributor.queued')}</span></div>
          </div>}

          {(reading || readError || hasReadFailure) && <div className={`privacy-note${readError ? ' warning' : ''}`}>
            <p className="privacy-description" role={readError ? 'alert' : 'status'}>{reading
              ? (status ? t('privacy.status.refreshing') : t('privacy.status.loading'))
              : readError ? t(readErrorKey) : (working ? t('privacy.status.wait') : t('privacy.status.refreshed'))}</p>
            {hasReadFailure && <div className="privacy-choice-row"><button className="privacy-choice-button privacy-choice-secondary"
              aria-disabled={reading || disabled || undefined} aria-busy={reading || undefined}
              onClick={() => { if (!disabled) void refresh(retryReadsProfile.current); }}>
              {reading ? t('privacy.status.checking') : readError ? t('privacy.status.retry') : t('privacy.status.refresh')}
            </button></div>}
          </div>}

          {status && !status.endpointConfigured && <div className="privacy-note">{t('privacy.contributor.unconfigured')}</div>}
          {status?.lastError && <div className="privacy-note warning" data-server-text>{status.lastError}</div>}

          <div className="privacy-choice-row">
            <button
              className={`privacy-choice-button privacy-choice-primary privacy-choice-contributor ${contributionConsent === 'granted' ? 'is-selected' : ''}`}
              disabled={disabled}
              aria-pressed={contributionConsent === 'granted'}
              onClick={() => void savePrivacy('khmerContributionConsent', 'granted')}
            >
              {contributionConsent === 'granted' ? <CheckCircle2 size={18}/> : <HandHeart size={18}/>}<span>{contributionConsent === 'granted' ? t('privacy.contributor.enabled') : t('privacy.helpImprove')}</span>
            </button>
            <button
              className={`privacy-choice-button privacy-choice-secondary ${contributionConsent === 'declined' ? 'is-selected' : ''}`}
              disabled={disabled}
              aria-pressed={contributionConsent === 'declined'}
              onClick={() => void savePrivacy('khmerContributionConsent', 'declined')}
            >
              <LockKeyhole size={18}/><span>{t('privacy.keepPrivate')}</span>
            </button>
          </div>

          <div className="privacy-choice-helper"><ShieldCheck size={14}/><span>{t('privacy.contributor.choiceHelp')}</span></div>

          {status && (status.submitted > 0 || status.verified > 0 || status.withdrawalPending) && <div className="privacy-destructive-row">
            <button className="privacy-delete-button" disabled={disabled} onClick={() => void withdraw()}><Trash2 size={15}/>{t('privacy.withdraw.request')}</button>
            <span>{t('privacy.withdraw.help')}</span>
          </div>}
          {status?.withdrawalPending && <div className="privacy-note warning">{t('privacy.withdraw.pending')}</div>}
        </div>
      </div>
    </section>

    <section className="privacy-card privacy-card-analytics">
      <div className="privacy-card-layout">
        <div className="privacy-card-icon" aria-hidden="true"><BarChart3 size={25}/></div>
        <div className="privacy-card-content">
          <header className="privacy-card-heading">
            <div className="privacy-card-title"><strong>{t('privacy.analytics.title')}</strong></div>
            <span className={`privacy-status-chip status-${analyticsState.tone}`}>
              <i aria-hidden="true"/>{t(analyticsState.labelKey)}
            </span>
          </header>

          <p className="privacy-value-line">{t('privacy.analytics.purpose')}</p>
          <p className="privacy-description">{t('privacy.analytics.description')}</p>

          <div className="privacy-boundary">
            <LockKeyhole size={17}/>
            <span>{t('privacy.analytics.data')}</span>
          </div>

          <div className="privacy-choice-row">
            <button
              className={`privacy-choice-button privacy-choice-primary privacy-choice-analytics ${analyticsConsent === 'granted' ? 'is-selected' : ''}`}
              disabled={disabled}
              aria-pressed={analyticsConsent === 'granted'}
              onClick={() => void savePrivacy('analyticsConsent', 'granted')}
            >
              {analyticsConsent === 'granted' ? <CheckCircle2 size={18}/> : <BarChart3 size={18}/>}<span>{analyticsConsent === 'granted' ? t('privacy.analytics.enabled') : t('privacy.analytics.enable')}</span>
            </button>
            <button
              className={`privacy-choice-button privacy-choice-secondary ${analyticsConsent === 'declined' ? 'is-selected' : ''}`}
              disabled={disabled}
              aria-pressed={analyticsConsent === 'declined'}
              onClick={() => void savePrivacy('analyticsConsent', 'declined')}
            >
              <ShieldCheck size={18}/><span>{t('privacy.analytics.keepOff')}</span>
            </button>
          </div>

          <div className="privacy-choice-helper"><ShieldCheck size={14}/><span>{t('privacy.analytics.choiceHelp')}</span></div>
        </div>
      </div>
    </section>

    <div className="privacy-control-note"><ShieldCheck size={16}/><span>{t('privacy.choicesNote')}</span></div>
    {working && <p className="privacy-description" role="status">{working === 'withdraw' ? t('privacy.withdraw.requesting') : t('privacy.saving')}</p>}
    {message && <p className="privacy-description" role="status">{message}</p>}
    {error?.text && <div className="privacy-note warning"><p className="privacy-description" role="alert" data-server-text={error.server}>{error.text}</p></div>}
  </div>;
}
