import { useEffect, useRef, useState } from 'react';
import type { CaptionProjectSummary } from '@kcs/shared';
import { api, ApiRequestError, type BinnedProject, type ProjectBinReceipt } from './api';

type BinState = { items: BinnedProject[]; status: 'loading' | 'ready' | 'error' };
type BinNotice = { message: string; reviewStorage?: boolean };
type UndoMove = ProjectBinReceipt & { title: string };

export function canRestore(restoreUntil: string) {
  return Date.parse(restoreUntil) >= Date.now();
}

export function useProjectBin({
  active, onRead, onRemove, onRestore, onRefreshProjects, onNotice,
}: {
  active: boolean;
  onRead(items: BinnedProject[]): void;
  onRemove(id: string): void;
  onRestore(project: CaptionProjectSummary): void;
  onRefreshProjects(): Promise<void>;
  onNotice(message: string): void;
}) {
  const [bin, setBin] = useState<BinState>({ items: [], status: 'loading' });
  const [notice, setNotice] = useState<BinNotice | null>(null);
  const [undo, setUndo] = useState<UndoMove[]>([]);
  const [expiredInstances, setExpiredInstances] = useState<ReadonlySet<string>>(new Set());
  const request = useRef<AbortController | null>(null);
  const mutation = useRef<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  async function refresh() {
    request.current?.abort();
    const read = new AbortController();
    request.current = read;
    setBin((current) => ({ ...current, status: 'loading' }));
    try {
      const { items } = await api.listProjectBin(read.signal);
      if (read.signal.aborted) return false;
      onRead(items);
      setBin({ items, status: 'ready' });
      setUndo((moves) => moves.filter((move) => items.some((item) => item.instanceId === move.instanceId
        && !item.purging && canRestore(item.restoreUntil))));
      setExpiredInstances((current) => new Set(items.filter((item) => current.has(item.instanceId)).map((item) => item.instanceId)));
      return true;
    } catch {
      if (!read.signal.aborted) setBin({ items: [], status: 'error' });
      return false;
    } finally {
      if (request.current === read) request.current = null;
    }
  }

  useEffect(() => {
    if (active) void refresh();
  }, [active]);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    if (!undo.length) return;
    const deadline = Math.min(...undo.map((move) => Date.parse(move.restoreUntil)));
    const timer = window.setTimeout(() => setUndo((moves) => moves.filter((move) => canRestore(move.restoreUntil))),
      Math.min(Math.max(0, deadline - Date.now() + 1), 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [undo]);
  const dismissUndo = (instanceId: string) => setUndo((moves) => moves.filter((move) => move.instanceId !== instanceId));

  const change = async <T,>(id: string, run: () => Promise<T>) => {
    if (mutation.current) return;
    mutation.current = id;
    setPendingId(id);
    setNotice(null);
    try { return await run(); }
    finally { mutation.current = null; setPendingId(null); }
  };

  function report(error: unknown, operation: 'move' | 'restore' | 'delete', refreshed = false) {
    const code = error instanceof ApiRequestError ? error.code : undefined;
    const messages: Record<string, string> = {
      job_active: "Finish or cancel this project's active work in Activity, then try again.",
      storage_blocked: "Studio can't change saved projects right now.",
      expired: 'This project can no longer be restored.',
      purging: 'This project is being removed.',
      instance_mismatch: refreshed ? 'This item changed. The list has been updated.' : 'This item changed. Try loading Recently deleted again.',
      purge_incomplete: 'Studio could not finish removing this project. It will try again automatically.',
    };
    const fallback = operation === 'move'
      ? 'Studio could not move this project. It was not changed.'
      : operation === 'restore' ? 'Studio could not restore this project.' : 'Studio could not delete this project.';
    setNotice({ message: (code && messages[code]) || fallback, reviewStorage: code === 'storage_blocked' });
  }

  const move = (project: CaptionProjectSummary) => change(project.id, async () => {
    try {
      const receipt = await api.moveProjectToBin(project.id);
      onRemove(project.id);
      // One short-lived Undo, like Review: a newer move replaces the older offer.
      setUndo([{ ...receipt, title: project.title }]);
      void refresh();
      return true;
    } catch (error) {
      if (!(error instanceof ApiRequestError) || error.status >= 500) {
        // A lost acknowledgement can follow a committed move. Hide the old
        // active row until a new collection read establishes its membership.
        onRemove(project.id);
        void refresh();
        setNotice({ message: 'Studio could not confirm the move. Check All projects and Recently deleted.' });
      } else {
        if (error.status === 404) onRemove(project.id);
        report(error, 'move');
      }
      return false;
    }
  });

  const restore = (item: UndoMove) => change(item.id, async () => {
    try {
      if (!canRestore(item.restoreUntil) || expiredInstances.has(item.instanceId)) throw new ApiRequestError('', 409, 'expired');
      const project = await api.restoreBinnedProject(item.id, item.instanceId);
      dismissUndo(item.instanceId);
      setBin((current) => ({ ...current, items: current.items.filter((row) => row.instanceId !== item.instanceId) }));
      onRestore(project);
      void refresh();
      onNotice(`Restored “${project.title}”.`);
      return project;
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === 'expired') {
        setExpiredInstances((current) => new Set(current).add(item.instanceId));
        dismissUndo(item.instanceId);
      }
      void onRefreshProjects();
      const refreshed = await refresh();
      if (!refreshed) dismissUndo(item.instanceId);
      report(error, 'restore', refreshed);
    }
  });

  const remove = (item: BinnedProject, confirm: () => Promise<boolean>, onConfirmed: () => void) => change(item.id, async () => {
    if (!await confirm()) return false;
    onConfirmed();
    try {
      await api.deleteBinnedProject(item.id, item.instanceId);
      request.current?.abort();
      dismissUndo(item.instanceId);
      setBin((current) => ({ status: 'ready', items: current.items.filter((row) => row.instanceId !== item.instanceId) }));
      onNotice(`“${item.title}” was deleted.`);
      return true;
    } catch (error) {
      report(error, 'delete', await refresh());
      return false;
    }
  });

  return { ...bin, refresh, pendingId, expiredInstances, move, restore, remove, notice, dismissNotice: () => setNotice(null), undo, dismissUndo };
}
