import type { CaptionEdgeRepair } from '@kcs/shared';
import { useI18n } from '../i18n';
import { formatTimestamp } from '../timestamp';

export function TimingRepairDiagram({ repair, selectedId }: { repair: CaptionEdgeRepair; selectedId: string }) {
  const { t } = useI18n();
  const rows = repair.before.flatMap(before => {
    const after = repair.after.find(cue => cue.id === before.id);
    return after ? [{ before, after }] : [];
  }).sort((a, b) => a.before.startMs - b.before.startMs);
  const selected = rows.findIndex(row => row.before.id === selectedId);
  if (selected < 0) return null;
  const start = Math.min(...rows.map(({ before, after }) => Math.min(before.startMs, after.startMs)));
  const end = Math.max(...rows.map(({ before, after }) => Math.max(before.endMs, after.endMs)));
  if (end <= start) return null;
  const position = (time: number) => `${(time - start) * 100 / (end - start)}%`;
  return <figure className="timing-repair-diagram">
    <figcaption>
      <span><i className="repair-legend-interval" aria-hidden="true"/>{t('timing.words.repairCurrent')}</span>
      <span><i className="repair-legend-edge" aria-hidden="true"/>{t('timing.words.repairProposed')}</span>
    </figcaption>
    <ol>{rows.map(({ before, after }, index) => {
      const changed = (['startMs', 'endMs'] as const).filter(edge => before[edge] !== after[edge]);
      return <li key={before.id}>
        <strong>{t(index === selected ? 'timing.words.repairSelectedCaption' : index < selected ? 'timing.waveform.previousCaption' : 'timing.waveform.nextCaption')}</strong>
        <span className="repair-caption-text">{before.text}</span>
        <div className="repair-scale" aria-hidden="true">
          <span className="repair-interval" style={{ left: position(before.startMs), right: `${100 * (end - before.endMs) / (end - start)}%` }}/>
          {changed.map(edge => <i key={edge} className="repair-marker" style={{ left: position(after[edge]) }}/>)}
        </div>
        {changed.map(edge => {
          const delta = Math.round(after[edge]) - Math.round(before[edge]);
          return <small key={edge}>{t('timing.words.repairEdgeChange', {
            edge: t(edge === 'startMs' ? 'timing.start' : 'timing.end'),
            before: formatTimestamp(before[edge]), after: formatTimestamp(after[edge]),
            delta: delta < 0 ? `−${Math.abs(delta)}` : delta > 0 ? `+${delta}` : '0',
          })}</small>;
        })}
      </li>;
    })}</ol>
  </figure>;
}
