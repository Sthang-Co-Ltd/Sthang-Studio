import { useI18n } from '../i18n';
import { useEffect, useId, useRef, useState } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { useMenuKeyboard } from '../use-menu-keyboard';

export function ProjectMoreMenu({ id, title, disabled, onRename, onMove }: {
  id: string;
  title: string;
  disabled: boolean;
  onRename(): void;
  onMove(): void;
}) {
  const { t } = useI18n();
  const menuId = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const keyboard = useMenuKeyboard(open && !disabled ? menuId : null, menu, () => trigger.current, () => setOpen(false));
  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('focusin', outside);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('focusin', outside);
    };
  }, [open]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  const select = (action: () => void) => {
    trigger.current?.focus({ preventScroll: true });
    setOpen(false);
    action();
  };
  return <div ref={root} className="project-library-more" onKeyDown={keyboard.onKeyDown}>
    <button ref={trigger} type="button" className="project-library-action" data-library-more={id}
      aria-label={t('library.moreForProject', { title })} aria-haspopup="menu" aria-expanded={open && !disabled}
      aria-controls={open && !disabled ? menuId : undefined} disabled={disabled}
      onClick={() => setOpen(!open)} onKeyDown={(event) => {
        if (event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229
          || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.getModifierState('AltGraph')) return;
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        event.preventDefault();
        keyboard.openAt(event.key === 'ArrowDown' ? 'first' : 'last', menuId);
        setOpen(true);
      }}><MoreHorizontal size={18} aria-hidden="true"/>{t('library.more')}</button>
    {open && !disabled && <div ref={menu} id={menuId} className="project-library-menu" role="menu" aria-label={t('library.actionsForProject', { title })}>
      <button type="button" role="menuitem" tabIndex={-1} onClick={() => select(onRename)}>{t('library.rename')}</button>
      <button type="button" role="menuitem" tabIndex={-1} onClick={() => select(onMove)}>{t('library.moveToBin')}</button>
    </div>}
  </div>;
}
