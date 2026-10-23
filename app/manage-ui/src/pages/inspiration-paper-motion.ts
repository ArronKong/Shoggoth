export type InspirationPaperFlight = {
  play: (destination: HTMLElement | null) => Promise<void>;
  cancel: () => void;
};

const EJECT_MS = 240;
const ROUND_CORNERS_MS = 120;
const TRANSFER_MS = 700;
const PAPER_INSETS = ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'] as const;
const PAPER_CORNERS = ['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomRightRadius', 'borderBottomLeftRadius'] as const;

// Every sheet leaves the slot the same way, on summon and after a print: the
// rollers push at a steady pace and stop it dead. It never passes its resting
// place, which would open a gap under the housing.
export const PAPER_FEED_MS = 440;
export const PAPER_FEED_EASING = 'cubic-bezier(.25, .75, .3, 1)';
const feedFrames: Keyframe[] = [{ transform: 'translateY(-100%)' }, { transform: 'translateY(0)' }];

function sampleMotion(steps: number, frame: (progress: number) => Keyframe): Keyframe[] {
  return Array.from({ length: steps + 1 }, (_, index) => {
    const progress = index / steps;
    return { offset: progress, ...frame(progress) };
  });
}

type Point = { x: number; y: number };
const cubic = (a: number, b: number, c: number, d: number, t: number) =>
  (1 - t) ** 3 * a + 3 * (1 - t) ** 2 * t * b + 3 * (1 - t) * t * t * c + t ** 3 * d;

// Capture only after the save succeeds, before React replaces the draft. The
// travelling sheet stays in page coordinates, so scrolling follows the paper.
export function prepareInspirationPaperFlight(source: HTMLElement | null, page: HTMLElement | null,
  trayTarget?: { x: number; y: number }): InspirationPaperFlight | null {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (!source || !page || document.hidden || reduced.matches || typeof source.animate !== 'function') return null;
  const from = source.getBoundingClientRect();
  if (!from.width || !from.height) return null;
  const sourceStyle = getComputedStyle(source);
  const sourceScale = from.width / (parseFloat(sourceStyle.width) || from.width);
  const sourceRadii = PAPER_CORNERS.map(property => (parseFloat(sourceStyle[property]) || 0) * sourceScale);
  const origin = page.getBoundingClientRect();
  const carrier = document.createElement('div');
  carrier.setAttribute('aria-hidden', 'true');
  carrier.setAttribute('data-paper-flight', 'ejecting');
  carrier.inert = true;
  // Cross above the sticky toolbar (10), while the page title stays above (12).
  Object.assign(carrier.style, {
    position: 'absolute', left: `${from.left - origin.left}px`, top: `${from.top - origin.top}px`,
    width: `${from.width}px`, height: `${from.height}px`, margin: '0', zIndex: '11',
    ...Object.fromEntries(PAPER_CORNERS.map((property, index) => [property, `${sourceRadii[index]}px`])),
    pointerEvents: 'none', willChange: 'transform', contain: 'layout style',
  });
  // A separate shadow plane lets the sheet lift without repainting box-shadow
  // on every frame. Its extra depth disappears as the paper meets the wall.
  const shadow = document.createElement('div');
  Object.assign(shadow.style, {
    position: 'absolute', inset: '5px 6px', opacity: '0', pointerEvents: 'none',
    background: 'light-dark(#30382b40, #0204028c)', filter: 'blur(14px)',
    willChange: 'transform, opacity',
  });
  const sheet = source.cloneNode(true) as HTMLElement;
  sheet.removeAttribute('id');
  sheet.querySelectorAll('[id]').forEach(node => node.removeAttribute('id'));
  Object.assign(sheet.style, {
    width: '100%', height: '100%', margin: '0', pointerEvents: 'none',
    borderRadius: 'inherit',
    boxShadow: sourceStyle.boxShadow.replace(/(-?[\d.]+)px/g, (_, pixels) => `${Number(pixels) * sourceScale}px`),
  });
  const originalInput = source.querySelector('textarea');
  const copiedInput = sheet.querySelector('textarea');
  const originalInputs = [...source.querySelectorAll('textarea')];
  const copiedInputs = [...sheet.querySelectorAll('textarea')];
  originalInputs.forEach((input, index) => {
    const copy = copiedInputs[index];
    if (!copy) return;
    const style = getComputedStyle(input);
    copy.value = input.value;
    copy.disabled = false;
    copy.readOnly = true;
    Object.assign(copy.style, {
      resize: 'none', caretColor: 'transparent', height: `${input.getBoundingClientRect().height}px`,
      minHeight: '0', maxHeight: 'none', overflow: 'hidden',
      fontSize: `${parseFloat(style.fontSize) * sourceScale}px`, lineHeight: `${parseFloat(style.lineHeight) * sourceScale}px`,
    });
  });
  const originalTextBox = originalInput?.closest<HTMLElement>('[data-inspiration-capture]') ?? originalInput?.parentElement;
  const textBox = copiedInput?.closest<HTMLElement>('[data-inspiration-capture]') ?? copiedInput?.parentElement;
  const inputHeight = originalInput?.getBoundingClientRect().height ?? 0;
  const inputStyle = originalInput ? getComputedStyle(originalInput) : null;
  const inputFontSize = inputStyle ? parseFloat(inputStyle.fontSize) * sourceScale : 0;
  const inputLineHeight = inputStyle ? parseFloat(inputStyle.lineHeight) * sourceScale : 0;
  if (originalInput && copiedInput) {
    copiedInput.value = originalInput.value;
    copiedInput.disabled = false;
    copiedInput.readOnly = true;
    Object.assign(copiedInput.style, {
      resize: 'none', caretColor: 'transparent', height: `${inputHeight}px`,
      minHeight: '0', maxHeight: 'none', overflow: 'hidden',
      fontSize: `${inputFontSize}px`, lineHeight: `${inputLineHeight}px`,
    });
    if (textBox && originalTextBox) {
      // The clone leaves the zoomed printer. Freeze its visible font metrics
      // and insets so ejection starts with exactly the paper the user saw.
      const captureStyle = getComputedStyle(originalTextBox);
      Object.assign(textBox.style, { height: '100%', ...Object.fromEntries(PAPER_INSETS.map(property => [property,
        `${(parseFloat(captureStyle[property]) || 0) * sourceScale}px`])) });
    }
  }
  carrier.append(shadow, sheet);
  page.append(carrier);
  if (originalInput && copiedInput) copiedInput.scrollTop = originalInput.scrollTop * sourceScale;
  const originalContent = source.querySelector('[data-inspiration-media-content]');
  const copiedContent = sheet.querySelector('[data-inspiration-media-content]');
  if (originalContent && copiedContent) copiedContent.scrollTop = originalContent.scrollTop * sourceScale;

  const sourceVisibility = source.style.visibility;
  source.style.visibility = 'hidden';
  let destination: HTMLElement | null = null;
  let destinationVisibility = '';
  let destinationDisplay = '';
  let stopped = false;
  const animations: Animation[] = [];
  const cancel = () => {
    if (stopped) return;
    stopped = true;
    animations.forEach(animation => animation.cancel());
    source.style.visibility = sourceVisibility;
    if (destination) {
      destination.style.visibility = destinationVisibility;
      destination.style.display = destinationDisplay;
      destination.removeAttribute('data-paper-landing');
    }
    carrier.remove();
    window.removeEventListener('resize', cancel);
    document.removeEventListener('visibilitychange', onVisibility);
    reduced.removeEventListener('change', onMotion);
  };
  const onVisibility = () => { if (document.hidden) cancel(); };
  const onMotion = () => { if (reduced.matches) cancel(); };
  window.addEventListener('resize', cancel);
  document.addEventListener('visibilitychange', onVisibility);
  reduced.addEventListener('change', onMotion);
  const animate = (element: HTMLElement, keyframes: Keyframe[], options: KeyframeAnimationOptions, id: string) => {
    const animation = element.animate(keyframes, options);
    animation.id = id;
    animations.push(animation);
    // Cancellation is expected on navigation, resize or reduced-motion changes.
    void animation.finished.catch(() => {});
    return animation;
  };

  return { cancel, async play(target) {
    if (trayTarget) {
      if (stopped || !source.isConnected) { cancel(); return; }
      try {
        const ejectDistance = Math.min(88, Math.max(52, from.height * .32));
        // One continuous throw. The push out of the slot drifts sideways and is
        // still moving when the flight takes over, so the sheet never hangs
        // under an empty slot; the flight starts with the same velocity.
        const drift = Math.min(24, from.width * .05);
        const exit = { x: 3 * drift / EJECT_MS, y: .5 * ejectDistance / EJECT_MS };
        const eject = animate(carrier, sampleMotion(16, progress => {
          const rounded = 1 - (1 - Math.min(1, progress * EJECT_MS / ROUND_CORNERS_MS)) ** 3;
          return { transform: `translate3d(${drift * progress ** 3}px, ${ejectDistance * (1.5 * progress - .5 * progress * progress)}px, 0)`,
            borderTopLeftRadius: `${24 * rounded}px`, borderTopRightRadius: `${24 * rounded}px` };
        }), { duration: EJECT_MS, easing: 'linear', fill: 'both' }, 'inspiration-paper-eject');
        // The lifted sheet casts onto the next one, which feeds out behind it.
        animate(shadow, [
          { opacity: 0, transform: 'translate3d(0, 0, 0)', offset: 0 },
          { opacity: .7, transform: 'translate3d(0, 10px, 0)', offset: .26 },
          { opacity: 0, transform: 'translate3d(0, 4px, 0)', offset: .7 },
          { opacity: 0, transform: 'translate3d(0, 4px, 0)', offset: 1 },
        ], { duration: EJECT_MS + TRANSFER_MS, fill: 'both' }, 'inspiration-paper-shadow');
        const feed = animate(source, feedFrames, { delay: EJECT_MS + 40, duration: PAPER_FEED_MS,
          easing: PAPER_FEED_EASING, fill: 'both' }, 'inspiration-paper-feed');
        source.style.visibility = sourceVisibility;
        await eject.finished;
        if (stopped || !source.isConnected) return;
        carrier.setAttribute('data-paper-flight', 'to-tray');
        carrier.style.transformOrigin = 'center center';
        // Swing out beside the machine and rise straight into the status item,
        // instead of cutting across the machine's screen.
        const start: Point = { x: drift, y: ejectDistance };
        const end: Point = { x: trayTarget.x - from.left - from.width / 2, y: trayTarget.y - from.top - from.height / 2 };
        const lead: Point = { x: start.x + exit.x * TRANSFER_MS / 3, y: start.y + exit.y * TRANSFER_MS / 3 };
        // Bulge a little past the tray, but keep the swing on screen.
        const screenRight = window.innerWidth - from.left - from.width / 2 - 40;
        const swing: Point = { x: Math.max(end.x, Math.min(end.x + Math.abs(end.x - start.x) * .12, screenRight)), y: start.y };
        const flight = animate(carrier, sampleMotion(44, progress => {
          const x = cubic(start.x, lead.x, swing.x, end.x, progress);
          const y = cubic(start.y, lead.y, swing.y, end.y, progress);
          return { transform: `translate3d(${x}px, ${y}px, 0) rotate(${+(-5 * Math.sin(Math.PI * progress)).toFixed(2)}deg) scale(${1 - .97 * progress ** 1.25})`,
            opacity: progress < .84 ? 1 : (1 - progress) / .16 };
        }), { duration: TRANSFER_MS, easing: 'linear', fill: 'both' }, 'inspiration-paper-to-tray');
        await Promise.all([flight.finished, feed.finished]);
      } catch { /* A canceled flight still represents a successfully saved note. */ }
      finally { cancel(); }
      return;
    }
    if (stopped || !target?.isConnected || !source.isConnected) { cancel(); return; }
    destination = target;
    destinationVisibility = target.style.visibility;
    destinationDisplay = target.style.display;
    target.style.visibility = 'hidden';
    // This runs in the save layout effect, before paint. The confirmed card is
    // cached, but occupies no grid slot until the paper has cleared the printer.
    target.style.display = 'none';
    target.setAttribute('data-paper-landing', '');
    try {
      const cornerStyle = getComputedStyle(target);
      const ejectedRadii = PAPER_CORNERS.map((property, index) => index < 2
        ? (parseFloat(cornerStyle[property]) || 0) * sourceScale : sourceRadii[index]);
      const ejectDistance = Math.min(88, Math.max(52, from.height * .32));
      const eject = animate(carrier, sampleMotion(16, progress => {
        // Round the newly exposed top corners quickly, in the printer's scale.
        const rounded = 1 - (1 - Math.min(1, progress * EJECT_MS / ROUND_CORNERS_MS)) ** 3;
        // A strong initial impulse slows as the sheet clears the rollers. Keep
        // horizontal movement and resizing for the following flight phase.
        return { transform: `translate3d(0, ${ejectDistance * (1.7 * progress - .7 * progress * progress)}px, 0)`,
          ...Object.fromEntries(PAPER_CORNERS.slice(0, 2).map((property, index) => [property,
            `${sourceRadii[index] + (ejectedRadii[index] - sourceRadii[index]) * rounded}px`])) };
      }), { duration: EJECT_MS, easing: 'linear', fill: 'both' }, 'inspiration-paper-eject');
      animate(shadow, [
        { opacity: 0, transform: 'translate3d(0, 0, 0) scale(1)', offset: 0 },
        { opacity: .85, transform: 'translate3d(0, 12px, 0) scale(.98)', offset: .2 },
        { opacity: .5, transform: 'translate3d(0, 6px, 0) scale(.99)', offset: .66 },
        { opacity: 0, transform: 'translate3d(0, 0, 0) scale(1)', offset: 1 },
      ], { duration: EJECT_MS + TRANSFER_MS, fill: 'both' }, 'inspiration-paper-shadow');
      const feed = animate(source, feedFrames, { delay: EJECT_MS, duration: PAPER_FEED_MS,
        easing: PAPER_FEED_EASING, fill: 'both' }, 'inspiration-paper-feed');
      source.style.visibility = sourceVisibility;

      // Let the ejection be seen at the printer before the page follows the
      // departing sheet. The next paper starts feeding at this same handoff.
      await eject.finished;
      if (stopped || !target.isConnected || !source.isConnected) return;
      carrier.setAttribute('data-paper-flight', 'travelling');
      target.style.display = destinationDisplay;
      const to = target.getBoundingClientRect();
      const targetStyle = getComputedStyle(target);
      const targetRadii = PAPER_CORNERS.map(property => parseFloat(targetStyle[property]) || 0);
      const currentOrigin = page.getBoundingClientRect();
      const dx = to.left - currentOrigin.left - (from.left - origin.left);
      const dy = to.top - currentOrigin.top - (from.top - origin.top);
      const launchVelocity = .3 * ejectDistance / EJECT_MS;
      const travel = animate(carrier, sampleMotion(44, progress => {
        const settle = progress * progress * (3 - 2 * progress);
        // Hermite motion carries the ejection velocity into the flight and
        // decelerates to zero at the real card position, without a midair stop.
        const momentum = progress * (1 - progress) ** 2 * launchVelocity * TRANSFER_MS;
        const x = dx * settle;
        const y = ejectDistance + (dy - ejectDistance) * settle + momentum;
        // Resize this isolated overlay instead of scaling the paper and its
        // glyphs. Text keeps its proportions and reflows at the current width.
        return { transform: `translate3d(${x}px, ${y}px, 0)`,
          ...Object.fromEntries(PAPER_CORNERS.map((property, index) => [property,
            `${ejectedRadii[index] + (targetRadii[index] - ejectedRadii[index]) * settle}px`])),
          width: `${from.width + (to.width - from.width) * settle}px`,
          height: `${from.height + (to.height - from.height) * settle}px` };
      }), { duration: TRANSFER_MS, easing: 'linear', fill: 'both' }, 'inspiration-paper-transfer');
      const contentAnimations: Animation[] = [];
      if (textBox && copiedInput) {
        const start = getComputedStyle(textBox);
        const end = getComputedStyle(target);
        const startInsets = Object.fromEntries(PAPER_INSETS.map(property => [property, parseFloat(start[property]) || 0]));
        const endInsets = Object.fromEntries(PAPER_INSETS.map(property => [property, parseFloat(end[property]) || 0]));
        const bodyText = target.querySelector('[data-inspiration-body] p');
        const endTextStyle = bodyText ? getComputedStyle(bodyText) : inputStyle;
        const bodyHeight = target.querySelector('[data-inspiration-body]')?.getBoundingClientRect().height
          ?? Math.max(0, to.height - endInsets.paddingTop - endInsets.paddingBottom);
        contentAnimations.push(animate(textBox, sampleMotion(44, progress => {
          const settle = progress * progress * (3 - 2 * progress);
          return Object.fromEntries(PAPER_INSETS.map(property => [property,
            `${startInsets[property] + (endInsets[property] - startInsets[property]) * settle}px`]));
        }), { duration: TRANSFER_MS, easing: 'linear', fill: 'both' }, 'inspiration-paper-insets'));
        if (copiedInputs.length <= 1) contentAnimations.push(animate(copiedInput, [
          { height: `${inputHeight}px`, fontSize: `${inputFontSize}px`, lineHeight: `${inputLineHeight}px` },
          { height: `${bodyHeight}px`, fontSize: endTextStyle?.fontSize, lineHeight: endTextStyle?.lineHeight },
        ], { duration: TRANSFER_MS, easing: 'cubic-bezier(.333333, 0, .666667, 1)', fill: 'both' }, 'inspiration-paper-text-reflow'));
      }
      const viewport = page.closest('main')?.getBoundingClientRect();
      if (viewport && (to.bottom > viewport.bottom - 24 || to.top < viewport.top + 24)) {
        target.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
      }
      await Promise.all([travel.finished, feed.finished, ...contentAnimations.map(animation => animation.finished)]);
      if (stopped) return;
      // The paper has reached its actual grid slot. Only its card controls and
      // text layout crossfade here; the sheet never vanishes while travelling.
      carrier.setAttribute('data-paper-flight', 'landed');
      target.style.visibility = destinationVisibility;
      await Promise.all([
        animate(target, [{ opacity: 0 }, { opacity: 1 }], { duration: 120, fill: 'both' }, 'inspiration-paper-arrival').finished,
        animate(carrier, [{ opacity: 1 }, { opacity: 0 }], { duration: 120, fill: 'both' }, 'inspiration-paper-handoff').finished,
      ]);
    } catch { /* Interrupted motion settles into the saved card and fresh sheet. */ }
    finally { cancel(); }
  } };
}
