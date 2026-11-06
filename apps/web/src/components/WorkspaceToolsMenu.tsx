import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useSurfacePresence } from '../use-surface-presence';
import { useMenuKeyboard } from '../use-menu-keyboard';
import {
  BookOpenCheck,
  HelpCircle,
  History,
  KeyRound,
  ListTodo,
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
  const details = useRef<HTMLDetailsElement | null>(null);
  const popover = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
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
      if (event.key === 'Escape' && !event.defaultPrevented && !event.isComposing && openRef.current && !document.querySelector('[aria-modal="true"]')) {
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
  const run = (action: () => void) => {
    details.current?.querySelector('summary')?.focus();
    setOpen(false);
    action();
  };
  const attentionCount = activeJobs + pendingCorrections + (llmConfigured ? 0 : 1);

  return <details ref={details} className="workspace-tools-menu" open={presence.present} data-menu-open={open}>
    <summary aria-label="Open project tools" aria-haspopup="menu" aria-controls={menuId} aria-expanded={open}
      onKeyDown={(event) => {
        if (!event.altKey && !event.ctrlKey && !event.metaKey && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
          event.preventDefault(); keyboard.openAt(event.key === 'ArrowUp' ? 'last' : 'first'); setOpen(true);
        }
      }}
      onClick={(event) => {
        event.preventDefault();
        if (open) event.currentTarget.focus({ preventScroll: true }); else keyboard.openAt('first');
        setOpen((value) => !value);
      }}>
      <SlidersHorizontal size={16}/><span>Tools</span>
      {attentionCount > 0 && <b className="tool-badge">{attentionCount}</b>}
    </summary>
    <div ref={popover} id={menuId} className="workspace-tools-popover" role="menu" aria-label="Project tools" onKeyDown={keyboard.onKeyDown} data-motion-state={open ? 'open' : 'closed'} inert={!open} aria-hidden={!open || undefined}>
      <div className="tools-menu-section">
        <span>Edit and review</span>
        <button role="menuitem" aria-keyshortcuts="Control+F Meta+F" onClick={() => run(onCorrect)}><Search size={16}/><span><b>Correct everywhere</b><small>Find and correct repeated wording</small></span><kbd aria-hidden="true">{navigator.platform.toLowerCase().includes('mac') ? '⌘ F' : 'Ctrl F'}</kbd></button>
        <button role="menuitem" onClick={() => run(onHistory)}><History size={16}/><span><b>History</b><small>Restore an earlier checkpoint</small></span></button>
      </div>
      <div className="tools-menu-section">
        <span>Activity</span>
        <button role="menuitem" onClick={() => run(onJobs)}><ListTodo size={16}/><span><b>Processing jobs</b><small>{activeJobs ? `${activeJobs} currently active` : 'Progress and recovery'}</small></span>{activeJobs > 0 && <em>{activeJobs}</em>}</button>
        <button role="menuitem" onClick={() => run(onCorrections)}><BookOpenCheck size={16}/><span><b>Correction inbox</b><small>Approve what Studio should remember</small></span>{pendingCorrections > 0 && <em>{pendingCorrections}</em>}</button>
      </div>
      <div className="tools-menu-section">
        <span>Project and setup</span>
        <button role="menuitem" disabled={replaceDisabled} onClick={() => run(onReplace)}><Replace size={16}/><span><b>Replace media</b><small>{replaceDisabled ? 'Finish current work first' : 'Choose whether to keep reviewed captions'}</small></span></button>
        <button role="menuitem" disabled={replaceDisabled} onClick={() => run(onUndoMedia)}><RotateCcw size={16}/><span><b>Undo media replacement</b><small>Restore or manage saved source backups</small></span></button>
        <button role="menuitem" onClick={() => run(onGuide)}><HelpCircle size={16}/><span><b>Quick guide</b></span></button>
        <button role="menuitem" onClick={() => run(onUpdates)}><RefreshCw size={16}/><span><b>Check for updates</b></span></button>
        <button role="menuitem" onClick={() => run(onSettings)}><Settings2 size={16}/><span><b>Settings</b><small>{llmConfigured ? 'AI, profile, privacy, and system' : 'AI key setup needed'}</small></span>{!llmConfigured && <KeyRound size={14} className="tools-warning-icon"/>}</button>
      </div>
    </div>
  </details>;
}
