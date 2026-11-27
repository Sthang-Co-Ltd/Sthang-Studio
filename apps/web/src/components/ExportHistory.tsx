import { useEffect, useMemo, useRef, useState } from 'react';
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
  const [history, setHistory] = useState({ projectId: project.id, entries: [] as ExportEvidence[], loaded: false, loading: true, error: '' });
  const { entries, loaded, loading, error } = history.projectId === project.id ? history
    : { entries: [] as ExportEvidence[], loaded: false, loading: true, error: '' };
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
      loaded: current.projectId === project.id && current.loaded, loading: true, error: '' }));
    void fetch(`/api/caption-handoff/${encodeURIComponent(project.id)}/export-history`, { signal: controller.signal, cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        const value = await response.json();
        if (!Array.isArray(value) || value.length > 9 || !value.every((entry) => entry?.version === 1
          && ['srt', 'vtt', 'ttml', 'word-srt', 'word-vtt', 'ass', 'data', 'bundle', 'video'].includes(entry.format)
          && typeof entry.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(entry.fingerprint)
          && typeof entry.preparedAt === 'string' && Number.isFinite(Date.parse(entry.preparedAt)))) throw new Error();
        if (!controller.signal.aborted) setHistory({ projectId: project.id, entries: value, loaded: true, loading: false, error: '' });
      }).catch(() => { if (!controller.signal.aborted) setHistory((current) => ({ ...current, loading: false,
        error: current.loaded ? 'Could not refresh export history. Last loaded records are shown; newer exports may be missing.' : 'Export history is unavailable. Freshness is unknown.' })); });
    return () => controller.abort();
  }, [project.id, activeJobId, refresh]);
  const basis = useMemo(() => JSON.stringify(entries.map((entry) => {
    try { return [entry.format, appearanceComparisonBasis(project, entry.format, appearance)]; }
    catch { return [entry.format, null]; }
  })), [entries, appearance, project.captions, project.captionAppearance, project.media.filename, project.media.size, project.media.mimeType, project.transcript, project.transcriptNeedsSync]);
  const comparison = useExportComparisons(project.id, basis);
  const comparisons = comparison.values;
  const changed = entries.filter((entry) => comparisons[entry.format] && comparisons[entry.format] !== entry.fingerprint).length;
  const retained = loaded && (loading || Boolean(error));
  return <details className="export-history">
    <summary ref={summary}>Export history{retained ? ' · last loaded' : changed > 0 ? ` · ${changed} need updating` : ''}</summary>
    <p>Compared with the open project, including unsaved edits. Preparing a file does not confirm it was saved to disk. Video comparisons retain that render’s output settings.</p>
    {appearanceRecovery && <div role="status"><p>{appearanceRecovery.message} Plain caption files are still available.</p><button type="button" onClick={(event) => appearanceRecovery.onRecover(event.currentTarget, summary.current)}>{appearanceRecovery.actionLabel}</button></div>}
    <div className="export-history-toolbar"><p role="status">{loading ? loaded ? 'Refreshing export history…' : 'Loading export history…' : loaded ? `${entries.length} recorded export${entries.length === 1 ? '' : 's'}` : 'Export history unavailable'}</p>
      <button type="button" aria-disabled={loading || undefined} onClick={() => { if (!loading) setRefresh((value) => value + 1); }}>{error ? 'Retry export history' : 'Refresh export history'}</button></div>
    {error && <p className="export-history-error" role="alert">{error}</p>}
    {comparison.failed.length > 0 && <div className="export-comparison-recovery">
      <p role="status">{comparison.pending.length ? 'Retrying export content comparison…' : 'Some export content could not be compared. Freshness remains unknown for those records.'}</p>
      <button type="button" aria-disabled={comparison.pending.length > 0 || undefined} aria-busy={comparison.pending.length > 0 || undefined}
        onClick={() => { if (comparison.retry()) summary.current?.focus({ preventScroll: true }); }}>Retry comparison</button>
    </div>}
    {entries.length > 0 && <ul aria-busy={loading}>{entries.map((entry) => <li key={entry.format}>
      <strong>{entry.format === 'video' ? 'Captioned video' : entry.format.toUpperCase()}</strong><time dateTime={entry.preparedAt}>Prepared {new Date(entry.preparedAt).toLocaleString()}</time>
      <span>{retained && 'Last loaded record: '}{comparison.pending.includes(entry.format) ? 'Checking export content…' : !comparisons[entry.format] ? 'Freshness unknown. Studio could not compare the current content.' : comparisons[entry.format] === entry.fingerprint ? 'Matches open project content.' : 'Changed since export. Export again to include current edits.'}</span>
    </li>)}</ul>}
    {loaded && !loading && !error && !entries.length && <p>No recorded exports. Earlier exports have unknown freshness.</p>}
  </details>;
}

export function ExportJobFreshness({ job, project, appearance }: { job: ProcessingJob; project?: CaptionProject; appearance: ReconciledAppearance }) {
  const basis = useMemo(() => {
    try { return project?.id === job.projectId ? appearanceComparisonBasis(project, 'video', appearance) || '' : ''; } catch { return ''; }
  }, [appearance, job.projectId, project?.id, project?.captions, project?.captionAppearance, project?.media, project?.transcript, project?.transcriptNeedsSync]);
  const comparison = useExportComparisons(`${job.id}:${project?.id || ''}`, JSON.stringify([['video', basis && job.exportContentFingerprint ? basis : null]]));
  const label = useRef<HTMLElement | null>(null);
  const value = comparison.values.video;
  return <><small ref={label} tabIndex={-1} className="export-job-freshness" role="status">{!job.exportContentFingerprint ? 'Freshness unknown. This earlier export has no receipt.'
    : project?.id !== job.projectId ? 'Open this project to compare export content.'
    : !basis ? appearance.status === 'pending' ? 'Checking export content…' : 'Freshness unknown. Studio could not compare the current content.'
    : comparison.failed.includes('video') && !comparison.pending.length ? 'Freshness unknown. Studio could not compare the current content.'
    : !value ? 'Checking export content…'
    : value === job.exportContentFingerprint ? 'Matches open project content.' : 'Changed since export. This video contains earlier content.'}</small>
    {comparison.failed.length > 0 && <button type="button" className="export-comparison-retry"
      aria-disabled={comparison.pending.length > 0 || undefined} aria-busy={comparison.pending.length > 0 || undefined}
      onClick={() => { if (comparison.retry()) label.current?.focus({ preventScroll: true }); }}>Retry comparison</button>}
  </>;
}
