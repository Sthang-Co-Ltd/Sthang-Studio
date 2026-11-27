import { useI18n } from '../i18n';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, X } from 'lucide-react';
import { ProjectRenameForm, type RenameProject } from './ProjectRename';
import './project-identity.css';

/** The compact header name remains inspectable with pointer, keyboard or touch. */
export function ProjectIdentity({ title, filename, status, onRename }: { title: string; filename: string; status: string; onRename?: RenameProject }) {
  const { t } = useI18n();
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const renameButton = useRef<HTMLButtonElement>(null);
  const renameInput = useRef<HTMLInputElement>(null);
  const savingName = useRef(false);
  const returnToRename = useRef(false);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [position, setPosition] = useState({ left: 8, top: 8 });
  const close = (restore: boolean) => {
    setOpen(false);
    setEditing(false);
    if (restore) trigger.current?.focus({ preventScroll: true });
  };
  useLayoutEffect(() => {
    if (!open || !panel.current || !trigger.current) return;
    const place = () => {
      const anchor = trigger.current?.getBoundingClientRect();
      const bounds = panel.current?.getBoundingClientRect();
      if (!anchor || !bounds) return;
      if (anchor.bottom <= 0 || anchor.top >= innerHeight) { close(false); return; }
      setPosition({
        left: Math.max(8, Math.min(anchor.left, innerWidth - bounds.width - 8)),
        top: Math.max(8, Math.min(anchor.bottom + 8, innerHeight - bounds.height - 8)),
      });
    };
    place();
    closeButton.current?.focus({ preventScroll: true });
    const observer = new ResizeObserver(place);
    observer.observe(panel.current);
    window.addEventListener('resize', place);
    document.addEventListener('scroll', place, true);
    return () => { observer.disconnect(); window.removeEventListener('resize', place); document.removeEventListener('scroll', place, true); };
  }, [open]);
  const finishRename = () => {
    returnToRename.current = true;
    setEditing(false);
  };
  useLayoutEffect(() => {
    if (!editing && returnToRename.current) {
      returnToRename.current = false;
      renameButton.current?.focus({ preventScroll: true });
    }
  }, [editing]);
  useEffect(() => {
    if (!open) return;
    const inside = (target: EventTarget | null) => target instanceof Node && (trigger.current?.contains(target) || panel.current?.contains(target));
    const outside = (event: Event) => { if (!inside(event.target)) close(false); };
    const key = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229 || event.getModifierState('AltGraph') || event.defaultPrevented || document.querySelector('[aria-modal="true"]')) return;
      // Find must capture the stable header control as its return target,
      // before moving focus closes this temporary name surface.
      if (event.ctrlKey !== event.metaKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'f') { close(true); return; }
      if (event.key !== 'Escape' || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      event.preventDefault(); event.stopPropagation();
      if (event.target === renameInput.current) {
        if (!savingName.current) finishRename();
      } else close(true);
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('focusin', outside);
    document.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('focusin', outside);
      document.removeEventListener('keydown', key, true);
    };
  }, [open]);
  return <div className="project-title inspectable-project-title">
    <button ref={trigger} type="button" className="project-name-button" aria-label={t('editor.identity.details')} aria-describedby={`${id}-name`} aria-haspopup="dialog" data-project-entry-focus
      aria-expanded={open} aria-controls={open ? id : undefined} data-tooltip={open ? undefined : `${title}\n${filename}`}
      onClick={() => { if (open) close(false); else setOpen(true); }}>
      <strong id={`${id}-name`}>{title}</strong><span className="project-name-compact" aria-hidden="true"><span>{title}</span></span><ChevronDown size={16} aria-hidden="true"/>
    </button>
    <span className="project-file-status">{filename} · {status}</span>
    {open && createPortal(<section ref={panel} id={id} role="dialog" aria-labelledby={`${id}-heading`} className="project-name-dialog" style={position}>
      <div className="project-name-dialog-head"><strong id={`${id}-heading`}>{t('editor.identity.details')}</strong><button ref={closeButton} type="button" aria-label={t('editor.identity.close')} onClick={() => close(true)}><X size={16}/></button></div>
      {editing && onRename && <div className="project-name-edit"><ProjectRenameForm title={title} onRename={onRename}
        input={renameInput} busy={savingName} onClose={finishRename}/></div>}
      <dl>{!editing && <><dt>{t('editor.identity.name')}</dt><dd>{title}</dd></>}<dt>{t('editor.identity.source')}</dt><dd>{filename}</dd></dl>
      {!editing && onRename && <div className="project-name-actions"><button ref={renameButton} type="button"
        className="studio-confirm-cancel" onClick={() => setEditing(true)}>{t('editor.identity.rename')}</button></div>}
    </section>, document.body)}
  </div>;
}
