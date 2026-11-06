import { useEffect, useRef, useState } from 'react';
import { Check, Clipboard } from 'lucide-react';
import { copyReportText } from '../copy-report';

export function CopyReportButton({ text, label = 'Copy report' }: { text: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'copying' | 'copied' | 'failed'>('idle');
  const request = useRef(0);
  const pending = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    pending.current = false;
    setState('idle');
    return () => { request.current++; if (timer.current) clearTimeout(timer.current); };
  }, [text]);
  const copy = async () => {
    if (pending.current) return;
    pending.current = true;
    const token = ++request.current;
    if (timer.current) clearTimeout(timer.current);
    setState('copying');
    try {
      await copyReportText(text);
      if (request.current !== token) return;
      setState('copied');
      timer.current = setTimeout(() => { if (request.current === token) setState('idle'); }, 2500);
    } catch { if (request.current === token) setState('failed'); }
    finally { if (request.current === token) pending.current = false; }
  };
  return <div className="copy-report-control">
    <button type="button" aria-label={label} aria-busy={state === 'copying' || undefined} aria-disabled={state === 'copying' || undefined} onClick={() => void copy()}>
      {state === 'copied' ? <Check size={15}/> : <Clipboard size={15}/>}
      <span className="copy-report-label"><span aria-hidden="true">{label}</span><span role="status" aria-live="polite">{state === 'copied' ? 'Copied' : state === 'copying' ? 'Copying…' : label}</span></span>
    </button>
    {state === 'failed' && <div className="copy-report-recovery">
      <span role="alert">Could not copy. Try again, or select and copy the report below.</span>
      <textarea aria-label={`${label}: text for manual copying`} readOnly rows={5} value={text} onFocus={(event) => event.currentTarget.select()}/>
    </div>}
  </div>;
}
