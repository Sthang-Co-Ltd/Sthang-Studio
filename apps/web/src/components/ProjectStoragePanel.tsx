import type { ProjectStorageStatus } from '@kcs/shared';
import { storageNeedsAttention } from '../project-storage';
import './project-storage.css';

export function ProjectStoragePanel({ status, checking, error, onRecheck }: {
  status: ProjectStorageStatus | null; checking: boolean; error: string; onRecheck?(): void;
}) {
  const attention = storageNeedsAttention(status);
  const counts = status ? `${status.loadedProjectCount} loaded in this session · ${status.readableProjectCount} readable project files at last check` : '';
  return <section className="project-storage-report" aria-label="Saved project storage">
    <strong>Saved projects</strong>
    <p role="status" aria-live="polite" aria-atomic="true">{checking ? 'Checking saved project files…'
      : error ? `Storage check unavailable. ${status ? 'Last loaded results are shown.' : 'No recovery status is available yet.'}`
        : status ? `Storage check complete. ${counts}` : 'Storage has not been checked. No recovery status is available yet.'}</p>
    {error && <p role="alert">{error} Try the check again.</p>}
    {status ? <>
      {(checking || error) && <p>{counts}</p>}
      <ul>
        {status.unreadableProjectCount > 0 && <li>{status.unreadableProjectCount} project file{status.unreadableProjectCount === 1 ? '' : 's'} could not be read. Those files were kept.</li>}
        {status.missingProjectCount > 0 && <li>{status.missingProjectCount} indexed or previously loaded project file{status.missingProjectCount === 1 ? ' is' : 's are'} missing. Back up any work still available in this session before stopping Studio.</li>}
        {status.duplicateProjectCount > 0 && <li>{status.duplicateProjectCount} additional file{status.duplicateProjectCount === 1 ? '' : 's'} share a project identity. Keep the originals for comparison.</li>}
        {status.directoryUnreadable && <li>The project folder could not be listed.</li>}
        {status.orderUnreadable && <li>The project order could not be read. Its original file was kept.</li>}
        {status.legacyUnreadable && <li>Older project data could not be read completely.</li>}
        {status.migrationPending && <li>Project migration is incomplete. Existing source files were retained.</li>}
      </ul>
      {attention && <p>Back up your Studio state folder and download available unfinished edits. Stop Studio before restoring known-good copies, then restart. Keep the original files; do not reset or delete them.</p>}
      {status.restartRequired && <p>A recheck does not reload restored projects into this session. Restart Studio after recovery.</p>}
      {!attention && !checking && !error && <p>No project read errors were found at the last check. This does not verify backups or free disk space.</p>}
      <time dateTime={status.checkedAt}>Last checked {new Date(status.checkedAt).toLocaleString()}</time>
    </> : null}
    {onRecheck && <button type="button" disabled={checking} onClick={onRecheck}>Recheck saved projects</button>}
  </section>;
}
