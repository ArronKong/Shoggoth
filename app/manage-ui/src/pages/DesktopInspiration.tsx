import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { createInspiration, listInspirations } from '../api/client';
import { desktopInspirationBridge, type DesktopPrinterGeometry } from '../lib/desktop-inspiration';
import InspirationTypewriter from './InspirationTypewriter';
import InspirationCapture from './InspirationCapture';
import InspirationMediaEditor from './InspirationMedia';
import InspirationArchiveControls from './InspirationArchiveControls';
import { draftBytes, pickNextPaperTone, useInspirationDraft } from './inspiration-draft';
import { prepareInspirationPaperFlight, type InspirationPaperFlight } from './inspiration-paper-motion';
import { captureDesktopPrinterFrame, prepareDesktopPrinterMotion, type DesktopPrinterFrame, type DesktopPrinterMotion } from './desktop-printer-motion';
import styles from './DesktopInspiration.module.css';

export default function DesktopInspiration() {
  const { t } = useTranslation();
  const host = desktopInspirationBridge();
  const { draft, draftRef, draftStored, updateDraft, clearSavedDraft } = useInspirationDraft();
  const [count, setCount] = useState<number | null>(null);
  const [active, setActive] = useState(false);
  const [presentation, setPresentation] = useState<{ geometry?: DesktopPrinterGeometry; concealId?: number; from?: DesktopPrinterFrame } | null>(null);
  const [saving, setSaving] = useState(false), [printing, setPrinting] = useState(false);
  const [mediaBusy, setMediaBusy] = useState(false), [archiveBusy, setArchiveBusy] = useState(false);
  const [reset, setReset] = useState(0), [error, setError] = useState('');
  const root = useRef<HTMLDivElement>(null), workbench = useRef<HTMLDivElement>(null), paper = useRef<HTMLDivElement>(null);
  const busy = useRef({ saving: false, media: false, archive: false });
  const flight = useRef<InspirationPaperFlight | null>(null), reveal = useRef<DesktopPrinterMotion | null>(null);
  const closing = useRef(false);
  const [printJob, setPrintJob] = useState(0);
  const alive = useRef(true);
  const publishBusy = () => host?.setBusy?.(Object.values(busy.current).some(Boolean));
  const changeMediaBusy = (value: boolean) => { busy.current.media = value; setMediaBusy(value); publishBusy(); };
  const changeArchiveBusy = (value: boolean) => { busy.current.archive = value; setArchiveBusy(value); publishBusy(); };
  const refreshCount = useCallback(async () => {
    try {
      const result = await listInspirations({ query: '', filter: 'all', cursor: null, limit: 1 });
      if (alive.current) setCount(result.total);
    } catch { /* A transient count failure does not discard the draft. */ }
  }, []);

  useEffect(() => {
    alive.current = true;
    let interactive = false;
    const updateGeometry = (geometry?: DesktopPrinterGeometry) => {
      if (geometry && root.current) {
        root.current.style.setProperty('--desktop-top', `${geometry.top}px`);
        root.current.style.setProperty('--desktop-center', `${geometry.center}px`);
      }
    };
    const show = (geometry?: DesktopPrinterGeometry) => {
      if (!alive.current) return;
      interactive = false;
      const from = closing.current ? captureDesktopPrinterFrame(workbench.current, paper.current) : undefined;
      closing.current = false;
      updateGeometry(geometry);
      setActive(true); setReset(value => value + 1); setError('');
      setPresentation({ geometry, from });
      void refreshCount();
    };
    const hide = (concealId: number) => {
      interactive = false; closing.current = true;
      host?.setInteractive?.(false);
      setPresentation({ concealId, from: captureDesktopPrinterFrame(workbench.current, paper.current) });
    };
    const hidden = () => { interactive = false; closing.current = false; setActive(false); reveal.current?.cancel(); };
    const offShow = host?.onShow?.(show), offHide = host?.onHide?.(hide), offHidden = host?.onHidden?.(hidden);
    const offGeometry = host?.onGeometry?.(updateGeometry);
    // A new desktop renderer has a cold font cache. Load the shared paper face
    // before showing the native window so the first keystroke uses it too.
    const fontsReady = paper.current && document.fonts
      ? document.fonts.load(`400 12px ${getComputedStyle(paper.current).fontFamily}`, '灵感 Spark Notes').catch(() => [])
      : Promise.resolve();
    if (host?.ready) void fontsReady.then(() => alive.current ? host.ready!() : undefined)
      .catch(() => setError(t('inspiration.desktop.openFailed')));
    else show();
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || Object.values(busy.current).some(Boolean)) return;
      event.preventDefault(); void host?.dismiss?.();
    };
    const pointer = (event: PointerEvent) => {
      if (closing.current) return;
      const next = Boolean((event.target as Element).closest?.('[data-desktop-interactive], [data-paper], [data-typewriter-housing], [data-typewriter] button'));
      if (next !== interactive) { interactive = next; host?.setInteractive?.(next); }
    };
    document.addEventListener('keydown', escape); document.addEventListener('pointermove', pointer);
    return () => {
      alive.current = false; offShow?.(); offHide?.(); offHidden?.(); offGeometry?.(); reveal.current?.cancel(); flight.current?.cancel();
      host?.setBusy?.(false); host?.setInteractive?.(false);
      document.removeEventListener('keydown', escape); document.removeEventListener('pointermove', pointer);
    };
  }, [host, refreshCount, t]);

  useLayoutEffect(() => {
    if (!active || !presentation) return;
    const exiting = presentation.concealId !== undefined;
    if (root.current) root.current.inert = exiting;
    const animation = prepareDesktopPrinterMotion(workbench.current, paper.current, exiting, presentation.from);
    reveal.current = animation;
    let current = true;
    const play = () => {
      if (!current || !alive.current) return;
      animation?.play();
      paper.current?.querySelector('textarea')?.focus({ preventScroll: true });
    };
    const id = presentation.geometry?.presentationId;
    if (exiting) {
      animation?.play();
      void (animation?.finished ?? Promise.resolve()).then(() => {
        if (current && alive.current && closing.current) return host?.conceal?.(presentation.concealId!);
      }).catch(() => { /* The native timeout still closes an unresponsive surface. */ });
    } else if (host?.reveal && id !== undefined) {
      void host.reveal(id).then(shown => { if (shown) play(); else animation?.cancel(); })
        .catch(() => { animation?.cancel(); if (current) setError(t('inspiration.desktop.openFailed')); });
    } else play();
    return () => { current = false; animation?.cancel(); };
  }, [active, presentation, host, t]);

  useLayoutEffect(() => {
    if (!printJob) return;
    const animation = flight.current; flight.current = null;
    let current = true;
    void (animation?.play(null) ?? Promise.resolve()).finally(() => {
      if (!current || !alive.current) return;
      busy.current.saving = false; setPrinting(false); publishBusy();
      paper.current?.querySelector('textarea')?.focus({ preventScroll: true });
      void refreshCount();
    });
    return () => { current = false; animation?.cancel(); };
  }, [printJob]);

  const save = async () => {
    const submitted = draftRef.current;
    if (closing.current || Object.values(busy.current).some(Boolean) || (!submitted.body.trim() && !submitted.attachments?.length) || draftBytes(submitted.body) > 16 * 1024) return;
    reveal.current?.cancel();
    busy.current.saving = true; publishBusy(); setSaving(true); setError('');
    let animationScheduled = false;
    try {
      const { idea } = await createInspiration(submitted);
      const target = await host?.trayTarget?.().catch(() => undefined);
      if (!alive.current) return;
      try {
        if (draftRef.current.operationId === submitted.operationId) flight.current = prepareInspirationPaperFlight(paper.current, root.current,
          target ?? { x: window.innerWidth - 36, y: 12 });
      } catch { /* A display/animation failure must not turn a saved note into a retry. */ }
      clearSavedDraft(submitted, pickNextPaperTone(idea.paperTone ?? submitted.paperTone ?? 0));
      animationScheduled = true;
      setSaving(false); setPrinting(Boolean(flight.current)); setPrintJob(value => value + 1);
    } catch (failure) {
      if (alive.current) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (alive.current) setSaving(false);
      if (!animationScheduled) { busy.current.saving = false; publishBusy(); }
    }
  };
  const draftError = draftBytes(draft.body) > 16 * 1024 ? t('inspiration.tooLong') : !draftStored ? t('inspiration.draftMemory') : '';
  return <div ref={root} className={styles.desktop} data-desktop-printer data-active={active || undefined}
    data-exiting={(active && presentation?.concealId !== undefined) || undefined}>
    <div className={styles.position}>
      <div ref={workbench} className={styles.workbench} data-desktop-workbench>
        <InspirationTypewriter active={active} saving={saving} paperRef={paper} paperTone={draft.paperTone ?? 0} ideaCount={count}
          accessory={<InspirationArchiveControls ideaCount={count} disabled={saving || printing || mediaBusy || archiveBusy}
            getDraft={() => draftRef.current} onBusyChange={changeArchiveBusy} resetRequest={reset} />}>
          <InspirationCapture disabled={saving || printing || archiveBusy}>
            <InspirationMediaEditor capture body={draft.body} attachments={draft.attachments || []} disabled={saving || printing || archiveBusy}
              onBusyChange={changeMediaBusy} onChange={update => {
                const next = update({ body: draftRef.current.body, attachments: draftRef.current.attachments || [] }); updateDraft(next.body, next.attachments);
              }} inputProps={{ 'aria-label': t('inspiration.capture'), 'aria-keyshortcuts': 'Enter', rows: 1, placeholder: t('inspiration.placeholder'),
                onKeyDown: event => {
                  if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
                  event.preventDefault(); if (!event.repeat) void save();
                } }} />
          </InspirationCapture>
        </InspirationTypewriter>
        {(draftError || error) && <p className={styles.error} role="alert" data-desktop-interactive>{draftError || error}</p>}
      </div>
    </div>
  </div>;
}
