import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, TriangleAlert, X } from 'lucide-react';
import { useModalFocus } from '../use-modal-focus';
import './confirmation-dialog.css';

export interface StudioConfirmOptions {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: 'warning' | 'neutral';
}

interface PendingConfirmation extends StudioConfirmOptions {
  resolve(value: boolean): void;
}

function ConfirmationDialog({ request, onResolve }: { request: PendingConfirmation; onResolve(value: boolean): void }) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  useModalFocus(true, dialogRef, () => onResolve(false), cancelRef);

  const warning = request.tone !== 'neutral';
  return <div className="studio-confirm-backdrop" onMouseDown={() => onResolve(false)}>
    <div
      ref={dialogRef}
      className={`studio-confirm-dialog ${warning ? 'warning' : 'neutral'}`}
      role="alertdialog"
      tabIndex={-1}
      aria-modal="true"
      aria-labelledby="studio-confirm-title"
      aria-describedby="studio-confirm-message"
      onMouseDown={(event) => event.stopPropagation()}
    >
      <button className="studio-confirm-close" aria-label="Cancel" title="Cancel" onClick={() => onResolve(false)}><X size={17}/></button>
      <div className="studio-confirm-symbol" aria-hidden="true">{warning ? <TriangleAlert size={20}/> : <Check size={20}/>}</div>
      <div className="studio-confirm-copy">
        <strong id="studio-confirm-title">{request.title}</strong>
        <p id="studio-confirm-message">{request.message}</p>
      </div>
      <div className="studio-confirm-actions">
        <button ref={cancelRef} className="studio-confirm-cancel" onClick={() => onResolve(false)}>{request.cancelLabel || 'Cancel'}</button>
        <button className="studio-confirm-primary" onClick={() => onResolve(true)}>{request.confirmLabel}</button>
      </div>
    </div>
  </div>;
}

export function useStudioConfirm() {
  const [request, setRequest] = useState<PendingConfirmation | null>(null);
  const pendingRef = useRef<PendingConfirmation | null>(null);

  const resolveCurrent = useCallback((value: boolean) => {
    const current = pendingRef.current;
    pendingRef.current = null;
    setRequest(null);
    current?.resolve(value);
  }, []);

  const confirm = useCallback((options: StudioConfirmOptions) => new Promise<boolean>((resolve) => {
    // A confirmation is an exclusive interruption. If another action somehow
    // requests one before the current dialog resolves, fail the older action
    // safely instead of orphaning its Promise.
    pendingRef.current?.resolve(false);
    const next = { ...options, resolve };
    pendingRef.current = next;
    setRequest(next);
  }), []);

  useEffect(() => () => {
    pendingRef.current?.resolve(false);
    pendingRef.current = null;
  }, []);

  return {
    confirm,
    confirmationDialog: request ? <ConfirmationDialog request={request} onResolve={resolveCurrent}/> : null,
  };
}
