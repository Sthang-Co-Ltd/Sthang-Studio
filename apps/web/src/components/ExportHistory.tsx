import { useEffect, useMemo, useState } from 'react';
import { type CaptionProject, type ExportEvidence, type ProcessingJob } from '@kcs/shared';
import { appearanceComparisonBasis, type ReconciledAppearance } from '../caption-appearance-reconciliation';
import './export-history.css';

export const EXPORT_HISTORY_UPDATED = 'sthang:export-history-updated';
async function fingerprint(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function ExportHistory({ project, appearance, appearanceRecovery, activeJobId }: {
  project: CaptionProject;
  appearance: ReconciledAppearance;
  appearanceRecovery?: { message: string; actionLabel: string; onRecover(): void };
  activeJobId?: string;
}) {
  const [entries, setEntries] = useState<ExportEvidence[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [comparison, setComparison] = useState<{ basis: string; values: Record<string, string> }>({ basis: '', values: {} });
  useEffect(() => {
    const update = () => setRefresh((value) => value + 1);
    window.addEventListener(EXPORT_HISTORY_UPDATED, update);
    return () => window.removeEventListener(EXPORT_HISTORY_UPDATED, update);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(''); setEntries([]);
    void fetch(`/api/caption-handoff/${encodeURIComponent(project.id)}/export-history`, { signal: controller.signal, cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        const value = await response.json();
        if (!Array.isArray(value) || value.length > 9 || !value.every((entry) => entry?.version === 1
          && ['srt', 'vtt', 'ttml', 'word-srt', 'word-vtt', 'ass', 'data', 'bundle', 'video'].includes(entry.format)
          && typeof entry.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(entry.fingerprint)
          && typeof entry.preparedAt === 'string' && Number.isFinite(Date.parse(entry.preparedAt)))) throw new Error();
        if (!controller.signal.aborted) setEntries(value);
      }).catch(() => { if (!controller.signal.aborted) setError('Export history is unavailable. Freshness is unknown.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [project.id, activeJobId, refresh]);
  const basis = useMemo(() => JSON.stringify(entries.map((entry) => {
    try { return [entry.format, appearanceComparisonBasis(project, entry.format, appearance)]; }
    catch { return [entry.format, null]; }
  })), [entries, appearance, project.captions, project.captionAppearance, project.media.filename, project.media.size, project.media.mimeType, project.transcript, project.transcriptNeedsSync]);
  useEffect(() => {
    let cancelled = false;
    void Promise.all((JSON.parse(basis) as Array<[string, string | null]>).map(async ([format, value]) => [format, value === null ? '' : await fingerprint(value)]))
      .then((values) => { if (!cancelled) setComparison({ basis, values: Object.fromEntries(values) }); })
      .catch(() => { if (!cancelled) setComparison({ basis, values: {} }); });
    return () => { cancelled = true; };
  }, [basis]);
  const comparisons = comparison.basis === basis ? comparison.values : {};
  const changed = entries.filter((entry) => comparisons[entry.format] && comparisons[entry.format] !== entry.fingerprint).length;
  return <details className="export-history">
    <summary>Export history{changed > 0 ? ` · ${changed} need updating` : ''}</summary>
    <p>Compared with the open project, including unsaved edits. Preparing a file does not confirm it was saved to disk. Video comparisons retain that render’s output settings.</p>
    {appearanceRecovery && <div role="status"><p>{appearanceRecovery.message} Plain caption files are still available.</p><button type="button" onClick={appearanceRecovery.onRecover}>{appearanceRecovery.actionLabel}</button></div>}
    {loading ? <p role="status">Loading export history…</p> : error ? <div role="status"><p>{error}</p><button onClick={() => setRefresh((value) => value + 1)}>Retry export history</button></div> : entries.length ? <ul>{entries.map((entry) => <li key={entry.format}>
      <strong>{entry.format === 'video' ? 'Captioned video' : entry.format.toUpperCase()}</strong><time dateTime={entry.preparedAt}>Prepared {new Date(entry.preparedAt).toLocaleString()}</time>
      <span>{!comparisons[entry.format] ? 'Freshness unknown — current content could not be compared.' : comparisons[entry.format] === entry.fingerprint ? 'Matches open project content.' : 'Changed since export — export again to include current edits.'}</span>
    </li>)}</ul> : <p>No recorded exports. Earlier exports have unknown freshness.</p>}
  </details>;
}

export function ExportJobFreshness({ job, project, appearance }: { job: ProcessingJob; project?: CaptionProject; appearance: ReconciledAppearance }) {
  const basis = useMemo(() => {
    try { return project?.id === job.projectId ? appearanceComparisonBasis(project, 'video', appearance) || '' : ''; } catch { return ''; }
  }, [appearance, job.projectId, project?.id, project?.captions, project?.captionAppearance, project?.media, project?.transcript, project?.transcriptNeedsSync]);
  const [checked, setChecked] = useState({ basis: '', fingerprint: '' });
  useEffect(() => {
    let cancelled = false;
    if (basis && job.exportContentFingerprint) void fingerprint(basis)
      .then((value) => { if (!cancelled) setChecked({ basis, fingerprint: value }); }).catch(() => {});
    return () => { cancelled = true; };
  }, [basis, job.exportContentFingerprint]);
  const value = checked.basis === basis ? checked.fingerprint : '';
  return <small className="export-job-freshness">{!job.exportContentFingerprint ? 'Freshness unknown — this earlier export has no receipt.'
    : project?.id !== job.projectId ? 'Open this project to compare export content.'
    : !basis ? appearance.status === 'pending' ? 'Checking export content…' : 'Freshness unknown — current content could not be compared.'
    : !value ? 'Checking export content…'
    : value === job.exportContentFingerprint ? 'Matches open project content.' : 'Changed since export — this video contains earlier content.'}</small>;
}
