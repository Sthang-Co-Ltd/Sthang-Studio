import { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { type CaptionProject, type ExportEvidence, type ProcessingJob } from '@kcs/shared';
import { appearanceComparisonBasis, type ReconciledAppearance } from '../caption-appearance-reconciliation';
import './export-history.css';

export const EXPORT_HISTORY_UPDATED = 'sthang:export-history-updated';
async function fingerprint(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

type ComparisonState = { owner: string; basis: string; values: Record<string, string>; pending: string[]; failed: string[] };

/** Retry only failed hashes of the same content; unknown appearance is not a hash failure. */
function useExportComparisons(owner: string, basis: string) {
  const inputs = useMemo(() => JSON.parse(basis) as Array<[string, string | null]>, [basis]);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<ComparisonState>({ owner: '', basis: '', values: {}, pending: [], failed: [] });
  const observed = useRef(state);
  observed.current = state;
  const request = useRef<symbol | null>(null);
  const current: ComparisonState = state.owner === owner && state.basis === basis ? state
    : { owner, basis, values: {}, pending: inputs.filter(([, value]) => value !== null).map(([format]) => format), failed: [] };

  useEffect(() => {
    const token = Symbol('export comparison');
    request.current = token;
    let cancelled = false;
    const previous = observed.current.owner === owner && observed.current.basis === basis ? observed.current : null;
    const values = { ...previous?.values };
    const needed = inputs.filter(([format, value]) => value !== null && !values[format]);
    const pending = needed.map(([format]) => format);
    setState({ owner, basis, values, pending, failed: previous?.failed || [] });
    void Promise.all(needed.map(async ([format, value]) => {
      try { return { format, value: await fingerprint(value!) }; }
      catch { return { format, value: null }; }
    })).then((results) => {
      if (cancelled || request.current !== token) return;
      const failed = [];
      for (const result of results) {
        if (result.value !== null) values[result.format] = result.value;
        else failed.push(result.format);
      }
      request.current = null;
      setState({ owner, basis, values, pending: [], failed });
    });
    return () => { cancelled = true; if (request.current === token) request.current = null; };
  }, [owner, basis, attempt]);

  const retry = () => {
    if (request.current || current.pending.length || !current.failed.length) return false;
    // Set synchronously: two activations before React renders still make one attempt.
    request.current = Symbol('queued export comparison');
    setState({ ...current, pending: current.failed });
    setAttempt((value) => value + 1);
    return true;
  };
  return { ...current, retry };
}

export function ExportHistory({ project, appearance, appearanceRecovery, activeJobId }: {
  project: CaptionProject;
  appearance: ReconciledAppearance;
  appearanceRecovery?: { message: string; actionLabel: string; onRecover(trigger: HTMLButtonElement, focusTarget: HTMLElement | null): void };
  activeJobId?: string;
}) {
  const { t, tn } = useI18n();
  const [history, setHistory] = useState({ projectId: project.id, entries: [] as ExportEvidence[], loaded: false, loading: true, error: false });
  const { entries, loaded, loading, error } = history.projectId === project.id ? history
    : { entries: [] as ExportEvidence[], loaded: false, loading: true, error: false };
  const [refresh, setRefresh] = useState(0);
  const summary = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const update = () => setRefresh((value) => value + 1);
    window.addEventListener(EXPORT_HISTORY_UPDATED, update);
    return () => window.removeEventListener(EXPORT_HISTORY_UPDATED, update);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setHistory((current) => ({ projectId: project.id, entries: current.projectId === project.id ? current.entries : [],
      loaded: current.projectId === project.id && current.loaded, loading: true, error: false }));
    void fetch(`/api/caption-handoff/${encodeURIComponent(project.id)}/export-history`, { signal: controller.signal, cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        const value = await response.json();
        if (!Array.isArray(value) || value.length > 9 || !value.every((entry) => entry?.version === 1
          && ['srt', 'vtt', 'ttml', 'word-srt', 'word-vtt', 'ass', 'data', 'bundle', 'video'].includes(entry.format)
          && typeof entry.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(entry.fingerprint)
          && typeof entry.preparedAt === 'string' && Number.isFinite(Date.parse(entry.preparedAt)))) throw new Error();
        if (!controller.signal.aborted) setHistory({ projectId: project.id, entries: value, loaded: true, loading: false, error: false });
      }).catch(() => { if (!controller.signal.aborted) setHistory((current) => ({ ...current, loading: false, error: true })); });
    return () => controller.abort();
  }, [project.id, activeJobId, refresh]);
  const basis = useMemo(() => JSON.stringify(entries.map((entry) => {
    try { return [entry.format, appearanceComparisonBasis(project, entry.format, appearance)]; }
    catch { return [entry.format, null]; }
  })), [entries, appearance, project.captions, project.captionAppearance, project.media.filename, project.media.size, project.media.mimeType, project.transcript, project.transcriptNeedsSync]);
  const comparison = useExportComparisons(project.id, basis);
  const comparisons = comparison.values;
  const changed = entries.filter((entry) => comparisons[entry.format] && comparisons[entry.format] !== entry.fingerprint).length;
  const retained = loaded && (loading || error);
  return <details className="export-history">
    <summary ref={summary}>{retained ? t('export.history.lastLoaded') : changed > 0 ? t('export.history.needsUpdating', { count: changed }) : t('export.history.title')}</summary>
    <p>{t('export.history.description')}</p>
    {appearanceRecovery && <div role="status"><p>{t('export.history.withPlainAvailable', { message: appearanceRecovery.message })}</p><button type="button" onClick={(event) => appearanceRecovery.onRecover(event.currentTarget, summary.current)}>{appearanceRecovery.actionLabel}</button></div>}
    <div className="export-history-toolbar"><p role="status">{loading ? loaded ? t('export.history.refreshing') : t('export.history.loading') : loaded ? tn('export.history.recorded', entries.length) : t('export.history.unavailable')}</p>
      <button type="button" aria-disabled={loading || undefined} onClick={() => { if (!loading) setRefresh((value) => value + 1); }}>{error ? t('export.history.retry') : t('export.history.refresh')}</button></div>
    {error && <p className="export-history-error" role="alert">{t(loaded ? 'export.history.refreshError' : 'export.history.loadError')}</p>}
    {comparison.failed.length > 0 && <div className="export-comparison-recovery">
      <p role="status">{comparison.pending.length ? t('export.history.retryingComparison') : t('export.history.comparisonError')}</p>
      <button type="button" aria-disabled={comparison.pending.length > 0 || undefined} aria-busy={comparison.pending.length > 0 || undefined}
        onClick={() => { if (comparison.retry()) summary.current?.focus({ preventScroll: true }); }}>{t('export.history.retryComparison')}</button>
    </div>}
    {entries.length > 0 && <ul aria-busy={loading}>{entries.map((entry) => {
      const freshness = comparison.pending.includes(entry.format) ? t('export.history.checking')
        : !comparisons[entry.format] ? t('export.history.unknown')
          : comparisons[entry.format] === entry.fingerprint ? t('export.history.matches') : t('export.history.changed');
      return <li key={entry.format}>
        <strong>{entry.format === 'video' ? t('export.history.video') : entry.format.toUpperCase()}</strong>
        <time dateTime={entry.preparedAt}>{t('export.history.prepared', { date: new Date(entry.preparedAt).toLocaleString() })}</time>
        <span>{retained ? t('export.history.lastLoadedRecord', { status: freshness }) : freshness}</span>
      </li>;
    })}</ul>}
    {loaded && !loading && !error && !entries.length && <p>{t('export.history.empty')}</p>}
  </details>;
}

export function ExportJobFreshness({ job, project, appearance }: { job: ProcessingJob; project?: CaptionProject; appearance: ReconciledAppearance }) {
  const { t } = useI18n();
  const basis = useMemo(() => {
    try { return project?.id === job.projectId ? appearanceComparisonBasis(project, 'video', appearance) || '' : ''; } catch { return ''; }
  }, [appearance, job.projectId, project?.id, project?.captions, project?.captionAppearance, project?.media, project?.transcript, project?.transcriptNeedsSync]);
  const comparison = useExportComparisons(`${job.id}:${project?.id || ''}`, JSON.stringify([['video', basis && job.exportContentFingerprint ? basis : null]]));
  const label = useRef<HTMLElement | null>(null);
  const value = comparison.values.video;
  return <><small ref={label} tabIndex={-1} className="export-job-freshness" role="status">{!job.exportContentFingerprint ? t('export.history.noReceipt')
    : project?.id !== job.projectId ? t('export.history.openProject')
    : !basis ? appearance.status === 'pending' ? t('export.history.checking') : t('export.history.unknown')
    : comparison.failed.includes('video') && !comparison.pending.length ? t('export.history.unknown')
    : !value ? t('export.history.checking')
    : value === job.exportContentFingerprint ? t('export.history.matches') : t('export.history.earlierVideo')}</small>
    {comparison.failed.length > 0 && <button type="button" className="export-comparison-retry"
      aria-disabled={comparison.pending.length > 0 || undefined} aria-busy={comparison.pending.length > 0 || undefined}
      onClick={() => { if (comparison.retry()) label.current?.focus({ preventScroll: true }); }}>{t('export.history.retryComparison')}</button>}
  </>;
}
