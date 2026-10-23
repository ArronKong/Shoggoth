import { PAPER_FEED_EASING, PAPER_FEED_MS } from './inspiration-paper-motion';

export type DesktopPrinterFrame = { machine: string; paper: string };
export type DesktopPrinterMotion = { play: () => void; cancel: () => void; finished: Promise<void> };

// A launched spring (ζ .82, ω 18 rad/s, v₀ 8/s) over 420 ms: 95% of the way
// in 165 ms, about 1.3% past the stop, settled before the sheet finishes.
function springProgress(seconds: number): number {
  const damping = .82, frequency = 18, velocity = 8;
  const decay = damping * frequency, oscillation = frequency * Math.sqrt(1 - damping * damping);
  return 1 - Math.exp(-decay * seconds) * (Math.cos(oscillation * seconds) + (decay - velocity) / oscillation * Math.sin(oscillation * seconds));
}
function sampleSpring(steps: number, frame: (progress: number) => Keyframe): Keyframe[] {
  return Array.from({ length: steps + 1 }, (_, index) => ({ offset: index / steps,
    ...frame(index === steps ? 1 : springProgress(index / steps * .42)) }));
}

export function captureDesktopPrinterFrame(workbench: HTMLElement | null, paper: HTMLElement | null): DesktopPrinterFrame | undefined {
  return workbench && paper ? { machine: getComputedStyle(workbench).transform, paper: getComputedStyle(paper).transform } : undefined;
}

// Prepare while the native window is hidden; play only after the host reveals
// it. The paper moves inside the existing clipped outlet, keeping its layout.
export function prepareDesktopPrinterMotion(workbench: HTMLElement | null, paper: HTMLElement | null,
  exiting: boolean, from?: DesktopPrinterFrame): DesktopPrinterMotion | null {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const housing = workbench?.querySelector<HTMLElement>('[data-typewriter-housing]');
  if (!workbench || !paper || !housing || reduced.matches || typeof workbench.animate !== 'function') return null;
  const travel = Math.max(0, housing.getBoundingClientRect().bottom - workbench.getBoundingClientRect().top) + 48;
  const machineAway = `translateY(-${travel}px)`, paperAway = 'translateY(calc(-100% - 40px))';
  // Entering, the machine drops in and settles about 1% past its stop (a few
  // pixels); the sheet then feeds out like a print, which never overshoots.
  // Leaving is one gesture: the sheet is drawn in and comes to rest exactly as
  // it clears the slot, while the machine, already lifting, takes over at the
  // same speed. The lowest visible edge accelerates once, then glides off.
  const start = from ? new DOMMatrixReadOnly(from.machine).m42 : -travel;
  // Dismissal always reports its starting frame; only a moving one was interrupted.
  const resting = !from || [from.machine, from.paper].every(transform => new DOMMatrixReadOnly(transform).isIdentity);
  const machine = workbench.animate(exiting
    ? [{ transform: from?.machine ?? 'translateY(0)' }, { transform: machineAway }]
    : sampleSpring(24, progress => ({ transform: `translateY(${start * (1 - progress)}px)` })),
  { id: exiting ? 'desktop-printer-exit' : 'desktop-printer-enter', delay: exiting ? (resting ? 130 : 40) : 0,
    duration: exiting ? 220 : 420, easing: exiting ? 'cubic-bezier(.4, 0, .6, .4)' : 'linear', fill: 'both' });
  // The last 3% only moves the already hidden sheet (and its shadow) clear.
  const feed = paper.animate(exiting
    ? [{ transform: from?.paper ?? 'translateY(0)', easing: 'cubic-bezier(.4, 0, .5, 1)' },
      { offset: .97, transform: 'translateY(-100%)' }, { transform: paperAway }]
    : [{ transform: from?.paper ?? paperAway }, { transform: 'translateY(0)' }],
  { id: exiting ? 'desktop-printer-retract' : 'desktop-printer-feed', delay: exiting || from ? 0 : 170,
    duration: exiting ? 290 : PAPER_FEED_MS, easing: exiting ? 'linear' : PAPER_FEED_EASING, fill: 'both' });
  const animations = [machine, feed];
  animations.forEach(animation => { animation.pause(); animation.currentTime = 0; });
  let canceled = false, playing = false;
  const cleanup = () => {
    reduced.removeEventListener('change', motionChanged);
    window.removeEventListener('resize', settle);
  };
  const cancel = () => {
    if (canceled) return;
    canceled = true;
    animations.forEach(animation => animation.cancel());
    cleanup();
  };
  const settle = () => {
    if (canceled) return;
    if (exiting) animations.forEach(animation => animation.finish());
    else cancel();
  };
  const motionChanged = () => { if (reduced.matches) settle(); };
  reduced.addEventListener('change', motionChanged);
  window.addEventListener('resize', settle);
  // Attach rejection handlers before a quick dismissal can cancel a paused
  // animation. Hold the exit's final frame until the native window is hidden;
  // cancelling its fill earlier would flash the printer back into view.
  const finished = Promise.all(animations.map(animation => animation.finished)).then(() => {
    if (exiting) cleanup(); else cancel();
  }, () => { cancel(); });
  return { cancel, finished, play() {
    if (canceled || playing) return;
    playing = true;
    animations.forEach(animation => animation.play());
  } };
}
