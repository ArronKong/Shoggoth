export type DesktopPrinterFrame = { machine: string; paper: string };
export type DesktopPrinterMotion = { play: () => void; cancel: () => void; finished: Promise<void> };

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
  const easing = exiting ? 'cubic-bezier(.4, 0, .2, 1)' : 'cubic-bezier(.22, 1, .36, 1)';
  const machine = workbench.animate([
    { transform: from?.machine ?? (exiting ? 'translateY(0)' : machineAway) },
    { transform: exiting ? machineAway : 'translateY(0)' },
  ], { id: exiting ? 'desktop-printer-exit' : 'desktop-printer-enter', delay: exiting ? 120 : 0,
    duration: exiting ? 180 : 280, easing, fill: 'both' });
  const feed = paper.animate([
    { transform: from?.paper ?? (exiting ? 'translateY(0)' : paperAway) },
    { transform: exiting ? paperAway : 'translateY(0)' },
  ], { id: exiting ? 'desktop-printer-retract' : 'desktop-printer-feed', delay: exiting || from ? 0 : 180,
    duration: exiting ? 140 : 360, easing, fill: 'both' });
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
