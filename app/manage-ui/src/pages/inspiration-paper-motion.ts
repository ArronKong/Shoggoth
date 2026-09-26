export type InspirationPaperFlight = {
  play: (destination: HTMLElement | null) => Promise<void>;
  cancel: () => void;
};

const EJECT_MS = 240;
const ROUND_CORNERS_MS = 120;
const TRANSFER_MS = 700;
const FEED_MS = 540;
const PAPER_INSETS = ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'] as const;
const PAPER_CORNERS = ['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomRightRadius', 'borderBottomLeftRadius'] as const;

function sampleMotion(steps: number, frame: (progress: number) => Keyframe): Keyframe[] {
  return Array.from({ length: steps + 1 }, (_, index) => {
    const progress = index / steps;
    return { offset: progress, ...frame(progress) };
  });
}

// An underdamped sheet feed: the rollers impart an initial velocity, then the
// paper passes its resting position once and settles with diminishing recoil.
function feedPosition(progress: number): number {
  if (progress === 0) return -100;
  if (progress === 1) return 0;
  const time = progress * FEED_MS / 1000;
  const frequency = 23;
  const damping = .72;
  const velocity = 3;
  const decay = damping * frequency;
  const oscillation = frequency * Math.sqrt(1 - damping * damping);
  return -100 * Math.exp(-decay * time) * (Math.cos(oscillation * time)
    + (decay - velocity) / oscillation * Math.sin(oscillation * time));
}

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
        const eject = animate(carrier, [
          { transform: 'translate3d(0, 0, 0)', borderTopLeftRadius: '0px', borderTopRightRadius: '0px' },
          { transform: `translate3d(0, ${ejectDistance}px, 0)`, borderTopLeftRadius: '24px', borderTopRightRadius: '24px' },
        ], { duration: EJECT_MS, easing: 'cubic-bezier(.22, 1, .36, 1)', fill: 'both' }, 'inspiration-paper-eject');
        const feed = animate(source, sampleMotion(36, progress => ({ transform: `translateY(${feedPosition(progress)}%)` })),
          { delay: EJECT_MS, duration: FEED_MS, easing: 'linear', fill: 'both' }, 'inspiration-paper-feed');
        source.style.visibility = sourceVisibility;
        await eject.finished;
        if (stopped || !source.isConnected) return;
        carrier.setAttribute('data-paper-flight', 'to-tray');
        carrier.style.transformOrigin = 'center center';
        const dx = trayTarget.x - from.left - from.width / 2;
        const dy = trayTarget.y - from.top - from.height / 2;
        const flight = animate(carrier, sampleMotion(44, progress => {
          const settle = progress * progress * (3 - 2 * progress);
          // Preserve a little downward momentum before the sheet turns toward
          // the real native status item. Scale the entire printed sheet.
          const y = ejectDistance + (dy - ejectDistance) * settle + 48 * progress * (1 - progress) ** 2;
          return { transform: `translate3d(${dx * settle}px, ${y}px, 0) scale(${1 - .98 * settle})`,
            opacity: progress < .82 ? 1 : (1 - progress) / .18 };
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
      const feed = animate(source, sampleMotion(36, progress => ({
        transform: `translateY(${feedPosition(progress)}%)`,
      })), { delay: EJECT_MS, duration: FEED_MS, easing: 'linear', fill: 'both' }, 'inspiration-paper-feed');
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
