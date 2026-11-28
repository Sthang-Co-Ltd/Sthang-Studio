import { useId, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { useI18n } from '../i18n';
import './project-color-field.css';

interface Props {
  label: string;
  inputLabel?: string;
  value: string;
  colors: string[];
  onChange(value: string): void;
}

export function ProjectColorField({ label, inputLabel, value, colors, onChange }: Props) {
  const { t } = useI18n();
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const hex = value.toUpperCase();
  const palette = Array.from(new Set([...colors, hex]));
  const name = t('appearance.workspace.projectColorsFor', { label });

  function close() {
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  }

  return <div className="project-color-field" onBlur={(event) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
  }} onKeyDown={(event) => {
    if (open && event.key === 'Escape' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  }}>
    <label htmlFor={id}>{label}</label>
    <div className="project-color-controls">
      <input id={id} type="color" list={id + '-choices'} aria-label={inputLabel} value={hex}
        onClick={() => setOpen(false)}
        onChange={(event) => onChange(event.target.value.toUpperCase())}/>
      <button type="button" ref={trigger} aria-expanded={open} aria-controls={open ? id + '-palette' : undefined}
        aria-label={hex + ' · ' + name} title={name} onClick={() => setOpen(!open)}>
        {hex}<ChevronDown aria-hidden="true" size={14}/>
      </button>
    </div>
    <datalist id={id + '-choices'}>{palette.map((color) => <option key={color} value={color}/>)}</datalist>
    {open && <div className="project-color-palette" id={id + '-palette'} role="group" aria-label={name}>
      <span>{t('appearance.workspace.projectColors')}</span>
      <div>{palette.map((color) => <button type="button" key={color} aria-label={color}
        title={color} aria-pressed={color === hex} onClick={() => {
          if (color !== hex) onChange(color);
          close();
        }}>
        <i style={{ backgroundColor: color }} aria-hidden="true"/>
        {color === hex && <Check size={13} aria-hidden="true"/>}
      </button>)}</div>
    </div>}
  </div>;
}
