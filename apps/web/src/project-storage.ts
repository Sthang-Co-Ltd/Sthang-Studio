import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProjectStorageStatus } from '@kcs/shared';
import { api } from './api';

export function storageNeedsAttention(status: ProjectStorageStatus | null) {
  return Boolean(status && (status.unreadableProjectCount || status.missingProjectCount || status.duplicateProjectCount || status.directoryUnreadable
    || status.orderUnreadable || status.legacyUnreadable || status.migrationPending || status.restartRequired));
}

function validStatus(value: ProjectStorageStatus) {
  return value?.schemaVersion === 1 && typeof value.checkedAt === 'string' && Number.isFinite(Date.parse(value.checkedAt))
    && ['loadedProjectCount', 'readableProjectCount', 'unreadableProjectCount', 'missingProjectCount', 'duplicateProjectCount']
      .every((key) => Number.isSafeInteger(value[key as keyof ProjectStorageStatus]) && Number(value[key as keyof ProjectStorageStatus]) >= 0)
    && ['directoryUnreadable', 'orderUnreadable', 'legacyUnreadable', 'migrationPending', 'restartRequired']
      .every((key) => typeof value[key as keyof ProjectStorageStatus] === 'boolean');
}

export function useProjectStorage(retryKey: number) {
  const [status, setStatus] = useState<ProjectStorageStatus | null>(null);
  const [checking, setChecking] = useState(true);
  // Failed verification survives toast dismissal and retry until a check succeeds.
  const [error, setError] = useState('');
  const [errorNoticeVisible, setErrorNoticeVisible] = useState(false);
  const sequence = useRef(0);
  const request = useRef<AbortController | null>(null);
  const check = useCallback(async (recheck: boolean) => {
    const ticket = ++sequence.current;
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setChecking(true); setErrorNoticeVisible(false);
    try {
      const value = await api.projectStorage(recheck, controller.signal);
      if (!validStatus(value)) throw new Error();
      if (ticket === sequence.current) { setStatus(value); setError(''); }
    } catch {
      if (ticket === sequence.current && !controller.signal.aborted) {
        setError('Saved project storage could not be checked. Your files were not changed.');
        setErrorNoticeVisible(true);
      }
    } finally { if (ticket === sequence.current) setChecking(false); }
  }, []);
  useEffect(() => {
    void check(false);
    return () => { sequence.current++; request.current?.abort(); };
  }, [retryKey, check]);
  return { status, checking, error, errorNotice: errorNoticeVisible ? error : '',
    recheck: () => check(true), dismissError: () => setErrorNoticeVisible(false) };
}
