import { useMemo, useState, type ChangeEvent, type RefObject } from 'react';
import { useI18n } from '../i18n';
import { hasWordTimingEvidence, highlightAttention, isVideoProject, resolveWordExport, type CaptionProject } from '@kcs/shared';
import { Download, ExternalLink, FileJson, PackageOpen, RotateCcw, TriangleAlert } from 'lucide-react';
import type { CaptionDestinationId, CaptionHandoffSession } from '../export-session';
import type { MessageKey } from '../i18n/types';
import './caption-handoff.css';

export type CaptionFileFormat = 'srt' | 'word-srt' | 'vtt' | 'word-vtt' | 'ttml' | 'ass' | 'data' | 'bundle';

export interface CaptionHandoffPanelProps {
  project: CaptionProject;
  busy: boolean;
  onExport(format: CaptionFileFormat): Promise<boolean>;
  downloadFocusTarget: RefObject<HTMLElement | null>;
  onImport(file: File, trigger: HTMLInputElement): Promise<void>;
  onEditWordTiming?(id?: string): void;
  onRenderedVideo?(): void;
  session: CaptionHandoffSession;
  onSessionChange(session: CaptionHandoffSession): void;
  saveBlocked?: boolean;
  invalidCaptions?: boolean;
  selectedFormatBlocked?: boolean;
  styledLayoutBlocked?: boolean;
}

type DestinationId = CaptionDestinationId;
type AdvancedFormat = Exclude<CaptionFileFormat, 'srt'>;
type HandoffMessage = Extract<MessageKey, `export.destinations.${string}` | `export.formats.${string}`>;
type DestinationBrand = 'CapCut Desktop' | 'CapCut Mobile' | 'Premiere Pro' | 'DaVinci Resolve' | 'Final Cut Pro';
type FormatToken = 'SRT' | 'WebVTT' | 'TTML' | 'ASS';

interface DestinationGuide {
  id: DestinationId;
  label: DestinationBrand | HandoffMessage;
  summary: HandoffMessage;
  steps: HandoffMessage[];
  note?: HandoffMessage;
  doc?: { label: HandoffMessage; href: string };
}

interface FormatGuide {
  id: AdvancedFormat;
  label: FormatToken | HandoffMessage;
  badge: string;
  description: HandoffMessage;
  requiresCompleteWords?: boolean;
}

const DESTINATIONS: DestinationGuide[] = [
  {
    id: 'capcut-desktop',
    label: 'CapCut Desktop',
    summary: 'export.destinations.capcut-desktop.summary',
    steps: [
      'export.destinations.capcut-desktop.step1',
      'export.destinations.capcut-desktop.step2',
      'export.destinations.capcut-desktop.step3',
    ],
    note: 'export.destinations.capcut-desktop.note',
    doc: { label: 'export.destinations.capcut-desktop.label', href: 'https://www.capcut.com/help/how-to-import-subtitles' },
  },
  {
    id: 'capcut-mobile',
    label: 'CapCut Mobile',
    summary: 'export.destinations.capcut-mobile.summary',
    steps: [
      'export.destinations.capcut-mobile.step1',
      'export.destinations.capcut-mobile.step2',
      'export.destinations.capcut-mobile.step3',
    ],
    note: 'export.destinations.capcut-mobile.note',
    doc: { label: 'export.destinations.capcut-mobile.label', href: 'https://www.capcut.com/help/how-to-import-subtitles' },
  },
  {
    id: 'premiere',
    label: 'Premiere Pro',
    summary: 'export.destinations.premiere.summary',
    steps: [
      'export.destinations.premiere.step1',
      'export.destinations.premiere.step2',
      'export.destinations.premiere.step3',
    ],
  },
  {
    id: 'resolve',
    label: 'DaVinci Resolve',
    summary: 'export.destinations.resolve.summary',
    steps: [
      'export.destinations.resolve.step1',
      'export.destinations.resolve.step2',
      'export.destinations.resolve.step3',
    ],
  },
  {
    id: 'final-cut',
    label: 'Final Cut Pro',
    summary: 'export.destinations.final-cut.summary',
    steps: [
      'export.destinations.final-cut.step1',
      'export.destinations.final-cut.step2',
      'export.destinations.final-cut.step3',
    ],
  },
  {
    id: 'web-other',
    label: 'export.destinations.web-other.label',
    summary: 'export.destinations.web-other.summary',
    steps: [
      'export.destinations.web-other.step1',
      'export.destinations.web-other.step2',
      'export.destinations.web-other.step3',
    ],
  },
  {
    id: 'subtitle-tools',
    label: 'export.destinations.subtitle-tools.label',
    summary: 'export.destinations.subtitle-tools.summary',
    steps: [
      'export.destinations.subtitle-tools.step1',
      'export.destinations.subtitle-tools.step2',
      'export.destinations.subtitle-tools.step3',
    ],
  },
];

const ADVANCED_FORMATS: FormatGuide[] = [
  {
    id: 'word-srt',
    label: 'export.formats.word-srt.label',
    badge: 'WORD SRT',
    description: 'export.formats.word-srt.description',
    requiresCompleteWords: true,
  },
  {
    id: 'vtt',
    label: 'WebVTT',
    badge: 'VTT',
    description: 'export.formats.vtt.description',
  },
  {
    id: 'word-vtt',
    label: 'export.formats.word-vtt.label',
    badge: 'WORD VTT',
    description: 'export.formats.word-vtt.description',
    requiresCompleteWords: true,
  },
  {
    id: 'ttml',
    label: 'TTML',
    badge: 'TTML',
    description: 'export.formats.ttml.description',
  },
  {
    id: 'ass',
    label: 'ASS',
    badge: 'ASS',
    description: 'export.formats.ass.description',
  },
  {
    id: 'data',
    label: 'export.formats.data.label',
    badge: 'JSON',
    description: 'export.formats.data.description',
  },
  {
    id: 'bundle',
    label: 'export.formats.bundle.label',
    badge: 'ZIP',
    description: 'export.formats.bundle.description',
  },
];

function transferSummary(format: CaptionFileFormat, t: ReturnType<typeof useI18n>['t']) {
  if (format === 'word-srt') return { keeps: t('export.handoff.wordSrtKeeps'), reset: t('export.handoff.wordSrtReset') };
  if (format === 'word-vtt') return { keeps: t('export.handoff.wordVttKeeps'), reset: t('export.handoff.wordVttReset') };
  if (format === 'ass') return { keeps: t('export.handoff.assKeeps'), reset: t('export.handoff.assReset') };
  if (format === 'data') return { keeps: t('export.handoff.dataKeeps'), reset: t('export.handoff.dataReset') };
  if (format === 'bundle') return { keeps: t('export.handoff.kitKeeps'), reset: t('export.handoff.kitReset') };
  return { keeps: t('export.handoff.srtKeeps'), reset: t('export.handoff.srtReset') };
}

export function CaptionHandoffPanel({ project, busy, onExport, downloadFocusTarget, onImport, onEditWordTiming, onRenderedVideo,
  session, onSessionChange, saveBlocked = false, invalidCaptions = false, selectedFormatBlocked = false, styledLayoutBlocked = false }: CaptionHandoffPanelProps) {
  const { t, tn } = useI18n();
  const { destination, advancedFormat } = session;
  const setAdvancedFormat = (format: AdvancedFormat | null) => onSessionChange({ ...session, advancedFormat: format });
  const [exporting, setExporting] = useState<CaptionFileFormat | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [status, setStatus] = useState('');
  const [actionError, setActionError] = useState('');

  const videoProject = isVideoProject(project);
  const destinationGuide = DESTINATIONS.find((item) => item.id === destination) || DESTINATIONS[0];
  const nonemptyCaptions = useMemo(() => project.captions.filter((caption) => caption.text.trim().length > 0), [project.captions]);
  const unresolvedWords = useMemo(
    () => nonemptyCaptions.filter((caption) => !resolveWordExport(caption).ready),
    [nonemptyCaptions],
  );
  const highlightCounts = useMemo(() => {
    if (project.captionAppearance?.highlightMode !== 'word'
      || !nonemptyCaptions.some((caption) => hasWordTimingEvidence(caption.wordTiming))) return null;
    const attention = nonemptyCaptions.map(highlightAttention).filter((status) => status !== 'not-applicable');
    return { ready: attention.filter((status) => status === 'ok').length, total: attention.length };
  }, [nonemptyCaptions, project.captionAppearance?.highlightMode]);
  const overlapPairs = useMemo(() => {
    const ordered = project.captions.filter((caption) => Number.isFinite(caption.startMs) && Number.isFinite(caption.endMs) && caption.endMs > caption.startMs)
      .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
    const endings = ordered.map((caption) => caption.endMs).sort((a, b) => a - b);
    let count = 0;
    let ended = 0;
    for (let index = 0; index < ordered.length; index += 1) {
      while (endings[ended] <= ordered[index].startMs) ended += 1;
      count += index - ended;
    }
    return count;
  }, [project.captions]);
  const readyWordCount = nonemptyCaptions.length - unresolvedWords.length;
  const hasCaptions = project.captions.length > 0;
  const wordsComplete = nonemptyCaptions.length > 0 && unresolvedWords.length === 0;
  const selectedAdvanced = advancedFormat ? ADVANCED_FORMATS.find((item) => item.id === advancedFormat) : undefined;
  const selectedAdvancedBlocked = Boolean(
    (selectedAdvanced?.requiresCompleteWords && !wordsComplete)
    || (advancedFormat === 'ass' && (!videoProject || styledLayoutBlocked)),
  );
  const summary = transferSummary('srt', t);
  const label = (key: DestinationBrand | FormatToken | HandoffMessage) => key.startsWith('export.') ? t(key as HandoffMessage) : key;
  const formatLabel = (format: CaptionFileFormat) => label(ADVANCED_FORMATS.find((item) => item.id === format)?.label || 'SRT');
  const selectedTransfer = advancedFormat ? transferSummary(advancedFormat, t) : null;

  const exportFormat = async (format: CaptionFileFormat, trigger: HTMLButtonElement) => {
    if (busy || exporting || restoring || !hasCaptions || saveBlocked || (format === 'srt' ? invalidCaptions : selectedFormatBlocked)) return;
    const definition = ADVANCED_FORMATS.find((item) => item.id === format);
    if (definition?.requiresCompleteWords && !wordsComplete) return;
    if (format === 'ass' && (!videoProject || styledLayoutBlocked)) return;
    if (document.activeElement === trigger) {
      const target = downloadFocusTarget.current;
      if (target?.isConnected) {
        target.focus({ preventScroll: true });
        target.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
      }
    }
    setExporting(format);
    setActionError('');
    setStatus('');
    try {
      const started = await onExport(format);
      if (started) setStatus(t('export.handoff.started', { format: formatLabel(format) }));
      else setActionError(t('export.handoff.notStarted'));
    } catch (error) {
      setActionError(error instanceof Error ? error.message : t('export.handoff.prepareError'));
    } finally {
      setExporting(null);
    }
  };

  const restore = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file || busy || restoring || exporting) return;
    setRestoring(true);
    setActionError('');
    setStatus('');
    try {
      await onImport(file, input);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : t('export.handoff.importError'));
    } finally {
      input.value = '';
      setRestoring(false);
    }
  };

  return <div className="caption-handoff-panel">
    <section className="handoff-primary" aria-label={t('export.handoff.srtLabel')}>
      <button className="handoff-download-primary" type="button" aria-describedby="srt-styling-note" disabled={!hasCaptions || busy || Boolean(exporting) || restoring || saveBlocked || invalidCaptions} onClick={(event) => void exportFormat('srt', event.currentTarget)}>
        <Download size={15}/>{exporting === 'srt' ? t('export.handoff.preparing') : t('export.handoff.downloadSrt')}
      </button>
      <div className="handoff-primary-copy"><span id="srt-styling-note">{t('export.handoff.srtStyle')}</span></div>
    </section>

    <section className="handoff-destination" aria-labelledby="handoff-destination-title">
      <h3 id="handoff-destination-title">{t('export.handoff.importInstructions')}</h3>
      <div className="handoff-destination-select-wrap">
        <label htmlFor="handoff-caption-destination">{t('export.handoff.destination')}</label>
        <select
          id="handoff-caption-destination"
          value={destination}
          disabled={busy || Boolean(exporting) || restoring}
          onChange={(event) => {
            onSessionChange({ ...session, destination: event.target.value as DestinationId, advancedFormat: null });
          }}
        >
          {DESTINATIONS.map((item) => <option key={item.id} value={item.id}>{label(item.label)}</option>)}
        </select>
      </div>

      <div className="handoff-destination-guide" aria-live="polite">
        <div className="handoff-guide-title"><strong>{label(destinationGuide.label)}</strong><span>{t(destinationGuide.summary)}</span></div>
        <ol>{destinationGuide.steps.map((step) => <li key={step}>{t(step)}</li>)}</ol>
        {destinationGuide.note && <p>{t(destinationGuide.note)}</p>}
        {destinationGuide.doc && <a href={destinationGuide.doc.href} target="_blank" rel="noopener noreferrer">{t(destinationGuide.doc.label)}<ExternalLink size={13}/></a>}
      </div>
    </section>

    <div className="handoff-transfer-summary" aria-label={t('export.handoff.transferLabel')}>
      <div><strong>{t('export.handoff.keeps')}</strong><span>{summary.keeps}</span></div>
      <div><strong>{t('export.handoff.setAgain')}</strong><span>{summary.reset}</span></div>
    </div>

    <p className="handoff-time-note"><TriangleAlert size={14}/><span>{t('export.handoff.sourceTiming')}</span></p>
    {overlapPairs > 0 && <div className="handoff-overlap-warning" role="status">
      <TriangleAlert size={15}/><div><strong>{tn('export.handoff.overlapPairs', overlapPairs)}</strong><span>{destination === 'final-cut' ? t('export.handoff.finalCutOverlap') : t('export.handoff.overlap')}</span></div>
    </div>}

    <details className="handoff-advanced" open={session.advancedOpen} onToggle={(event) => {
      const open = event.currentTarget.open;
      if (open !== session.advancedOpen) onSessionChange({ ...session, advancedOpen: open, advancedFormat: open ? session.advancedFormat : null });
    }}>
      <summary>{t('export.handoff.advanced')}{' '}<span>{t('export.handoff.advancedDetails')}</span></summary>
      <div className="handoff-advanced-body">
        <div className="handoff-word-readiness" role="status">
          <div><strong>{t('export.handoff.wordTiming')}</strong><span>{tn('export.handoff.wordReadiness', nonemptyCaptions.length, { ready: readyWordCount })}</span>
            {Boolean(highlightCounts?.total) && <span>{t('export.handoff.highlightReadiness', { ready: highlightCounts!.ready, total: highlightCounts!.total })}</span>}</div>
          {unresolvedWords.length > 0 && onEditWordTiming && <button type="button" onClick={() => onEditWordTiming(unresolvedWords[0]?.id)}>{t('export.handoff.reviewWordTiming')}</button>}
        </div>

        <div className="handoff-format-grid" role="group" aria-label={t('export.handoff.formatLabel')}>
          {ADVANCED_FORMATS.map((format) => {
            const wordBlocked = Boolean(format.requiresCompleteWords && !wordsComplete);
            const assBlocked = format.id === 'ass' && !videoProject;
            const selected = advancedFormat === format.id;
            return <button
              key={format.id}
              type="button"
              className={selected ? 'selected' : ''}
              aria-pressed={selected}
              disabled={assBlocked}
              onClick={() => setAdvancedFormat(format.id)}
            >
              <span className="handoff-format-top"><strong>{label(format.label)}</strong>{format.badge !== format.label && <small>{format.badge}</small>}</span>
              <span>{t(format.description)}</span>
              {assBlocked
                ? <em>{t('export.handoff.assGeometry')}</em>
                : wordBlocked && <em>{nonemptyCaptions.length === 0 ? t('export.handoff.needsText') : tn('export.handoff.needWordReview', unresolvedWords.length)}</em>}
            </button>;
          })}
        </div>

        {advancedFormat && selectedTransfer && <div className="handoff-advanced-action">
          <div><strong>{formatLabel(advancedFormat)}</strong><span>{selectedTransfer.keeps}</span><span>{selectedTransfer.reset}</span></div>
          <button type="button" disabled={!hasCaptions || busy || Boolean(exporting) || restoring || selectedAdvancedBlocked || saveBlocked || selectedFormatBlocked} onClick={(event) => void exportFormat(advancedFormat, event.currentTarget)}>
            {advancedFormat === 'bundle' ? <PackageOpen size={15}/> : advancedFormat === 'data' ? <FileJson size={15}/> : <Download size={15}/>}
            {exporting === advancedFormat ? t('export.handoff.preparing') : advancedFormat === 'bundle' ? t('export.handoff.downloadKit') : advancedFormat === 'data' ? t('export.handoff.downloadData') : t('export.handoff.downloadFormat', { format: String(selectedAdvanced?.badge) })}
          </button>
        </div>}

        <div className="handoff-restore">
          <div><RotateCcw size={16}/><div><strong>{t('export.handoff.restoreData')}</strong><span>{t('export.handoff.restoreHelp')}</span></div></div>
          <label className={busy || restoring || Boolean(exporting) ? 'disabled' : ''}>
            {restoring ? t('export.handoff.reading') : t('export.handoff.chooseJson')}
            <input type="file" accept=".json,application/json" disabled={busy || restoring || Boolean(exporting)} onChange={(event) => void restore(event)}/>
          </label>
        </div>
      </div>
    </details>

    {onRenderedVideo && <div className="handoff-rendered-video">
      <div><strong>{t('export.handoff.renderQuestion')}</strong><span>{t('export.handoff.renderHelp')}</span></div>
      <button type="button" onClick={onRenderedVideo}>{t('export.handoff.video')}</button>
    </div>}

    <div className="handoff-local-note">{t('export.handoff.local')}</div>
    {actionError && <div className="handoff-action-error" role="alert"><TriangleAlert size={15}/><span>{actionError}</span></div>}
    {status && <div className="handoff-action-status" role="status">{status}</div>}
  </div>;
}
