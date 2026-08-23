import { useEffect, useRef } from 'react';
import {
  BookOpenCheck,
  HelpCircle,
  History,
  KeyRound,
  ListTodo,
  MoreHorizontal,
  Replace,
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
  onSettings(): void;
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
  onSettings,
}: WorkspaceToolsMenuProps) {
  const details = useRef<HTMLDetailsElement | null>(null);
  useEffect(() => {
    const close = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (details.current?.open && target && !details.current.contains(target)) details.current.removeAttribute('open');
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') details.current?.removeAttribute('open');
    };
    document.addEventListener('pointerdown', close);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, []);
  const run = (action: () => void) => {
    details.current?.removeAttribute('open');
    action();
  };
  const attentionCount = activeJobs + pendingCorrections + (llmConfigured ? 0 : 1);

  return <details ref={details} className="workspace-tools-menu">
    <summary aria-label="Open project tools">
      <MoreHorizontal size={17}/><span>Tools</span>
      {attentionCount > 0 && <b className="tool-badge">{attentionCount}</b>}
    </summary>
    <div className="workspace-tools-popover" role="menu">
      <div className="tools-menu-intro"><strong>Project tools</strong><span>Less-used actions stay here so the editor remains calm.</span></div>
      <div className="tools-menu-section">
        <span>Edit and review</span>
        <button role="menuitem" onClick={() => run(onCorrect)}><Search size={16}/><span><b>Correct everywhere</b><small>Find repeated wording safely</small></span></button>
        <button role="menuitem" onClick={() => run(onHistory)}><History size={16}/><span><b>History</b><small>Restore an earlier checkpoint</small></span></button>
      </div>
      <div className="tools-menu-section">
        <span>Activity</span>
        <button role="menuitem" onClick={() => run(onJobs)}><ListTodo size={16}/><span><b>Processing jobs</b><small>{activeJobs ? `${activeJobs} currently active` : 'Progress and recovery'}</small></span>{activeJobs > 0 && <em>{activeJobs}</em>}</button>
        <button role="menuitem" onClick={() => run(onCorrections)}><BookOpenCheck size={16}/><span><b>Correction inbox</b><small>Approve what Studio should remember</small></span>{pendingCorrections > 0 && <em>{pendingCorrections}</em>}</button>
      </div>
      <div className="tools-menu-section">
        <span>Project and setup</span>
        <button role="menuitem" disabled={replaceDisabled} onClick={() => run(onReplace)}><Replace size={16}/><span><b>Replace media</b><small>{replaceDisabled ? 'Wait for the active job to finish' : 'Use a newer CapCut export'}</small></span></button>
        <button role="menuitem" onClick={() => run(onGuide)}><HelpCircle size={16}/><span><b>Quick guide</b><small>See the simple first workflow</small></span></button>
        <button role="menuitem" onClick={() => run(onSettings)}><Settings2 size={16}/><span><b>Settings</b><small>{llmConfigured ? 'Connected · profile and system' : 'Connection setup required'}</small></span>{!llmConfigured && <KeyRound size={14} className="tools-warning-icon"/>}</button>
      </div>
    </div>
  </details>;
}
