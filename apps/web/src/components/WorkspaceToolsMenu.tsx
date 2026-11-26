import { useI18n } from '../i18n';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useSurfacePresence } from '../use-surface-presence';
import { useMenuKeyboard } from '../use-menu-keyboard';
import { editorPopoverAvailable } from '../editor-layout-state';
import {
  BookOpenCheck,
  HelpCircle,
  History,
  Info,
  KeyRound,
  ListTodo,
  PanelsTopLeft,
  SlidersHorizontal,
  RefreshCw,
  Replace,
  RotateCcw,
  Search,
  Settings2,
} from 'lucide-react';

interface WorkspaceToolsMenuProps {
  activeJobs: number;
  pendingCorrections: number;
  llmConfigured: boolean;
  replaceDisabled: boolean;
  technicalDetailsAvailable?: boolean;
  onTechnicalDetails?: () => void;
  onArrangePanels(anchor: HTMLElement): void;
  onGuide(): void;
  onCorrect(): void;
  onHistory(): void;
  onJobs(): void;
  onCorrections(): void;
  onReplace(): void;
  onUndoMedia(): void;
  onSettings(): void;
  onUpdates(): void;
}

export function WorkspaceToolsMenu({
  activeJobs,
  pendingCorrections,
  llmConfigured,
  replaceDisabled,
  technicalDetailsAvailable,
  onTechnicalDetails,
  onArrangePanels,
  onGuide,
  onCorrect,
  onHistory,
  onJobs,
  onCorrections,
  onReplace,
  onUndoMedia,
  onSettings,
  onUpdates,
}: WorkspaceToolsMenuProps) {
  const { t } = useI18n();
  const details = useRef<HTMLDetailsElement | null>(null);
  const popover = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [layoutWide, setLayoutWide] = useState(() => window.matchMedia('(min-width: 1200px)').matches);
  useLayoutEffect(() => {
    const query = window.matchMedia('(min-width: 1200px)');
    const update = () => setLayoutWide(query.matches);
    query.addEventListener('change', update);
    update();
    return () => query.removeEventListener('change', update);
  }, []);
  const openRef = useRef(open); openRef.current = open;
  const presence = useSurfacePresence(open ? 'tools' : null, popover, 'menu');
  const menuId = useId();
  const keyboard = useMenuKeyboard(open ? 'tools' : null, popover, () => details.current?.querySelector('summary'), () => setOpen(false));
  useLayoutEffect(() => {
    if (!open) return;
    const position = () => {
      const trigger = details.current?.querySelector('summary')?.getBoundingClientRect();
      const panel = popover.current;
      if (trigger && panel) {
        const bounds = panel.getBoundingClientRect();
        panel.style.setProperty('--menu-origin', `${Math.max(0, Math.min(panel.offsetWidth, trigger.x + trigger.width / 2 - bounds.x))}px`);
      }
    };
    position();
    window.addEventListener('resize', position);
    return () => window.removeEventListener('resize', position);
  }, [open]);
  useEffect(() => {
    const close = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && !details.current?.contains(target)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented && !event.isComposing && event.keyCode !== 229 && !event.getModifierState('AltGraph')
        && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && openRef.current && !document.querySelector('[aria-modal="true"]')) {
        event.preventDefault();
        setOpen(false);
        details.current?.querySelector('summary')?.focus();
      }
    };
    document.addEventListener('pointerdown', close);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, []);
  const run = (action: (anchor: HTMLElement | null | undefined) => void) => {
    const anchor = details.current?.querySelector('summary');
    anchor?.focus();
    setOpen(false);
    action(anchor);
  };
  const attentionCount = activeJobs + pendingCorrections + (llmConfigured ? 0 : 1);

  return <details ref={details} className="workspace-tools-menu" open={presence.present} data-menu-open={open}>
    <summary aria-label={t('editor.tools.open')} aria-haspopup="menu" aria-controls={menuId} aria-expanded={open}
      onKeyDown={(event) => {
        if (!event.defaultPrevented && !event.nativeEvent.isComposing && event.keyCode !== 229 && !event.getModifierState('AltGraph')
          && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
          event.preventDefault(); keyboard.openAt(event.key === 'ArrowUp' ? 'last' : 'first'); setOpen(true);
        }
      }}
      onClick={(event) => {
        event.preventDefault();
        if (open) event.currentTarget.focus({ preventScroll: true }); else keyboard.openAt('first');
        setOpen((value) => !value);
      }}>
      <SlidersHorizontal size={16}/><span>{t('editor.tools.title')}</span>
      {attentionCount > 0 && <b className="tool-badge">{attentionCount}</b>}
    </summary>
    <div ref={popover} id={menuId} className="workspace-tools-popover" role="menu" aria-label={t('editor.tools.menu')} onKeyDown={keyboard.onKeyDown} data-motion-state={open ? 'open' : 'closed'} inert={!open} aria-hidden={!open || undefined}>
      <div className="tools-menu-section">
        <span>{t('editor.tools.editReview')}</span>
        <button role="menuitem" aria-keyshortcuts="Control+F Meta+F" onClick={() => run(onCorrect)}><Search size={16}/><span><b>{t('editor.tools.correct')}</b><small>{t('editor.tools.correctHelp')}</small></span><kbd aria-hidden="true">{navigator.platform.toLowerCase().includes('mac') ? '⌘ F' : 'Ctrl F'}</kbd></button>
        <button role="menuitem" onClick={() => run(onHistory)}><History size={16}/><span><b>{t('editor.tools.history')}</b><small>{t('editor.tools.historyHelp')}</small></span></button>
      </div>
      <div className="tools-menu-section">
        <button role="menuitem" onClick={() => run(onJobs)}><ListTodo size={16}/><span><b>{t('editor.tools.activity')}</b><small>{t('editor.tools.activityHelp')}</small></span>{activeJobs > 0 && <em>{t('editor.tools.activeJobs', { count: activeJobs })}</em>}</button>
        <button role="menuitem" onClick={() => run(onCorrections)}><BookOpenCheck size={16}/><span><b>{t('editor.tools.corrections')}</b><small>{t('editor.tools.correctionsHelp')}</small></span>{pendingCorrections > 0 && <em>{pendingCorrections}</em>}</button>
      </div>
      <div className="tools-menu-section">
        <span>{t('editor.tools.projectSetup')}</span>
        {technicalDetailsAvailable && onTechnicalDetails && <button role="menuitem" onClick={() => run(onTechnicalDetails)}><Info size={16}/><span><b>{t('editor.tools.technical')}</b><small>{t('editor.tools.technicalHelp')}</small></span></button>}
        <button role="menuitem" disabled={replaceDisabled} onClick={() => run(onReplace)}><Replace size={16}/><span><b>{t('editor.tools.replace')}</b><small>{replaceDisabled ? t('editor.tools.replaceBlocked') : t('editor.tools.replaceHelp')}</small></span></button>
        <button role="menuitem" disabled={replaceDisabled} onClick={() => run(onUndoMedia)}><RotateCcw size={16}/><span><b>{t('editor.tools.undoReplace')}</b><small>{t('editor.tools.undoReplaceHelp')}</small></span></button>
        {editorPopoverAvailable() && <button type="button" role="menuitem" className="tools-menu-arrange" disabled={!layoutWide} onClick={() => run((anchor) => {
          if (anchor) onArrangePanels(anchor);
        })}><PanelsTopLeft size={16}/><span><b>{t('editor.tools.arrange')}</b></span></button>}
        <button role="menuitem" onClick={() => run(onGuide)}><HelpCircle size={16}/><span><b>{t('editor.tools.guide')}</b></span></button>
        <button role="menuitem" onClick={() => run(onUpdates)}><RefreshCw size={16}/><span><b>{t('editor.tools.updates')}</b></span></button>
        <button role="menuitem" onClick={() => run(onSettings)}><Settings2 size={16}/><span><b>{t('editor.tools.settings')}</b><small>{llmConfigured ? t('editor.tools.settingsHelp') : t('editor.tools.settingsNeeded')}</small></span>{!llmConfigured && <KeyRound size={14} className="tools-warning-icon"/>}</button>
      </div>
    </div>
  </details>;
}
