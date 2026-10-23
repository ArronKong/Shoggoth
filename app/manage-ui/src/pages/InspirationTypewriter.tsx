import { useEffect, useLayoutEffect, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import styles from './InspirationTypewriter.module.css';
import paperStyles from './InspirationPaper.module.css';
import wordmark from '../assets/inspiration-wordmark.svg';
import screenDot from '../assets/inspiration-screen-dot.svg';
import { inspirationSlogans, type InspirationSlogan, type InspirationSloganLocale } from './inspiration-slogans';
import { createTypewriterSound } from './inspiration-typewriter-sound';

// Keys land 70–130 ms apart, 100 ms on average, never metronomic; a slogan
// keeps the same rhythm each time. After a stop or comma the hand rests.
const PAUSE_AFTER = /[，。、！？；：,.!?;:]/;
const keyDelay = (character: string, index: number) =>
  70 + (character.codePointAt(0)! * 7 + index * 13) % 61 + (PAUSE_AFTER.test(character) ? 160 : 0);

function IdlePrompt({ locale, active }: { locale: InspirationSloganLocale; active: boolean }) {
  const [visibleText, setVisibleText] = useState('');
  const [phase, setPhase] = useState<'typing' | 'shown' | 'leaving'>('shown');
  const currentSlogan = useRef<InspirationSlogan | null>(null);
  const sound = useRef<ReturnType<typeof createTypewriterSound> | null>(null);

  useEffect(() => {
    const player = createTypewriterSound();
    sound.current = player;
    return () => { player.dispose(); sound.current = null; };
  }, []);

  useEffect(() => {
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let timer: number | undefined;
    let position = 0;
    let characters: string[] = [];
    const typeNext = () => {
      sound.current?.setTyping(true);
      setPhase('typing');
      position++;
      setVisibleText(characters.slice(0, position).join(''));
      timer = window.setTimeout(position < characters.length ? typeNext : () => {
        sound.current?.setTyping(false);
        setPhase('shown');
        timer = window.setTimeout(leave, 1900);
      }, keyDelay(characters[position - 1], position - 1));
    };
    // Fade the finished line out before the next one starts typing.
    const leave = () => { setPhase('leaving'); timer = window.setTimeout(nextSlogan, 200); };
    const restart = () => {
      window.clearTimeout(timer);
      sound.current?.setTyping(false);
      setPhase('shown');
      position = 0;
      const text = currentSlogan.current?.[locale] ?? '';
      characters = Array.from(text);
      setVisibleText(reducedMotion.matches ? text : '');
      if (active && !reducedMotion.matches && !document.hidden && characters.length) timer = window.setTimeout(typeNext, 300);
    };
    const nextSlogan = () => {
      // Some pairs share an English translation; avoid repeating visible copy too.
      const candidates = inspirationSlogans.filter(slogan => slogan[locale] !== currentSlogan.current?.[locale]);
      currentSlogan.current = candidates[Math.floor(Math.random() * candidates.length)];
      restart();
    };
    if (currentSlogan.current) restart();
    else nextSlogan();
    document.addEventListener('visibilitychange', restart);
    reducedMotion.addEventListener('change', restart);
    return () => {
      window.clearTimeout(timer);
      sound.current?.setTyping(false);
      document.removeEventListener('visibilitychange', restart);
      reducedMotion.removeEventListener('change', restart);
    };
  }, [locale, active]);

  return <span data-typewriter-prompt="" data-phase={phase}>{visibleText}</span>;
}

export default function InspirationTypewriter({ children, accessory, saving, paperTone, ideaCount, paperRef, active = true }: {
  children: ReactNode; saving: boolean; paperTone: number;
  accessory?: ReactNode;
  ideaCount: number | null; paperRef?: MutableRefObject<HTMLDivElement | null>; active?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const locale = (i18n.resolvedLanguage || i18n.language).startsWith('en') ? 'en' : 'zh-CN';
  const localPaper = useRef<HTMLDivElement>(null);
  const paper = paperRef ?? localPaper;
  const viewportRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const focusPaper = () => paper.current?.querySelector('textarea')?.focus();
  // A saved note rolls the counter up instead of swapping the digits in place.
  const shownCount = useRef(ideaCount);
  const [countTick, setCountTick] = useState(0);
  useEffect(() => {
    if (ideaCount !== null && shownCount.current !== null && ideaCount > shownCount.current) setCountTick(value => value + 1);
    shownCount.current = ideaCount;
  }, [ideaCount]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const printer = viewport?.firstElementChild;
    const measure = measureRef.current;
    if (!viewport || !printer || !measure) return;
    // Keep the 680px design intact. Zoom also sizes its layout box, including
    // a manually resized textarea, so the wall follows the visible paper.
    const fit = () => {
      const available = measure.getBoundingClientRect().width;
      const designWidth = parseFloat(getComputedStyle(printer).width);
      if (available <= 0 || !designWidth) return;
      const scale = String(Math.min(1, available / designWidth));
      if (viewport.style.getPropertyValue('--printer-scale') !== scale) viewport.style.setProperty('--printer-scale', scale);
    };
    fit();
    let frame = 0;
    const observer = new ResizeObserver(() => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(fit);
    });
    // Observe width only: zoom changes the paper height, which must not feed
    // back into this observer and produce ResizeObserver loop warnings.
    observer.observe(measure);
    return () => { observer.disconnect(); window.cancelAnimationFrame(frame); };
  }, []);

  return <div className={styles.printerViewport} data-printer-viewport ref={viewportRef}>
    <div className={`${paperStyles.typeface} ${styles.typewriter}`} lang={locale} data-typewriter="paper" data-saving={saving || undefined}>
    <div className={styles.machine}>
      <div className={styles.chassis} aria-hidden="true" />
      <div className={styles.housing} data-typewriter-housing aria-hidden="true" />
      <img className={styles.branding} src={wordmark} alt="" width="68" height="9.645" />
      <button type="button" className={styles.displayFrame} onClick={focusPaper} disabled={saving} aria-label={t('inspiration.machine.focus')}>
        <span className={styles.display} aria-hidden="true"><span className={styles.screenPrompt}>
          <span className={styles.indicator}><img src={screenDot} alt="" width="10" height="10" /></span>
          <span className={styles.displayText}><span className={styles.displayValue}>
          <span className={styles.displayGlyphs}>{saving ? t('inspiration.saving') : <IdlePrompt locale={locale} active={active} />}</span><i className={styles.cursor} />
        </span></span></span><span className={styles.ideaCount} data-inspiration-count={ideaCount ?? undefined}
          lang={locale} title={ideaCount === null ? undefined : t('inspiration.count', { count: ideaCount })}>
          <span key={countTick} className={styles.countValue} data-tick={countTick ? '' : undefined}>{ideaCount ?? '—'}</span></span></span>
      </button>
      {accessory}
    </div>
    <div className={styles.paperWindow} data-paper-window>
      <div className={paperStyles.surface} data-paper={paperTone} ref={paper}>{children}</div>
    </div>
    </div>
    <span className={styles.widthMeasure} ref={measureRef} aria-hidden="true" />
  </div>;
}
