import { useI18n } from '../i18n';
import { formatInterfaceDate } from '../i18n/dates';
import type { ProjectStorageStatus } from '@kcs/shared';
import { storageNeedsAttention } from '../project-storage';
import './project-storage.css';

export function ProjectStoragePanel({ status, checking, error, onRecheck }: {
  status: ProjectStorageStatus | null; checking: boolean; error: string; onRecheck?(): void;
}) {
  const { locale, t, tn } = useI18n();
  const attention = storageNeedsAttention(status);
  const counts = { loaded: status?.loadedProjectCount ?? 0, readable: status?.readableProjectCount ?? 0 };
  return <section className="project-storage-report" aria-label={t('library.storageLabel')}>
    <strong>{t('library.storageTitle')}</strong>
    <p role="status" aria-live="polite" aria-atomic="true">{checking ? t('library.storageChecking')
      : error ? t(status ? 'library.storageStale' : 'library.storageUnavailable')
        : status ? t('library.storageCompleted', counts) : t('library.storageUnchecked')}</p>
    {error && <p role="alert">{t('library.storageRetryHelp', { error })}</p>}
    {status ? <>
      {(checking || error) && <p>{t('library.storageCounts', counts)}</p>}
      <ul>
        {status.unreadableProjectCount > 0 && <li>{tn('library.storageUnreadable', status.unreadableProjectCount)}</li>}
        {status.missingProjectCount > 0 && <li>{tn('library.storageMissing', status.missingProjectCount)}</li>}
        {status.duplicateProjectCount > 0 && <li>{tn('library.storageDuplicate', status.duplicateProjectCount)}</li>}
        {status.directoryUnreadable && <li>{t('library.storageFolderUnreadable')}</li>}
        {status.orderUnreadable && <li>{t('library.storageOrderUnreadable')}</li>}
        {status.legacyUnreadable && <li>{t('library.storageLegacyUnreadable')}</li>}
        {status.migrationPending && <li>{t('library.storageMigrationPending')}</li>}
      </ul>
      {attention && <p>{t('library.storageBackupHelp')}</p>}
      {status.restartRequired && <p>{t('library.storageRestart')}</p>}
      {!attention && !checking && !error && <p>{t('library.storageHealthy')}</p>}
      <time dateTime={status.checkedAt}>{t('library.storageLastChecked', { date: formatInterfaceDate(locale, status.checkedAt, { time: true }) })}</time>
    </> : null}
    {onRecheck && <button type="button" aria-disabled={checking || undefined} aria-busy={checking || undefined} onClick={() => { if (!checking) onRecheck(); }}>{t('library.storageRecheck')}</button>}
  </section>;
}
