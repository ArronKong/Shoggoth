import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from '../components/ui';
import { buildInspirationArchive, chooseInspirationArchiveDestination, collectInspirationNotes,
  type ArchiveDraft } from './inspiration-archive';
import storageWordmark from '../assets/inspiration/storage-wordmark.svg';
import styles from './InspirationArchiveControls.module.css';

export default function InspirationArchiveControls({ disabled, ideaCount = null, getDraft, onBusyChange, openRequest, onOpenRequestHandled, resetRequest }: {
  ideaCount?: number | null;
  openRequest?: string | null;
  onOpenRequestHandled?: () => void;
  resetRequest?: number;
  disabled: boolean; getDraft: () => ArchiveDraft; onBusyChange: (busy: boolean) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [ejected, setEjected] = useState(false), [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const timer = useRef<number>();
  const alive = useRef(true), working = useRef(false);
  const handledRequest = useRef<string>();
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (timer.current !== undefined) {
        window.clearTimeout(timer.current); timer.current = undefined; working.current = false; onBusyChange(false);
      }
    };
  }, []);
  const start = (animate: boolean) => {
    if (working.current || disabled) return;
    working.current = true; setBusy(true); setEjected(true); onBusyChange(true);
    const run = async () => {
      timer.current = undefined;
      try {
        const now = new Date();
        const pad = (value: number) => String(value).padStart(2, '0');
        const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
        const time = `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
        const name = `Shoggoth-${date}_${time}.shoggoth.zip`;
        const save = await chooseInspirationArchiveDestination(name);
        if (!save) return;
        setProgress(t('inspiration.storage.collecting'));
        const notes = await collectInspirationNotes(structuredClone(getDraft()));
        const bytes = await buildInspirationArchive(notes, (done, total) => {
          if (alive.current) setProgress(t('inspiration.storage.progress', { done, total }));
        });
        if (await save(bytes)) toast.success(t('inspiration.storage.exported'));
      } catch (failure) {
        if (alive.current) {
          const message = failure instanceof Error ? failure.message : String(failure);
          toast.error(t(`inspiration.storage.${message}`, { defaultValue: message }));
        }
      } finally {
        working.current = false; onBusyChange(false);
        if (alive.current) { setBusy(false); setProgress(''); setEjected(false); }
      }
    };
    if (animate && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) timer.current = window.setTimeout(() => { void run(); }, 320);
    else void run();
  };
  useEffect(() => {
    if (!openRequest || handledRequest.current === openRequest || disabled || working.current) return;
    handledRequest.current = openRequest;
    // Programmatic requests start the save directly, once per request.
    start(false); onOpenRequestHandled?.();
  }, [openRequest, disabled, busy]);
  useEffect(() => {
    if (resetRequest !== undefined && !working.current) setEjected(false);
  }, [resetRequest]);
  const label = busy ? progress || t('inspiration.storage.working') : t('inspiration.storage.title');
  return <>
    <div className={styles.cardPort} aria-hidden="true" data-inspiration-sd-card data-ejected={ejected || undefined}>
      <div className={styles.cardSlide}><div className={styles.cardRotation}>
        <div className={styles.sdCard}>
          <div className={styles.cardLabel} lang="en">
            <img className={styles.cardWordmark} src={storageWordmark} alt="" width="26" height="3.688" />
            <span className={styles.cardCount} data-inspiration-sd-count={ideaCount ?? undefined}>{ideaCount ?? '—'}</span>
            <span className={styles.cardTitle}>Spark Notes</span>
          </div>
          <div className={styles.contacts}>{Array.from({ length: 6 }, (_, index) => <i key={index} />)}</div>
        </div>
      </div></div>
    </div>
    <button type="button" className={styles.ejectButton} disabled={disabled || busy} data-inspiration-storage
      aria-label={label} title={label} aria-busy={busy || undefined} onClick={() => start(true)} />
  </>;
}
