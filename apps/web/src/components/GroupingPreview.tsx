import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { CaptionMode, CaptionProject, GroupingPassage } from '@kcs/shared';
import { ChevronDown } from 'lucide-react';
import { api, ApiRequestError } from '../api';
import { useI18n } from '../i18n';
import { formatTimestamp } from '../timestamp';
import './grouping-preview.css';

interface Props {
  project: CaptionProject;
  mode: CaptionMode;
  limit: number;
  time: number;
  dirty: boolean;
  outdated: boolean;
  revision: string;
  onStale(revision: string): void;
  children(open: boolean, blocked: boolean, preview?: { atMs: number; digest: string }): ReactNode;
}

export function GroupingPreview({ project, mode, limit, time, dirty, revision, outdated, onStale, children }: Props) {
  const { t } = useI18n();
  const panelId = useId();
  const toggle = useRef<HTMLButtonElement>(null);
  const [atMs, setAtMs] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ key: string; data: GroupingPassage | null } | null>(null);
  const { id, updatedAt, media: { filename, size } } = project;
  const key = JSON.stringify([id, filename, size, updatedAt, mode, limit, atMs, dirty, outdated, attempt]);
  useEffect(() => {
    if (atMs === null || dirty || outdated) return;
    const controller = new AbortController();
    // Coalesce keyboard and pointer edits to the character limit. The playhead
    // is sampled only when opening, so playback never drives preview requests.
    const timer = window.setTimeout(async () => {
      try {
        const data = await api.previewGrouping(id, mode, limit, { filename, size }, updatedAt, atMs, controller.signal);
        if (!controller.signal.aborted) setResult({ key, data });
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof ApiRequestError && error.code === 'GROUPING_PREVIEW_STALE') onStale(revision);
        else setResult({ key, data: null });
      }
    }, 160);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [id, filename, size, mode, limit, atMs, updatedAt, dirty, outdated, onStale, revision, key]);
  const ready = result?.key === key ? result : null;
  const data = ready?.data;
  return <>
    <div className="grouping-preview">
      <button ref={toggle} type="button" className="grouping-preview-toggle" aria-expanded={atMs !== null} aria-controls={panelId}
        onClick={() => { setResult(null); setAtMs(atMs === null ? Math.max(0, Math.round(time * 1000)) : null); }}>
        <span>{t('grouping.preview')}</span><ChevronDown size={16} aria-hidden="true"/>
      </button>
      <div id={panelId} hidden={atMs === null}>
        {data ? <>
          <p className="grouping-preview-time">{formatTimestamp(data.startMs)} – {formatTimestamp(data.endMs)}</p>
          {(['current', 'proposed'] as const).map(side => <section key={side} className="grouping-preview-side">
            <h4>{t(`grouping.${side}`)}</h4>
            {data[side].length ? <ul>{data[side].map((cue, index) => <li key={index}>
              <span>{cue.text}</span><small>{formatTimestamp(cue.startMs)} – {formatTimestamp(cue.endMs)}</small>
            </li>)}</ul> : <p>{t('grouping.emptyPreview')}</p>}
          </section>)}
        </> : atMs !== null && !outdated && <p role="status">{t(dirty ? 'grouping.saveFirst' : ready ? 'grouping.previewUnavailable' : 'grouping.loadingPreview')}
          {ready && <button type="button" onClick={() => { toggle.current?.focus({ preventScroll: true }); setAttempt(n => n + 1); }}>{t('grouping.retry')}</button>}</p>}
      </div>
      {outdated && <p role="status">{t('grouping.reopen')}</p>}
    </div>
    {children(atMs !== null, outdated || (atMs !== null && !data), data && atMs !== null ? { atMs, digest: data.digest } : undefined)}
  </>;
}
