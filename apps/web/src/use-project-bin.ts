import { useEffect, useRef, useState } from 'react';
import type { CaptionProjectSummary } from '@kcs/shared';
import { api, ApiRequestError, type BinnedProject, type ProjectBinReceipt } from './api';

import type { MessageKey, MessageParams } from './i18n/types';

const binErrorMessages = new Map<string, BinNotice>([
  ['job_active', { message: "Finish or cancel this project's active work in Activity, then try again.", messageMetadata: { key: 'notices.bin.jobActive' } }],
  ['storage_blocked', { message: "Studio can't change saved projects right now.", messageMetadata: { key: 'notices.bin.storageBlocked' } }],
  ['expired', { message: "This project can no longer be restored.", messageMetadata: { key: 'notices.bin.expired' } }],
  ['purging', { message: "This project is being removed.", messageMetadata: { key: 'notices.bin.purging' } }],
  ['purge_incomplete', { message: "Studio could not finish removing this project. It will try again automatically.", messageMetadata: { key: 'notices.bin.purgeIncomplete' } }],
]);
const binFallbackMessages = {
  refreshed: { message: "This item changed. The list has been updated.", messageMetadata: { key: 'notices.bin.itemRefreshed' } },
  notRefreshed: { message: "This item changed. Try loading Recently deleted again.", messageMetadata: { key: 'notices.bin.itemRetry' } },
  move: { message: "Studio could not move this project. It was not changed.", messageMetadata: { key: 'notices.bin.moveFailed' } },
  restore: { message: "Studio could not restore this project.", messageMetadata: { key: 'notices.bin.restoreFailed' } },
  delete: { message: "Studio could not delete this project.", messageMetadata: { key: 'notices.bin.deleteFailed' } },
  unconfirmed: { message: "Studio could not confirm the move. Check All projects and Recently deleted.", messageMetadata: { key: 'notices.bin.moveUnconfirmed' } },
} as const satisfies Record<string, BinNotice>;

export function projectBinErrorNotice(code: string | undefined, operation: 'move' | 'restore' | 'delete', refreshed = false): BinNotice {
  const notice = code === 'instance_mismatch'
    ? (refreshed ? binFallbackMessages.refreshed : binFallbackMessages.notRefreshed)
    : (code && binErrorMessages.get(code)) || binFallbackMessages[operation];
  return { ...notice, reviewStorage: code === 'storage_blocked' };
}

type BinState = { items: BinnedProject[]; status: 'loading' | 'ready' | 'error' };
type BinMessage = { key: MessageKey; params?: MessageParams };
type BinNotice = { message: string; messageMetadata: BinMessage; reviewStorage?: boolean };
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
  onNotice(message: string, metadata: BinMessage): void;
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
    setNotice(projectBinErrorNotice(code, operation, refreshed));
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
        setNotice(binFallbackMessages.unconfirmed);
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
      onNotice(`Restored “${project.title}”.`, { key: 'notices.bin.restored', params: { title: project.title } });
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
      onNotice(`“${item.title}” was deleted.`, { key: 'notices.bin.deleted', params: { title: item.title } });
      return true;
    } catch (error) {
      report(error, 'delete', await refresh());
      return false;
    }
  });

  return { ...bin, refresh, pendingId, expiredInstances, move, restore, remove, notice, dismissNotice: () => setNotice(null), undo, dismissUndo };
}
