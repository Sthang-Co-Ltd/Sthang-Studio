import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, X } from 'lucide-react';
import './project-identity.css';

/** The compact header name remains inspectable with pointer, keyboard or touch. */
export function ProjectIdentity({ title, filename, status }: { title: string; filename: string; status: string }) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 8, top: 8 });
  const close = (restore: boolean) => {
    setOpen(false);
    if (restore) trigger.current?.focus({ preventScroll: true });
  };
  useLayoutEffect(() => {
    if (!open || !panel.current || !trigger.current) return;
    const place = () => {
      const anchor = trigger.current?.getBoundingClientRect();
      const bounds = panel.current?.getBoundingClientRect();
      if (!anchor || !bounds) return;
      if (anchor.bottom <= 0 || anchor.top >= innerHeight) { setOpen(false); return; }
      setPosition({
        left: Math.max(8, Math.min(anchor.left, innerWidth - bounds.width - 8)),
        top: Math.max(8, Math.min(anchor.bottom + 8, innerHeight - bounds.height - 8)),
      });
    };
    place();
    closeButton.current?.focus({ preventScroll: true });
    window.addEventListener('resize', place);
    document.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); document.removeEventListener('scroll', place, true); };
  }, [open, title, filename]);
  useEffect(() => {
    if (!open) return;
    const inside = (target: EventTarget | null) => target instanceof Node && (trigger.current?.contains(target) || panel.current?.contains(target));
    const outside = (event: Event) => { if (!inside(event.target)) setOpen(false); };
    const key = (event: KeyboardEvent) => {
      if (event.isComposing || event.defaultPrevented || document.querySelector('[aria-modal="true"]')) return;
      // Find must capture the stable header control as its return target,
      // before moving focus closes this temporary name surface.
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') { close(true); return; }
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopPropagation(); close(true);
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
    <button ref={trigger} type="button" className="project-name-button" aria-label="Project details" aria-haspopup="dialog"
      aria-expanded={open} aria-controls={open ? id : undefined} data-tooltip={open ? undefined : `${title}\n${filename}`}
      onClick={() => setOpen((value) => !value)}>
      <strong>{title}</strong><span className="project-name-compact">Project details</span><ChevronDown size={13} aria-hidden="true"/>
    </button>
    <span className="project-file-status">{filename} · {status}</span>
    {open && createPortal(<section ref={panel} id={id} role="dialog" aria-labelledby={`${id}-heading`} className="project-name-dialog" style={position}>
      <div className="project-name-dialog-head"><strong id={`${id}-heading`}>Project details</strong><button ref={closeButton} type="button" aria-label="Close project details" onClick={() => close(true)}><X size={16}/></button></div>
      <dl><dt>Project name</dt><dd>{title}</dd><dt>Source file</dt><dd>{filename}</dd></dl>
    </section>, document.body)}
  </div>;
}
