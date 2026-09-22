import { useMemo, useState, type ChangeEvent } from 'react';
import { isVideoProject, resolveCaptionWordTiming, type CaptionProject } from '@kcs/shared';
import { Download, ExternalLink, FileJson, FileText, PackageOpen, RotateCcw, TriangleAlert } from 'lucide-react';
import './caption-handoff.css';

export type CaptionFileFormat = 'srt' | 'word-srt' | 'vtt' | 'word-vtt' | 'ttml' | 'ass' | 'data' | 'bundle';

export interface CaptionHandoffPanelProps {
  project: CaptionProject;
  busy: boolean;
  onExport(format: CaptionFileFormat): Promise<boolean>;
  onImport(file: File): Promise<void>;
  onEditWordTiming?(id?: string): void;
  onRenderedVideo?(): void;
}

type DestinationId = 'capcut-desktop' | 'capcut-mobile' | 'premiere' | 'resolve' | 'final-cut' | 'web-other' | 'subtitle-tools';
type AdvancedFormat = Exclude<CaptionFileFormat, 'srt'>;

interface DestinationGuide {
  id: DestinationId;
  label: string;
  summary: string;
  steps: string[];
  note?: string;
  doc?: { label: string; href: string };
}

interface FormatGuide {
  id: AdvancedFormat;
  label: string;
  badge: string;
  description: string;
  requiresCompleteWords?: boolean;
}

const DESTINATIONS: DestinationGuide[] = [
  {
    id: 'capcut-desktop',
    label: 'CapCut Desktop',
    summary: 'Recommended starting point',
    steps: [
      'Download the UTF-8 SRT from Studio.',
      'In CapCut Desktop, use Captions → Add Captions to import it.',
      'Place the imported subtitles on the timeline at source 0:00, then style them in CapCut.',
    ],
    note: 'SRT keeps caption text and timing. It does not carry Studio font, color, position, animation, or word-highlight styling.',
    doc: { label: 'CapCut subtitle import guide', href: 'https://www.capcut.com/help/how-to-import-subtitles' },
  },
  {
    id: 'capcut-mobile',
    label: 'CapCut Mobile',
    summary: 'Desktop/Web handoff first',
    steps: [
      'CapCut mobile does not provide direct subtitle-file import.',
      'Import the SRT in CapCut Desktop or Web first.',
      'If CapCut project cloud sync is available, sync that project on the same account and continue editing on mobile.',
    ],
    note: 'Cloud sync is handled by CapCut, not Studio. Account, region, app version, and feature availability can vary.',
    doc: { label: 'CapCut subtitle import guide', href: 'https://www.capcut.com/help/how-to-import-subtitles' },
  },
  {
    id: 'premiere',
    label: 'Premiere Pro',
    summary: 'Start with SRT',
    steps: [
      'Download SRT for the most portable caption handoff.',
      'Import it into the project as captions, then review the caption track against the source clip.',
      'Set typography, placement, and any animation inside Premiere Pro.',
    ],
  },
  {
    id: 'resolve',
    label: 'DaVinci Resolve',
    summary: 'Start with SRT',
    steps: [
      'Download SRT and import it as a subtitle track.',
      'Check the imported cue timing against the source clip.',
      'Set subtitle styling or convert the workflow further inside Resolve as needed.',
    ],
  },
  {
    id: 'final-cut',
    label: 'Final Cut Pro',
    summary: 'Start with SRT',
    steps: [
      'Download SRT and import it as captions.',
      'Check language, timing, and caption placement after import.',
      'Apply the look you want inside Final Cut Pro.',
    ],
  },
  {
    id: 'web-other',
    label: 'Web / other editor',
    summary: 'SRT first; VTT when requested',
    steps: [
      'Try SRT first because it is the most portable option here.',
      'If the destination specifically asks for WebVTT, choose VTT under Advanced formats.',
      'Check a short section after import before doing detailed styling.',
    ],
  },
  {
    id: 'subtitle-tools',
    label: 'Subtitle tools',
    summary: 'Choose the format the tool documents',
    steps: [
      'SRT is the safest general exchange format.',
      'Use VTT, TTML, or ASS only when the destination explicitly supports the format and behavior you need.',
      'Word-timed variants are specialist exports; verify how the destination interprets them before relying on highlights.',
    ],
  },
];

const ADVANCED_FORMATS: FormatGuide[] = [
  {
    id: 'word-srt',
    label: 'One word per caption (SRT)',
    badge: 'WORD SRT',
    description: 'One timed word per subtitle cue for editors that can work with dense subtitle tracks.',
    requiresCompleteWords: true,
  },
  {
    id: 'vtt',
    label: 'WebVTT',
    badge: 'VTT',
    description: 'Portable WebVTT cue text and timing, useful when a web/player workflow asks for VTT.',
  },
  {
    id: 'word-vtt',
    label: 'One word per caption (VTT)',
    badge: 'WORD VTT',
    description: 'Exports each ready word as its own timed VTT cue. Editor/player behavior varies; this does not preserve Studio current-word highlight styling.',
    requiresCompleteWords: true,
  },
  {
    id: 'ttml',
    label: 'TTML',
    badge: 'TTML',
    description: 'Timed-text XML for compatible professional and subtitle workflows.',
  },
  {
    id: 'ass',
    label: 'ASS',
    badge: 'ASS',
    description: 'For compatible ASS renderers. It can carry Studio current-word color, but some editors import only the text and timing. Repeated render events may be awkward to edit.',
  },
  {
    id: 'data',
    label: 'Studio caption data',
    badge: 'JSON',
    description: 'Versioned Sthang Studio caption data for backup/restore. It is not a general editor-import format.',
  },
  {
    id: 'bundle',
    label: 'Caption handoff kit',
    badge: 'ZIP',
    description: 'Captions, optional ready word-timed files, Studio backup data, and a handoff guide. No source media or font files.',
  },
];

const formatLabel = (format: CaptionFileFormat) => ADVANCED_FORMATS.find((item) => item.id === format)?.label || 'SRT';

function transferSummary(format: CaptionFileFormat) {
  if (format === 'word-srt') return { keeps: 'Each ready word as an individually timed subtitle cue.', reset: 'Font, color, position, animation, and highlight behavior.' };
  if (format === 'word-vtt') return { keeps: 'Each ready word as an individually timed WebVTT cue.', reset: 'Appearance and any editor-specific highlight animation.' };
  if (format === 'ass') return { keeps: 'Caption text, timing, and compatible ASS render/style state.', reset: 'Anything the destination does not support; complex repeated events may need cleanup.' };
  if (format === 'data') return { keeps: 'Studio caption wording, timing, word tracks, review metadata, and appearance reference.', reset: 'Preview before replacing captions. Current appearance stays unchanged.' };
  if (format === 'bundle') return { keeps: 'Standard captions, optional ready word timing, Studio backup data, and a guide.', reset: 'Visual styling in the destination editor. The kit contains no media or fonts.' };
  return { keeps: 'Caption text and source-media cue timing.', reset: 'Font, color, size, placement, animation, and word-highlight styling.' };
}

export function CaptionHandoffPanel({ project, busy, onExport, onImport, onEditWordTiming, onRenderedVideo }: CaptionHandoffPanelProps) {
  const [destination, setDestination] = useState<DestinationId>('capcut-desktop');
  const [advancedFormat, setAdvancedFormat] = useState<AdvancedFormat | null>(null);
  const [exporting, setExporting] = useState<CaptionFileFormat | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [status, setStatus] = useState('');
  const [actionError, setActionError] = useState('');

  const videoProject = isVideoProject(project);
  const destinationGuide = DESTINATIONS.find((item) => item.id === destination) || DESTINATIONS[0];
  const nonemptyCaptions = useMemo(() => project.captions.filter((caption) => caption.text.trim().length > 0), [project.captions]);
  const unresolvedWords = useMemo(
    () => nonemptyCaptions.filter((caption) => resolveCaptionWordTiming(caption).state !== 'ready'),
    [nonemptyCaptions],
  );
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
    || (advancedFormat === 'ass' && !videoProject),
  );
  const summary = transferSummary('srt');

  const exportFormat = async (format: CaptionFileFormat) => {
    if (busy || exporting || restoring || !hasCaptions) return;
    const definition = ADVANCED_FORMATS.find((item) => item.id === format);
    if (definition?.requiresCompleteWords && !wordsComplete) return;
    if (format === 'ass' && !videoProject) return;
    setExporting(format);
    setActionError('');
    setStatus('');
    try {
      const started = await onExport(format);
      if (started) setStatus(`${formatLabel(format)} download started.`);
      else setActionError('The export was not started. Review the current project notice and try again.');
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not prepare this caption export.');
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
      await onImport(file);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not read this Studio caption-data file.');
    } finally {
      input.value = '';
      setRestoring(false);
    }
  };

  return <div className="caption-handoff-panel">
    <section className="handoff-destination" aria-labelledby="handoff-destination-title">
      <div className="handoff-section-head">
        <div><strong id="handoff-destination-title">Where are you continuing?</strong><span>Pick a destination first. Studio keeps SRT as the safest default.</span></div>
      </div>
      <label className="handoff-destination-select-wrap">
        <span>Destination</span>
        <select
          aria-label="Caption destination"
          value={destination}
          disabled={busy || Boolean(exporting) || restoring}
          onChange={(event) => {
            setDestination(event.target.value as DestinationId);
            setAdvancedFormat(null);
          }}
        >
          {DESTINATIONS.map((item) => <option key={item.id} value={item.id}>{item.label} · {item.summary}</option>)}
        </select>
      </label>

      <div className="handoff-destination-guide" aria-live="polite">
        <div className="handoff-guide-title"><strong>{destinationGuide.label}</strong><span>{destinationGuide.summary}</span></div>
        <ol>{destinationGuide.steps.map((step) => <li key={step}>{step}</li>)}</ol>
        {destinationGuide.note && <p>{destinationGuide.note}</p>}
        {destinationGuide.doc && <a href={destinationGuide.doc.href} target="_blank" rel="noopener noreferrer">{destinationGuide.doc.label}<ExternalLink size={13}/></a>}
      </div>
    </section>

    <section className="handoff-primary" aria-labelledby="caption-handoff-srt-title">
      <div className="handoff-primary-copy">
        <span className="handoff-format-icon"><FileText size={17}/></span>
        <div><strong id="caption-handoff-srt-title">Captions file (SRT)</strong><span>Caption text + timing. Visual styling stays controlled by the destination editing app.</span></div>
      </div>
      <button className="handoff-download-primary" type="button" disabled={!hasCaptions || busy || Boolean(exporting) || restoring} onClick={() => void exportFormat('srt')}>
        <Download size={15}/>{exporting === 'srt' ? 'Preparing…' : 'Download SRT'}
      </button>
    </section>

    <div className="handoff-transfer-summary" aria-label="What transfers with the selected caption format">
      <div><strong>Keeps</strong><span>{summary.keeps}</span></div>
      <div><strong>Set again in editor</strong><span>{summary.reset}</span></div>
    </div>

    <p className="handoff-time-note"><TriangleAlert size={14}/><span>Timecodes start at the source media's 0:00. If you trim, offset, or change clip speed in another editor, retime the captions there to match.</span></p>
    {overlapPairs > 0 && <div className="handoff-overlap-warning" role="status">
      <TriangleAlert size={15}/><div><strong>{overlapPairs} overlapping cue pair{overlapPairs === 1 ? '' : 's'}</strong><span>Check overlaps in the destination editor. Studio exports your timing as-is and does not silently retime captions.{destination === 'final-cut' ? ' Final Cut Pro cannot keep overlapping captions, so resolve them before relying on the handoff.' : ''}</span></div>
    </div>}

    <details className="handoff-advanced" onToggle={(event) => { if (!event.currentTarget.open) setAdvancedFormat(null); }}>
      <summary>Advanced caption formats <span>For specific editor or archive needs</span></summary>
      <div className="handoff-advanced-body">
        <div className="handoff-word-readiness" role="status">
          <div><strong>Word timing</strong><span>{readyWordCount} of {nonemptyCaptions.length} nonempty caption{nonemptyCaptions.length === 1 ? '' : 's'} ready for word-timed export.</span></div>
          {unresolvedWords.length > 0 && onEditWordTiming && <button type="button" onClick={() => onEditWordTiming(unresolvedWords[0]?.id)}>Review word timing</button>}
        </div>

        <div className="handoff-format-grid" role="group" aria-label="Advanced caption format">
          {ADVANCED_FORMATS.map((format) => {
            const wordBlocked = Boolean(format.requiresCompleteWords && !wordsComplete);
            const assBlocked = format.id === 'ass' && !videoProject;
            const blocked = wordBlocked || assBlocked;
            const selected = advancedFormat === format.id;
            return <button
              key={format.id}
              type="button"
              className={selected ? 'selected' : ''}
              aria-pressed={selected}
              disabled={blocked}
              onClick={() => setAdvancedFormat(format.id)}
            >
              <span className="handoff-format-top"><strong>{format.label}</strong><small>{format.badge}</small></span>
              <span>{format.description}</span>
              {assBlocked
                ? <em>ASS needs a video project so Studio can use the real media geometry.</em>
                : wordBlocked && <em>{nonemptyCaptions.length === 0 ? 'Needs caption text and complete word timing' : `${unresolvedWords.length} caption${unresolvedWords.length === 1 ? '' : 's'} need word timing review`}</em>}
            </button>;
          })}
        </div>

        {advancedFormat && <div className="handoff-advanced-action">
          <div><strong>{formatLabel(advancedFormat)}</strong><span>{transferSummary(advancedFormat).keeps}</span><span>{transferSummary(advancedFormat).reset}</span></div>
          <button type="button" disabled={!hasCaptions || busy || Boolean(exporting) || restoring || selectedAdvancedBlocked} onClick={() => void exportFormat(advancedFormat)}>
            {advancedFormat === 'bundle' ? <PackageOpen size={15}/> : advancedFormat === 'data' ? <FileJson size={15}/> : <Download size={15}/>}
            {exporting === advancedFormat ? 'Preparing…' : advancedFormat === 'bundle' ? 'Download handoff kit' : advancedFormat === 'data' ? 'Download Studio data' : `Download ${ADVANCED_FORMATS.find((item) => item.id === advancedFormat)?.badge}`}
          </button>
        </div>}

        <div className="handoff-restore">
          <div><RotateCcw size={16}/><div><strong>Restore Studio caption data…</strong><span>Choose a Studio JSON backup. Preview before replacing captions. Current appearance stays unchanged.</span></div></div>
          <label className={busy || restoring || Boolean(exporting) ? 'disabled' : ''}>
            {restoring ? 'Reading…' : 'Choose JSON…'}
            <input type="file" accept=".json,application/json" disabled={busy || restoring || Boolean(exporting)} onChange={(event) => void restore(event)}/>
          </label>
        </div>
      </div>
    </details>

    {onRenderedVideo && <div className="handoff-rendered-video">
      <div><strong>Need Studio's exact visual appearance?</strong><span>A captioned video bakes the saved Studio look into the picture instead of transferring editable subtitle styling.</span></div>
      <button type="button" onClick={onRenderedVideo}>Captioned video</button>
    </div>}

    <div className="handoff-local-note">Studio prepares local files only. It never uploads captions to the destination editor or its cloud account.</div>
    {actionError && <div className="handoff-action-error" role="alert"><TriangleAlert size={15}/><span>{actionError}</span></div>}
    {status && <div className="handoff-action-status" role="status">{status}</div>}
  </div>;
}
