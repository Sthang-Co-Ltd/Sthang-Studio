import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { exportContentBasis, normalizeCaptionAppearance, type CaptionAppearance, type CaptionProject, type ExportEvidenceFormat } from '@kcs/shared';
import { api } from './api';
import { waitForCaptionAppearanceSaves } from './caption-appearance-save';
import { projectMediaKey, type ProjectTicket } from './project-scope';

export type ReconciledAppearance =
  | { status: 'pending' }
  | { status: 'error'; error: 'save' | 'load' | 'source' }
  | { status: 'ready'; appearance: CaptionAppearance };
export interface AppearanceReconciliation {
  value: ReconciledAppearance;
  refresh(): Promise<CaptionAppearance | null>;
}

/** Read only appearance after all local writes settle. Never adopt another
 * response's captions/context, or an appearance belonging to replaced media. */
export async function reconcileCaptionAppearance(project: CaptionProject, options: {
  flush?: () => Promise<boolean>;
  wait?: typeof waitForCaptionAppearanceSaves;
  load?: typeof api.get;
} = {}): Promise<ReconciledAppearance> {
  const expected = projectMediaKey(project);
  const projectId = project.id;
  const media = { ...project.media };
  try {
    if (options.flush && !await options.flush()) return { status: 'error', error: 'save' };
    if (!await (options.wait || waitForCaptionAppearanceSaves)(projectId, media)) return { status: 'error', error: 'save' };
    const fresh = await (options.load || api.get)(projectId);
    if (projectMediaKey(fresh) !== expected) return { status: 'error', error: 'source' };
    return { status: 'ready', appearance: normalizeCaptionAppearance(fresh.captionAppearance) };
  } catch { return { status: 'error', error: 'load' }; }
}

/** Plain caption files remain comparable even when saved styling is unknown. */
export function appearanceComparisonBasis(project: CaptionProject, format: ExportEvidenceFormat, value: ReconciledAppearance): string | null {
  const styled = ['video', 'ass', 'data', 'bundle'].includes(format);
  if (styled && value.status !== 'ready') return null;
  return exportContentBasis(value.status === 'ready' ? { ...project, captionAppearance: value.appearance } : project, format);
}

/** One scoped saved-look authority for Export and Activity. The render token
 * masks an old value before effects run; the request number rejects late reads. */
export function useReconciledAppearance(project: CaptionProject | null, ticket: ProjectTicket, active: boolean,
  liveRevision: unknown, flush: RefObject<(() => Promise<boolean>) | null>): AppearanceReconciliation {
  const mediaKey = projectMediaKey(project);
  const token = useMemo(() => ({}), [ticket, mediaKey, project?.captionAppearance, active, liveRevision]);
  const currentToken = useRef(token);
  currentToken.current = token;
  const request = useRef(0);
  const [state, setState] = useState<{ token: object; value: ReconciledAppearance } | null>(null);
  const refresh = useCallback(async () => {
    if (!project || currentToken.current !== token) return null;
    const attempt = ++request.current;
    setState({ token, value: { status: 'pending' } });
    const value = await reconcileCaptionAppearance(project, { flush: flush.current || undefined });
    if (currentToken.current !== token || request.current !== attempt) return null;
    setState({ token, value });
    return value.status === 'ready' ? value.appearance : null;
  }, [token]);
  useEffect(() => {
    if (active) void refresh();
    return () => { request.current += 1; };
  }, [active, refresh]);
  return { value: state?.token === token ? state.value : { status: 'pending' }, refresh };
}
