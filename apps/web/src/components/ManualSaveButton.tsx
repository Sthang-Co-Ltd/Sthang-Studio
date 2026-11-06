import { useEffect, useRef, useState } from 'react';
import { Check, Save } from 'lucide-react';

interface Props {
  unfinished: boolean;
  disabled: boolean;
  confirmed: boolean;
  pending: boolean;
  title: string;
  onSave(): void;
}

/** Acknowledgement belongs only to this explicit request and editor visit. */
export function useManualSaveFeedback(scope: object, unfinished: boolean) {
  const [confirmed, setConfirmed] = useState<object | null>(null);
  const [pending, setPending] = useState(false);
  const request = useRef(0);
  const inFlight = useRef(false);
  const currentScope = useRef(scope); currentScope.current = scope;
  useEffect(() => {
    setConfirmed(null);
    setPending(false);
    inFlight.current = false;
    request.current++;
    return () => { request.current++; };
  }, [scope]);
  useEffect(() => { if (unfinished) setConfirmed(null); }, [unfinished]);
  useEffect(() => {
    if (!confirmed) return;
    const timer = window.setTimeout(() => setConfirmed(null), 1600);
    return () => window.clearTimeout(timer);
  }, [confirmed]);

  const run = async (save: () => Promise<boolean>) => {
    if (!unfinished || inFlight.current) return false;
    const ownedRequest = ++request.current;
    inFlight.current = true;
    setConfirmed(null);
    setPending(true);
    try {
      const saved = await save();
      if (saved && ownedRequest === request.current && currentScope.current === scope) setConfirmed(scope);
      return saved;
    } finally {
      if (ownedRequest === request.current) { inFlight.current = false; setPending(false); }
    }
  };
  return { confirmed: confirmed === scope && !unfinished, pending, run };
}

export function ManualSaveButton({ unfinished, disabled, confirmed, pending, title, onSave }: Props) {
  const showConfirmation = confirmed && !unfinished;
  return <button className="save-action" disabled={disabled || pending} data-tooltip={title} data-tooltip-shortcut="Ctrl S" aria-keyshortcuts="Control+S Meta+S"
    data-save-confirmed={showConfirmation || undefined} aria-busy={pending || undefined}
    onClick={onSave}>
    <span className="save-action-icon" aria-hidden="true"><Save size={16}/><Check size={16}/></span>
    <span className="save-action-label">{unfinished ? 'Save' : 'Saved'}</span>
    <span className="sr-only" role="status">{showConfirmation ? 'Changes saved.' : ''}</span>
  </button>;
}
