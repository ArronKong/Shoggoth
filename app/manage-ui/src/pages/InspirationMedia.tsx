import { useEffect, useLayoutEffect, useRef, useState, type TextareaHTMLAttributes } from 'react';
import { useTranslation } from 'react-i18next';
import type { InspirationAttachment } from '../types';
import { TextArea } from '../components/Field';
import { INSPIRATION_MEDIA_TYPES, INSPIRATION_MEDIA_ACCEPT, MAX_INSPIRATION_ATTACHMENTS, MAX_INSPIRATION_MEDIA_BYTES,
  inspirationMediaLimit, isInspirationDocument, normalizeMediaType, uploadInspirationMedia } from './inspiration-media';
import InspirationMediaPreview from './InspirationMediaPreview';
import { inspirationContentParts, editInspirationText, insertInspirationMedia, moveInspirationInsertion,
  type InspirationContentValue, type InspirationInsertionPoint, type InspirationTextPart } from './inspiration-content';
import styles from './InspirationMedia.module.css';
export { InspirationMediaPreview };

function MediaIcon({ name }: { name: 'image' | 'mic' | 'stop' | 'remove' }) {
  if (name === 'stop') return <span className={styles.stopIcon} aria-hidden="true" />;
  return <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {name === 'image' ? <><rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="8" cy="8" r="1.5" /><path d="m3 17 5-5 4 4 4-6 5 7" /></>
      : name === 'mic' ? <><rect x="9" y="2" width="6" height="13" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8" /></>
        : <path d="m6 6 12 12M6 18 18 6" />}
  </svg>;
}

type Upload = { file: File; id: string; point: InspirationInsertionPoint };
export default function InspirationMediaEditor({ body, attachments, onChange, onBusyChange, disabled = false, inputProps, capture = false }: {
  body: string; attachments: InspirationAttachment[]; onChange: (update: (previous: InspirationContentValue) => InspirationContentValue) => void;
  onBusyChange: (busy: boolean) => void; disabled?: boolean; capture?: boolean;
  inputProps?: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'>;
}) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<'idle' | 'uploading' | 'permission' | 'recording' | 'stopping'>('idle');
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState('');
  const [failed, setFailed] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const timer = useRef<number>();
  const mounted = useRef(true);
  const locked = useRef(false);
  const pending = useRef<Upload[]>([]);
  const selection = useRef<InspirationInsertionPoint>({ offset: body.length, beforeId: null });
  const recordingPoint = useRef<InspirationInsertionPoint | null>(null);
  const contentElement = useRef<HTMLDivElement>(null);
  const textInputs = useRef(new Map<string, HTMLTextAreaElement>());
  const focusAfterUpload = useRef<string | null>(null);
  const parts = inspirationContentParts({ body, attachments });
  const isFilePart = (part: (typeof parts)[number] | undefined) => part?.kind === 'media'
    && part.attachments.every(item => isInspirationDocument(item.mimeType));
  const props = useRef({ body, attachments, onChange, onBusyChange, disabled });
  props.current = { body, attachments, onChange, onBusyChange, disabled };
  const updateScrollFade = () => {
    const viewport = contentElement.current;
    if (!viewport) return;
    const overflow = viewport.scrollHeight - viewport.clientHeight;
    viewport.toggleAttribute('data-fade-top', overflow > 1 && viewport.scrollTop > 1);
    viewport.toggleAttribute('data-fade-bottom', overflow > 1 && viewport.scrollTop < overflow - 1);
  };
  useLayoutEffect(() => {
    let active = true;
    const fit = () => {
      if (!active) return;
      textInputs.current.forEach(input => {
        input.style.height = '0px';
        input.style.height = `${input.scrollHeight}px`;
      });
      updateScrollFade();
    };
    fit();
    void document.fonts?.ready.then(fit);
    const viewport = contentElement.current;
    const observer = new ResizeObserver(fit);
    if (viewport) observer.observe(viewport);
    return () => { active = false; observer.disconnect(); };
  }, [body, attachments, capture]);
  useLayoutEffect(() => {
    const key = focusAfterUpload.current;
    if (!key) return;
    const media = parts.find(part => part.kind === 'media' && part.attachments.some(item => item.id === key));
    const input = textInputs.current.get(media?.key ?? key);
    if (input) { focusAfterUpload.current = null; input.focus(); input.setSelectionRange(0, 0); }
  }, [attachments]);
  const rememberSelection = (input: HTMLTextAreaElement, part: InspirationTextPart) => {
    selection.current = { offset: part.start + input.selectionEnd, beforeId: part.beforeId };
  };
  const changeText = (part: InspirationTextPart, input: HTMLTextAreaElement) => {
    const text = input.value;
    if (recordingPoint.current) recordingPoint.current = moveInspirationInsertion(recordingPoint.current, part, text);
    pending.current.forEach(job => { job.point = moveInspirationInsertion(job.point, part, text); });
    rememberSelection(input, part);
    onChange(previous => editInspirationText(previous, part, text));
  };
  const releaseMicrophone = () => {
    window.clearInterval(timer.current);
    stream.current?.getTracks().forEach(track => track.stop()); stream.current = null;
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (recorder.current) {
        recorder.current.onstop = null; recorder.current.ondataavailable = null; recorder.current.onerror = null;
        if (recorder.current.state !== 'inactive') recorder.current.stop();
      }
      releaseMicrophone();
    };
  }, []);
  const transition = (next: typeof mode, keepBusy = false) => {
    if (!mounted.current) return;
    locked.current = next !== 'idle' || keepBusy;
    setMode(next); props.current.onBusyChange(locked.current);
  };
  const uploadPending = async () => {
    setError(''); setFailed(false); transition('uploading');
    try {
      while (pending.current.length && mounted.current) {
        const job = pending.current[0];
        const attachment = await uploadInspirationMedia(job.file, job.id, () => mounted.current);
        if (!attachment) return;
        focusAfterUpload.current = attachment.id;
        props.current.onChange(previous => insertInspirationMedia(previous, attachment, job.point));
        pending.current.shift();
      }
      transition('idle');
    } catch {
      if (mounted.current) { setError(t('inspiration.media.uploadFailed')); setFailed(true); transition('idle', true); }
    }
  };
  const addFiles = (files: File[], point = selection.current) => {
    if (props.current.disabled || locked.current || !files.length) return;
    if (files.length + props.current.attachments.length > MAX_INSPIRATION_ATTACHMENTS) { setError(t('inspiration.media.tooMany')); return; }
    if (files.some(file => !INSPIRATION_MEDIA_TYPES.includes(normalizeMediaType(file.type, file.name)))) { setError(t('inspiration.media.unsupported')); return; }
    if (files.some(file => !file.size || file.size > inspirationMediaLimit(normalizeMediaType(file.type, file.name)))) { setError(t('inspiration.media.tooLarge')); return; }
    if (files.some(file => new TextEncoder().encode(JSON.stringify(file.name)).length > 256 || /[\x00-\x1f\x7f]/.test(file.name))) {
      setError(t('inspiration.media.fileName')); return;
    }
    pending.current = files.map(file => ({ file, id: crypto.randomUUID(), point: { ...point } }));
    void uploadPending();
  };
  const stop = () => {
    if (recorder.current?.state === 'recording') { transition('stopping'); recorder.current.stop(); releaseMicrophone(); }
  };
  const record = async () => {
    if (props.current.disabled || locked.current) return;
    if (props.current.attachments.length >= MAX_INSPIRATION_ATTACHMENTS) { setError(t('inspiration.media.tooMany')); return; }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') { setError(t('inspiration.media.recordUnsupported')); return; }
    recordingPoint.current = { ...selection.current };
    transition('permission'); setError('');
    try {
      const desktop = (window as unknown as { openclawDesktop?: { requestMicrophoneAccess?: () => Promise<boolean> } }).openclawDesktop;
      if (desktop?.requestMicrophoneAccess && !await desktop.requestMicrophoneAccess()) throw new DOMException('Microphone access denied', 'NotAllowedError');
      if (!mounted.current) return;
      const acquired = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!mounted.current) { acquired.getTracks().forEach(track => track.stop()); return; }
      stream.current = acquired;
      const mimeType = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find(type => MediaRecorder.isTypeSupported(type));
      if (!mimeType) throw new Error('Unsupported recording format');
      const active = new MediaRecorder(acquired, { mimeType, audioBitsPerSecond: 64000 });
      recorder.current = active;
      const chunks: Blob[] = [];
      let size = 0, recordingError = false;
      active.ondataavailable = event => {
        if (event.data.size) { chunks.push(event.data); size += event.data.size; }
        if (size >= MAX_INSPIRATION_MEDIA_BYTES && active.state === 'recording') stop();
      };
      active.onerror = () => { recordingError = true; stop(); };
      active.onstop = () => {
        releaseMicrophone(); recorder.current = null;
        if (!mounted.current) return;
        transition('idle');
        const point = recordingPoint.current || selection.current;
        recordingPoint.current = null;
        if (recordingError || !size) { setError(t('inspiration.media.recordFailed')); return; }
        const type = normalizeMediaType(active.mimeType);
        const extension = type === 'audio/mp4' ? 'm4a' : type === 'audio/ogg' ? 'ogg' : 'webm';
        addFiles([new File(chunks, `${t('inspiration.media.voiceName')}-${new Date().toISOString().replace(/[:.]/g, '-')}.${extension}`, { type })], point);
      };
      active.start(1000); setSeconds(0); transition('recording');
      const startedAt = Date.now();
      timer.current = window.setInterval(() => {
        const elapsed = Math.floor((Date.now() - startedAt) / 1000); setSeconds(elapsed);
        if (elapsed >= 300) stop();
      }, 250);
    } catch (cause) {
      releaseMicrophone(); recorder.current = null; recordingPoint.current = null; transition('idle');
      if (mounted.current) setError(t(cause instanceof DOMException && cause.name === 'NotAllowedError'
        ? 'inspiration.media.permissionDenied' : 'inspiration.media.recordFailed'));
    }
  };
  const busy = mode !== 'idle' || failed;
  return <div className={styles.editor} data-capture={capture || undefined} data-busy={busy || undefined} data-drag-over={dragOver || undefined}
    onPaste={event => {
      const files = event.clipboardData.files?.length ? Array.from(event.clipboardData.files)
        : Array.from(event.clipboardData.items).filter(item => item.kind === 'file').map(item => item.getAsFile()).filter((file): file is File => Boolean(file));
      if (files.length) { event.preventDefault(); addFiles(files); }
    }} onDragOver={event => {
      if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = disabled || busy ? 'none' : 'copy'; setDragOver(!disabled && !busy); }
    }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragOver(false); }}
    onDrop={event => { event.preventDefault(); setDragOver(false); addFiles(Array.from(event.dataTransfer.files)); }}>
    <div ref={contentElement} className={styles.editorContent} data-inspiration-media-content onScroll={updateScrollFade}>
      {parts.map((part, index) => part.kind === 'media'
        ? <InspirationMediaPreview key={`media:${part.key}`} attachments={part.attachments} disabled={disabled || busy}
          onRemove={ids => onChange(previous => ({ ...previous, attachments: previous.attachments.filter(item => !ids.includes(item.id)) }))} />
        : <TextArea {...inputProps} key={`text:${part.key}`} ref={input => {
          if (input) textInputs.current.set(part.key, input); else textInputs.current.delete(part.key);
        }} className={`field-textarea ${styles.textInput}`} value={part.text} rows={attachments.length ? 1 : (inputProps?.rows ?? 1)} disabled={disabled}
          spellCheck={false} autoCorrect="off" autoCapitalize="off" autoComplete="off" data-inline-text={attachments.length > 0 || undefined}
          data-file-gap={part.text === '' && isFilePart(parts[index - 1]) && isFilePart(parts[index + 1]) || undefined}
          placeholder={attachments.length ? '' : inputProps?.placeholder}
          onFocus={event => { rememberSelection(event.currentTarget, part); inputProps?.onFocus?.(event); }}
          onSelect={event => { rememberSelection(event.currentTarget, part); inputProps?.onSelect?.(event); }}
          onChange={event => changeText(part, event.currentTarget)}
          onKeyDown={event => {
            inputProps?.onKeyDown?.(event);
            if (event.defaultPrevented || event.shiftKey || event.altKey || event.metaKey || event.ctrlKey || event.nativeEvent.isComposing) return;
            const input = event.currentTarget;
            if (input.selectionStart !== input.selectionEnd) return;
            const atStart = input.selectionStart === 0 && ['ArrowLeft', 'ArrowUp', 'Backspace'].includes(event.key);
            const atEnd = input.selectionEnd === part.text.length && ['ArrowRight', 'ArrowDown', 'Delete'].includes(event.key);
            const texts = parts.filter((value): value is InspirationTextPart => value.kind === 'text');
            const next = texts[texts.indexOf(part) + (atStart ? -1 : atEnd ? 1 : 0)];
            if ((!atStart && !atEnd) || !next) return;
            const target = textInputs.current.get(next.key);
            if (target) { event.preventDefault(); target.focus(); const offset = atStart ? next.text.length : 0; target.setSelectionRange(offset, offset); }
          }} />)}
    </div>
    <div className={styles.toolbar}>
      <input ref={fileInput} type="file" multiple accept={INSPIRATION_MEDIA_ACCEPT} hidden aria-label={t('inspiration.media.choose')}
        disabled={disabled || busy} onChange={event => { addFiles(Array.from(event.target.files || [])); event.target.value = ''; }} />
      {!capture && <button type="button" className={styles.tool} disabled={disabled || busy} onClick={() => fileInput.current?.click()} title={t('inspiration.media.choose')} aria-label={t('inspiration.media.choose')}>
        <MediaIcon name="image" />
      </button>}
      <button type="button" className={styles.tool} disabled={disabled || (busy && mode !== 'recording')} data-recording={mode === 'recording' || undefined}
        onClick={mode === 'recording' ? stop : () => { void record(); }} title={t(mode === 'recording' ? 'inspiration.media.stop' : 'inspiration.media.record')}
        aria-label={t(mode === 'recording' ? 'inspiration.media.stop' : 'inspiration.media.record')}>
        <MediaIcon name={mode === 'recording' ? 'stop' : 'mic'} />
      </button>
      <span className={styles.hint} role="status">{mode === 'recording' ? `${t('inspiration.media.recording')} ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
        : mode !== 'idle' ? t(`inspiration.media.${mode}`) : capture ? '' : t('inspiration.media.hint')}</span>
    </div>
    {error && <div className={styles.error} role="alert">{error}{failed && <span className={styles.retry}>
      <button type="button" onClick={() => { void uploadPending(); }}>{t('inspiration.media.retry')}</button>
      <button type="button" onClick={() => { pending.current = []; setFailed(false); setError(''); transition('idle'); }}>{t('inspiration.media.discard')}</button>
    </span>}</div>}
  </div>;
}
