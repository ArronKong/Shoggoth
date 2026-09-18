import { useEffect, useId, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import styles from './InspirationPage.module.css';

const MIN_HEIGHT = 210;
const MAX_HEIGHT = 460;
const clampHeight = (height: number) => Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, height));

export default function InspirationCapture({ children, disabled }: { children: ReactNode; disabled: boolean }) {
  const { t } = useTranslation();
  const id = useId();
  const capture = useRef<HTMLElement>(null);
  const drag = useRef<{ pointerId: number; y: number; height: number; scale: number; handle: HTMLButtonElement } | null>(null);
  const [height, setHeight] = useState<number | null>(null);
  const [measuredHeight, setMeasuredHeight] = useState(MIN_HEIGHT);
  const [resizing, setResizing] = useState(false);

  const releasePointer = () => {
    const active = drag.current;
    drag.current = null;
    if (active?.handle.hasPointerCapture(active.pointerId)) active.handle.releasePointerCapture(active.pointerId);
  };
  const finish = () => { releasePointer(); setResizing(false); };

  useLayoutEffect(() => {
    const element = capture.current;
    if (!element) return;
    const measure = () => setMeasuredHeight(Math.round(parseFloat(getComputedStyle(element).height)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    window.addEventListener('blur', finish);
    return () => { window.removeEventListener('blur', finish); releasePointer(); };
  }, []);
  useEffect(() => { if (disabled) finish(); }, [disabled]);

  const move = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const active = drag.current;
    if (!active || event.pointerId !== active.pointerId) return;
    // Pointer coordinates are screen pixels; the printer can be scaled down.
    setHeight(clampHeight(active.height + (event.clientY - active.y) / active.scale));
  };
  const end = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.pointerId === drag.current?.pointerId) finish();
  };

  return <section ref={capture} id={id} className={styles.capture} style={height === null ? undefined : { height }}
    data-inspiration-capture data-inspiration-resizing={resizing || undefined} aria-label={t('inspiration.capture')}
    onClick={event => {
      if (!(event.target as Element).closest('button, a, input, textarea, video, audio')) capture.current?.querySelector('textarea')?.focus();
    }}>
    {children}
    <button type="button" role="separator" className={styles.captureResize} data-inspiration-resize-handle
      aria-orientation="horizontal" aria-controls={id} aria-label={t('inspiration.machine.resize')}
      aria-valuemin={MIN_HEIGHT} aria-valuemax={MAX_HEIGHT} aria-valuenow={measuredHeight}
      aria-valuetext={t('inspiration.machine.height', { height: measuredHeight })} title={t('inspiration.machine.resize')}
      disabled={disabled} onClick={event => event.stopPropagation()}
      onPointerDown={event => {
        if (disabled || drag.current || !event.isPrimary || event.button !== 0 || !capture.current) return;
        event.preventDefault();
        event.currentTarget.focus({ preventScroll: true });
        const element = capture.current;
        const currentHeight = parseFloat(getComputedStyle(element).height);
        drag.current = { pointerId: event.pointerId, y: event.clientY, height: currentHeight,
          scale: element.getBoundingClientRect().height / currentHeight || 1, handle: event.currentTarget };
        event.currentTarget.setPointerCapture(event.pointerId);
        setResizing(true);
      }} onPointerMove={move} onPointerUp={event => { move(event); end(event); }}
      onPointerCancel={end} onLostPointerCapture={end}
      onKeyDown={event => {
        if (event.key === 'Escape' && drag.current) {
          event.preventDefault(); setHeight(drag.current.height); finish(); return;
        }
        if (disabled || drag.current || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const step = event.shiftKey ? 64 : 16;
        setHeight(clampHeight(event.key === 'Home' ? MIN_HEIGHT : event.key === 'End' ? MAX_HEIGHT
          : (height ?? measuredHeight) + (event.key === 'ArrowDown' ? step : -step)));
      }} />
  </section>;
}
