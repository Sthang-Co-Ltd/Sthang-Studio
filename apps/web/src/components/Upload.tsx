import { useEffect, useId, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { FileUp } from 'lucide-react';
import { StudioBrand } from './Brand';
import './upload-feedback.css';

// These are candidate-file hints, never a claim that the bytes can be decoded.
// Keep unfamiliar containers on the existing import path; rule out only clear
// non-media selections, including when the browser supplies no MIME type.
const mediaExtension = /\.(?:3g2|3gp|aac|ac3|aif|aiff|amr|ape|au|avi|caf|flac|flv|m2ts|m4a|m4b|m4v|mka|mkv|mov|mp2|mp3|mp4|mpeg|mpg|mts|oga|ogg|ogv|opus|ts|vob|wav|webm|wma|wmv)$/i;
const nonMediaExtension = /\.(?:7z|avif|bat|bmp|bz2|cmd|css|csv|doc|docx|eot|exe|gif|gz|heic|htm|html|ico|jpeg|jpg|js|json|md|msi|odt|otf|pdf|png|ppt|pptx|ps1|rar|rtf|srt|svg|tar|tif|tiff|tsv|ttf|ttml|txt|vtt|webp|woff|woff2|xls|xlsx|xml|zip)$/i;
const nonMediaMime = /^(?:image\/|text\/|font\/|application\/(?:pdf|json|xml|javascript|(?:x-)?zip|(?:x-)?rar|x-7z-compressed|gzip|x-tar|x-msdownload|x-msi|msword|vnd\.(?:ms-|openxmlformats-officedocument|oasis\.opendocument)))/i;
function clearlyNonMedia(file: File) {
  return !/^(?:audio|video)\//i.test(file.type) && !mediaExtension.test(file.name)
    && (nonMediaExtension.test(file.name) || nonMediaMime.test(file.type));
}
function fileDrag(event: DragEvent<HTMLElement>) {
  return Array.from(event.dataTransfer.types).includes('Files') || event.dataTransfer.files.length > 0;
}

export function Upload({ onUpload, busy, beforeDropzone }: { onUpload:(file:File,title:string)=>void | Promise<unknown>; busy:boolean; beforeDropzone?: ReactNode }) {
  const ref = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const submitting = useRef(false);
  const busyRef = useRef(busy); busyRef.current = busy;
  const [drag, setDrag] = useState(false);
  const [validation, setValidation] = useState('');
  const statusId = useId();
  const clearDrag = () => { dragDepth.current = 0; setDrag(false); };
  useEffect(() => {
    const clear = () => { dragDepth.current = 0; setDrag(false); };
    const leaveDocument = (event: globalThis.DragEvent) => {
      const edge = event.clientX <= 0 || event.clientY <= 0 || event.clientX >= window.innerWidth || event.clientY >= window.innerHeight;
      if (!event.relatedTarget && edge && (event.target === document || event.target === document.documentElement || event.target === document.body)) clear();
    };
    document.addEventListener('dragend', clear);
    document.addEventListener('drop', clear);
    document.addEventListener('dragleave', leaveDocument);
    window.addEventListener('blur', clear);
    return () => {
      document.removeEventListener('dragend', clear);
      document.removeEventListener('drop', clear);
      document.removeEventListener('dragleave', leaveDocument);
      window.removeEventListener('blur', clear);
    };
  }, []);
  useEffect(() => { if (busy) clearDrag(); }, [busy]);
  const accept = (files: File[]) => {
    clearDrag();
    if (busyRef.current || submitting.current || !files.length) return;
    if (files.length !== 1) { setValidation('Choose one video or audio file at a time.'); return; }
    const file = files[0];
    if (clearlyNonMedia(file)) { setValidation('That file type is not supported here. Choose a video or audio file.'); return; }
    setValidation('');
    submitting.current = true;
    const release = () => { submitting.current = false; };
    try {
      // The upload owner reports request errors through the shared toast stack.
      // Hold admission until it settles, including a second event before busy renders.
      void Promise.resolve(onUpload(file, file.name.replace(/\.[^.]+$/, ''))).then(release, release);
    } catch (error) { release(); throw error; }
  };
  return <div className="empty-stage">
    <StudioBrand variant="hero" moduleLabel="CAPTIONS" moduleDescriptor=""/>
    <h1>Accurate Khmer captions, ready for CapCut.</h1>
    <p className="lead">Upload, generate, review, and export.</p>
    {beforeDropzone}
    <button aria-label="Choose a video or audio file" aria-describedby={validation ? statusId : undefined} aria-busy={busy || undefined}
      className={`dropzone ${drag && !busy?'drag':''}`} onClick={()=>{ if (!busyRef.current && !submitting.current) ref.current?.click(); }}
      onDragEnter={event=>{
        if (busyRef.current || submitting.current || !fileDrag(event)) return;
        event.preventDefault(); dragDepth.current++; setDrag(true);
      }}
      onDragOver={event=>{
        if (!fileDrag(event)) return;
        event.preventDefault(); event.dataTransfer.dropEffect = busyRef.current || submitting.current ? 'none' : 'copy';
        if (!busyRef.current && !submitting.current) { dragDepth.current = Math.max(1, dragDepth.current); setDrag(true); }
      }}
      onDragLeave={event=>{
        if (!dragDepth.current) return;
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        const target = event.relatedTarget;
        if (target instanceof Node && event.currentTarget.contains(target)) { dragDepth.current = Math.max(1, dragDepth.current); return; }
        if (target instanceof Node || !dragDepth.current) clearDrag();
      }}
      onDrop={event=>{event.preventDefault();accept(Array.from(event.dataTransfer.files));}} disabled={busy}>
      <FileUp className="upload-file-icon" size={34}/><strong>{busy?'Uploading…':drag?'Drop to import':'Choose a video or audio file'}</strong><span>Or drag a file here · MP4, MOV, MP3, WAV and more</span>
    </button>
    <p id={statusId} className="upload-validation" role="status" aria-live="polite" aria-atomic="true">{validation}</p>
    <input ref={ref} hidden disabled={busy} type="file" accept="video/*,audio/*" onChange={event=>{
      const files = Array.from(event.currentTarget.files || []);
      event.currentTarget.value = '';
      accept(files);
    }}/>
    <div className="sthang-parent-note">A STHANG PRODUCT</div>
  </div>;
}
