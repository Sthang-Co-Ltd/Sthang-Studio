import { useEffect, useId, useRef, useState, type CSSProperties, type ChangeEvent, type KeyboardEvent } from 'react';
import { formatTimestamp, parseTimestamp, validateTimestamp } from '../timestamp';

export interface TimestampInputProps {
  valueMs: number;
  label: string;
  minMs?: number;
  maxMs?: number;
  disabled?: boolean;
  onCommit(ms: number): boolean | void;
  onEditingChange?(editing: boolean): void;
  onFocus?(): void;
  className?: string;
}

const wrapperStyle: CSSProperties = {
  display: 'block',
  minWidth: 0,
};

const invalidInputStyle: CSSProperties = {
  outline: '2px solid #c56b6b',
  outlineOffset: 1,
  borderRadius: 4,
};

const errorStyle: CSSProperties = {
  display: 'block',
  marginTop: 3,
  color: '#f0a3a3',
  fontSize: 10,
  lineHeight: 1.25,
  whiteSpace: 'nowrap',
};

export function TimestampInput({
  valueMs,
  label,
  minMs,
  maxMs,
  disabled = false,
  onCommit,
  onEditingChange,
  onFocus,
  className,
}: TimestampInputProps) {
  const [text, setText] = useState(() => formatTimestamp(valueMs));
  const [error, setError] = useState<string | null>(null);
  const currentValue = useRef(valueMs);
  const errorId = useId();

  useEffect(() => {
    currentValue.current = valueMs;
    setText(formatTimestamp(valueMs));
    setError(null);
  }, [valueMs]);

  const validate = (candidate: string) => validateTimestamp(candidate, { minMs, maxMs });
  const commit = (candidate: string) => {
    const parsed = parseTimestamp(candidate);
    if (parsed !== null && parsed === currentValue.current) {
      setError(null);
      setText(formatTimestamp(parsed));
      return false;
    }

    const result = validate(candidate);
    if (!result.ok) {
      setError(result.error);
      return false;
    }

    const accepted = onCommit(result.valueMs);
    if (accepted === false) {
      currentValue.current = valueMs;
      setError(null);
      setText(formatTimestamp(valueMs));
      return false;
    }

    currentValue.current = result.valueMs;
    setError(null);
    setText(formatTimestamp(result.valueMs));
    return true;
  };

  const change = (event: ChangeEvent<HTMLInputElement>) => {
    const next = event.target.value;
    setText(next);
    if (error) {
      const result = validate(next);
      setError(result.ok ? null : result.error);
    }
  };

  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      commit(event.currentTarget.value);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setText(formatTimestamp(currentValue.current));
      setError(null);
    }
  };

  return <span className={`timestamp-input${className ? ` ${className}` : ''}`} style={wrapperStyle}>
    <input
      aria-label={label}
      aria-invalid={error ? 'true' : undefined}
      aria-describedby={error ? errorId : undefined}
      aria-errormessage={error ? errorId : undefined}
      autoComplete="off"
      disabled={disabled}
      inputMode="decimal"
      spellCheck={false}
      style={error ? invalidInputStyle : undefined}
      value={text}
      onClick={(event) => event.stopPropagation()}
      onFocus={() => {
        onFocus?.();
        onEditingChange?.(true);
      }}
      onChange={change}
      onKeyDown={keyDown}
      onBlur={(event) => {
        commit(event.currentTarget.value);
        onEditingChange?.(false);
      }}
    />
    {error && <span id={errorId} role="alert" style={errorStyle}>{error}</span>}
  </span>;
}
