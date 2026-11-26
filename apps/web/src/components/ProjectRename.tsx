import { useI18n } from '../i18n';
import { useId, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { ApiRequestError } from '../api';
import { useModalFocus } from '../use-modal-focus';
import './confirmation-dialog.css';
import './project-rename.css';

export type RenameProject = (title: string, expectedTitle: string) => Promise<void>;

export function ProjectRenameForm({ title, onRename, onClose, input, busy }: {
  title: string;
  onRename: RenameProject;
  onClose(): void;
  input: RefObject<HTMLInputElement | null>;
  busy: RefObject<boolean>;
}) {
  const { t } = useI18n();
  const id = useId();
  const [value, setValue] = useState(title);
  const [expectedTitle, setExpectedTitle] = useState(title);
  const [failure, setFailure] = useState('');
  const [invalid, setInvalid] = useState(false);
  const [saving, setSaving] = useState(false);
  useLayoutEffect(() => { input.current?.focus(); input.current?.select(); }, [input]);

  return <form className="project-rename-form" onSubmit={async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (busy.current) return;
    const normalized = value.trim().replace(/\s+/gu, ' ');
    if (!normalized || Array.from(normalized).length > 120 || /\p{Cc}/u.test(value)) {
      setInvalid(true);
      setFailure(t('editor.rename.invalid'));
      input.current?.focus();
      return;
    }
    busy.current = true;
    setSaving(true);
    setFailure('');
    try {
      await onRename(normalized, expectedTitle);
      if (input.current?.form === form) onClose();
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === 'title_conflict' && error.title !== undefined) {
        setExpectedTitle(error.title);
        setFailure(t('editor.rename.conflict', { title: error.title }));
      } else {
        setFailure(error instanceof ApiRequestError && error.status === 404
          ? t('editor.rename.missing') : t('editor.rename.failed'));
      }
      input.current?.focus();
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }}>
    <label htmlFor={id}>{t('editor.rename.name')}</label>
    <input ref={input} id={id} value={value} readOnly={saving} autoComplete="off" aria-invalid={invalid || undefined}
      aria-describedby={failure ? `${id}-error` : undefined} onChange={(event) => {
        setValue(event.target.value);
        if (invalid) { setInvalid(false); setFailure(''); }
      }}/>
    {failure && <p id={`${id}-error`} role="alert">{failure}</p>}
    <div className="studio-confirm-actions">
      <button type="button" className="studio-confirm-cancel" disabled={saving} onClick={onClose}>{t('editor.rename.cancel')}</button>
      <button type="submit" className="studio-confirm-primary" disabled={saving}>{t('editor.rename.save')}</button>
    </div>
  </form>;
}

export function ProjectRenameDialog({ title, onRename, onClose, returnFocus }: {
  title: string;
  onRename: RenameProject;
  onClose(): void;
  returnFocus(): HTMLElement | null;
}) {
  const { t } = useI18n();
  const id = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const busy = useRef(false);
  const cancel = () => { if (!busy.current) onClose(); };
  useModalFocus(true, dialog, cancel, input, returnFocus);
  return createPortal(<div className="studio-confirm-backdrop" onMouseDown={cancel}>
    <div ref={dialog} className="studio-confirm-dialog project-rename-dialog" role="dialog" aria-modal="true"
      tabIndex={-1} aria-labelledby={id} onMouseDown={(event) => event.stopPropagation()}>
      <h2 id={id}>{t('editor.rename.title')}</h2>
      <ProjectRenameForm title={title} onRename={onRename} onClose={onClose} input={input} busy={busy}/>
    </div>
  </div>, document.body);
}
