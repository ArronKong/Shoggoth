// A lightly underdamped spring: one small rebound (about 2.5% of the travel),
// then a quick settle. Position and velocity survive a change of destination.
const SPRING_FREQUENCY = 24;
const SPRING_DAMPING_RATIO = .76;
const SPRING_DECAY = SPRING_FREQUENCY * SPRING_DAMPING_RATIO;
const SPRING_OSCILLATION = SPRING_FREQUENCY * Math.sqrt(1 - SPRING_DAMPING_RATIO ** 2);
const COLLAPSE_TRAVEL_SECONDS = .32;
const REST_DISTANCE = .4;
const REST_SPEED = 8;
const GESTURE_IDLE_MS = 180;
const GESTURE_THRESHOLD = 12;
const EDGE = 1;

// Keep the two stops in the existing scroll container, so the wall, paper
// flights and sticky heading all continue to use the same page coordinates.
export function attachInspirationScrollStages(page: HTMLElement, toolbar: HTMLElement, anchor: HTMLElement, onExpandedChange?: (expanded: boolean) => void) {
  const root = page.closest('main');
  if (!root) return;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  let wallTop = 0;
  let frame = 0;
  let settleTimer = 0;
  let destination: number | null = null;
  let spring: { position: number; velocity: number } | null = null;
  let visualOffset = 0;
  let paperOffset = 0;
  let paperTravel = 0;
  let lastTop = root.scrollTop;
  let viewportHeight = root.clientHeight;
  let viewportWidth = root.clientWidth;
  let scrollDirection = 1;
  let lastWheel = -Infinity;
  let gestureDirection = 0;
  let gestureDistance = 0;
  let consumedDirection = 0;
  let touch: { x: number; y: number } | null = null;
  let pointerDown = false;
  let expanded = true;
  const workbench = page.querySelector<HTMLElement>('[data-inspiration-workbench]');
  const paper = page.querySelector<HTMLElement>('[data-paper-window]');
  const paperTransform = paper?.style.getPropertyValue('transform') || '';
  const surfaces = [workbench, anchor.parentElement].filter((element): element is HTMLElement => element !== null)
    .map(element => ({ element, transform: element.style.getPropertyValue('transform') }));

  const offsetSurfaces = (offset: number) => {
    if (offset === visualOffset) return;
    visualOffset = offset;
    for (const { element, transform } of surfaces) {
      if (offset) element.style.setProperty('transform', `translate3d(0, ${offset}px, 0) ${transform}`.trim());
      else if (transform) element.style.setProperty('transform', transform);
      else element.style.removeProperty('transform');
    }
  };
  const movePaper = () => {
    if (!paper) return;
    const progress = wallTop > 0 ? Math.max(0, Math.min(1, (spring?.position ?? root.scrollTop) / wallTop)) : 0;
    const offset = -paperTravel * progress;
    if (offset === paperOffset) return;
    paperOffset = offset;
    // Move the window around the sheet, independently of the sheet's existing
    // printing animation. Its lower edge and shadow leave before the backdrop
    // switches on; reversing the scroll retraces the same continuous motion.
    if (offset) paper.style.setProperty('transform', `translate3d(0, ${offset}px, 0) ${paperTransform}`.trim());
    else if (paperTransform) paper.style.setProperty('transform', paperTransform);
    else paper.style.removeProperty('transform');
  };

  const markPosition = () => {
    movePaper();
    const stuck = wallTop > 0 && root.scrollTop >= wallTop - EDGE;
    toolbar.toggleAttribute('data-stuck', stuck);
    page.setAttribute('data-inspiration-stage', stuck ? 'wall' : root.scrollTop <= EDGE ? 'expanded' : 'transition');
    const nextExpanded = root.scrollTop <= EDGE;
    if (expanded !== nextExpanded) { expanded = nextExpanded; onExpandedChange?.(expanded); }
  };
  const cancel = () => {
    window.cancelAnimationFrame(frame);
    window.clearTimeout(settleTimer);
    frame = 0;
    destination = null;
    spring = null;
    offsetSurfaces(0);
    page.removeAttribute('data-inspiration-scrolling');
  };
  const snap = (top: number, animate = true) => {
    const from = spring?.position ?? root.scrollTop;
    const velocity = spring?.velocity ?? 0;
    cancel();
    if (!animate || reduced.matches || Math.abs(from - top) <= REST_DISTANCE && Math.abs(velocity) <= REST_SPEED) {
      root.scrollTop = top;
      markPosition();
      return;
    }
    destination = top;
    spring = { position: from, velocity };
    // The machine is already partly above the viewport. Launching a spring
    // straight at the wall removes its visible body during peak acceleration.
    // Spread a collapse from rest over a balanced travel phase, then let the
    // same spring absorb its arrival. Live reversals retain their momentum.
    const travel = top > from && Math.abs(velocity) <= REST_SPEED
      ? COLLAPSE_TRAVEL_SECONDS * Math.min(1, Math.sqrt((top - from) / Math.max(1, wallTop))) : 0;
    const arrivalVelocity = travel ? (6 * (top - from) - 2 * velocity * travel)
      / (4 * travel + 2 * SPRING_DECAY * travel ** 2) : 0;
    // Match position, velocity and acceleration at the spring handoff.
    const quadratic = travel ? (3 * (top - from) - (2 * velocity + arrivalVelocity) * travel) / travel ** 2 : 0;
    const cubic = travel ? (-2 * (top - from) + (velocity + arrivalVelocity) * travel) / travel ** 3 : 0;
    let travelElapsed = 0;
    page.setAttribute('data-inspiration-scrolling', '');
    const upperBound = Math.max(wallTop, root.scrollTop);
    const paint = (position: number) => {
      const bounded = Math.max(0, Math.min(position, upperBound));
      root.scrollTop = bounded;
      // Native scrolling clamps at the top and at the end of an empty wall.
      // Render only the spring's overshoot with transforms, keeping the title
      // steady and leaving the resting layout and scroll range unchanged.
      offsetSurfaces(bounded - position);
      markPosition();
    };
    paint(from);
    let previousTime = performance.now();
    const tick = (now: number) => {
      if (!spring) return;
      // Exact damped-spring integration stays consistent across frame rates
      // and long frames, without a fixed animation duration or Euler steps.
      let elapsed = Math.max(0, (now - previousTime) / 1000);
      previousTime = now;
      if (travelElapsed < travel) {
        const remainingTravel = travel - travelElapsed;
        travelElapsed = Math.min(travel, travelElapsed + elapsed);
        const t = travelElapsed;
        spring = { position: from + velocity * t + quadratic * t ** 2 + cubic * t ** 3,
          velocity: velocity + 2 * quadratic * t + 3 * cubic * t ** 2 };
        elapsed = Math.max(0, elapsed - remainingTravel);
      }
      const displacement = spring.position - top;
      const sineWeight = (spring.velocity + SPRING_DECAY * displacement) / SPRING_OSCILLATION;
      const envelope = Math.exp(-SPRING_DECAY * elapsed);
      const cosine = Math.cos(SPRING_OSCILLATION * elapsed), sine = Math.sin(SPRING_OSCILLATION * elapsed);
      const remaining = envelope * (displacement * cosine + sineWeight * sine);
      spring = { position: top + remaining,
        velocity: envelope * SPRING_OSCILLATION * (sineWeight * cosine - displacement * sine) - SPRING_DECAY * remaining };
      if (Math.abs(remaining) <= REST_DISTANCE && Math.abs(spring.velocity) <= REST_SPEED) {
        root.scrollTop = top;
        cancel();
        markPosition();
      } else {
        paint(spring.position);
        frame = window.requestAnimationFrame(tick);
      }
    };
    frame = window.requestAnimationFrame(tick);
  };
  const measure = () => {
    const resized = root.clientHeight !== viewportHeight || root.clientWidth !== viewportWidth;
    const wasAtWall = wallTop > 0 && Math.abs((resized ? lastTop : root.scrollTop) - wallTop) <= EDGE;
    viewportHeight = root.clientHeight;
    viewportWidth = root.clientWidth;
    const stickyTop = parseFloat(getComputedStyle(toolbar).top) || 0;
    const next = Math.max(0, root.scrollTop + anchor.getBoundingClientRect().top - visualOffset - root.getBoundingClientRect().top - stickyTop);
    if (paper) {
      const rect = paper.getBoundingClientRect();
      const style = getComputedStyle(paper);
      const scale = rect.width / (parseFloat(style.width) || rect.width || 1) || 1;
      const bottom = root.scrollTop + rect.bottom - root.getBoundingClientRect().top - visualOffset - paperOffset * scale;
      const shadow = parseFloat(style.overflowClipMargin) || 40;
      paperTravel = Math.max(0, (bottom - next + 8) / scale + shadow);
    }
    // Even an empty filter must have enough scroll range to hide the machine.
    const height = `${Math.ceil(root.clientHeight + next)}px`;
    if (page.style.getPropertyValue('--inspiration-scroll-height') !== height) page.style.setProperty('--inspiration-scroll-height', height);
    if (Math.abs(next - wallTop) > EDGE || wasAtWall && Math.abs(root.scrollTop - next) > EDGE) {
      const wasMoving = destination;
      wallTop = next;
      if (wasMoving !== null) snap(wasMoving === 0 ? 0 : wallTop);
      else if (wasAtWall) snap(wallTop, false);
    }
    markPosition();
  };
  const ownsScroll = (target: EventTarget | null, delta: number) => {
    if (!(target instanceof Element) || !page.contains(target)
      || page.querySelector('[data-inspiration-dragging], [data-inspiration-resizing]')) return false;
    // Textarea, command output and menus keep their own native scrolling.
    for (let node = target; node !== root; node = node.parentElement!) {
      if (node.scrollHeight <= node.clientHeight + EDGE) continue;
      if (!/(auto|scroll)/.test(getComputedStyle(node).overflowY)) continue;
      if (delta > 0 ? node.scrollTop + node.clientHeight < node.scrollHeight - EDGE : node.scrollTop > EDGE) return false;
    }
    return true;
  };
  const resetGesture = () => { gestureDirection = 0; gestureDistance = 0; consumedDirection = 0; };
  const move = (delta: number) => {
    const direction = Math.sign(delta);
    if (direction !== gestureDirection) { gestureDirection = direction; gestureDistance = 0; }
    gestureDistance += Math.abs(delta);
    // Swallow the rest of the same trackpad/touch gesture after snapping. A new
    // gesture can scroll the cards; reversing direction can interrupt the snap.
    if (consumedDirection === direction) return true;
    const top = root.scrollTop;
    if (destination === null && (direction > 0 ? top >= wallTop - EDGE : top <= EDGE || top + delta > wallTop + EDGE)) return false;
    if (gestureDistance >= GESTURE_THRESHOLD) {
      consumedDirection = direction;
      snap(direction > 0 ? wallTop : 0);
    }
    return true;
  };
  const wheel = (event: WheelEvent) => {
    if (event.defaultPrevented || event.ctrlKey || event.shiftKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? root.clientHeight : 1);
    if (!wallTop || !ownsScroll(event.target, delta)) return;
    const now = performance.now();
    if (now - lastWheel > GESTURE_IDLE_MS) { resetGesture(); measure(); }
    lastWheel = now;
    if (move(delta)) event.preventDefault();
  };
  const touchStart = (event: TouchEvent) => {
    resetGesture();
    measure();
    touch = event.touches.length === 1 ? { x: event.touches[0].clientX, y: event.touches[0].clientY } : null;
  };
  const touchMove = (event: TouchEvent) => {
    if (!touch || event.touches.length !== 1 || event.defaultPrevented) { touch = null; return; }
    const point = event.touches[0];
    const dx = touch.x - point.clientX, dy = touch.y - point.clientY;
    touch = { x: point.clientX, y: point.clientY };
    if (Math.abs(dy) > Math.abs(dx) && ownsScroll(event.target, dy) && move(dy)) event.preventDefault();
  };
  const settle = () => {
    if (destination !== null || touch || pointerDown) return;
    if (root.scrollTop > EDGE && root.scrollTop < wallTop - EDGE) snap(scrollDirection > 0 ? wallTop : 0);
  };
  const scroll = () => {
    // Resizing can clamp scrollTop before ResizeObserver repairs the range.
    // Preserve the previous stop until measure() applies the new geometry.
    if (root.clientHeight !== viewportHeight || root.clientWidth !== viewportWidth) return;
    if (root.scrollTop !== lastTop) scrollDirection = Math.sign(root.scrollTop - lastTop);
    lastTop = root.scrollTop;
    markPosition();
    window.clearTimeout(settleTimer);
    if (destination === null) settleTimer = window.setTimeout(settle, 120);
  };
  const touchEnd = () => { touch = null; settle(); };
  const pointerStart = (event: PointerEvent) => {
    pointerDown = true;
    if (event.target === root) cancel();
  };
  const pointerEnd = () => { pointerDown = false; settle(); };
  const key = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey
      || !(event.target instanceof Element) || event.target.closest('input, textarea, select, button, a, [contenteditable="true"], [role="tab"]')) return;
    const direction = ['ArrowDown', 'PageDown'].includes(event.key) || event.key === ' ' && !event.shiftKey ? 1
      : ['ArrowUp', 'PageUp', 'Home'].includes(event.key) || event.key === ' ' && event.shiftKey ? -1 : 0;
    const target = event.target === document.body || event.target === root ? page : event.target;
    if (!direction || !ownsScroll(target, direction)) return;
    measure();
    if (event.key === 'Home' || (direction > 0 ? root.scrollTop < wallTop - EDGE : root.scrollTop > EDGE && root.scrollTop <= wallTop + EDGE)) {
      event.preventDefault();
      resetGesture();
      snap(direction > 0 ? wallTop : 0, false);
    }
  };
  const focus = (event: FocusEvent) => {
    if (event.target instanceof Element && event.target.closest('[data-inspiration-workbench]')) snap(0, false);
  };
  const motionChanged = () => { if (destination !== null && reduced.matches) snap(destination, false); };

  root.scrollTop = 0;
  measure();
  const resize = new ResizeObserver(measure);
  resize.observe(root);
  resize.observe(page);
  resize.observe(toolbar);
  if (workbench) resize.observe(workbench);
  root.addEventListener('wheel', wheel, { passive: false });
  root.addEventListener('touchstart', touchStart, { passive: true });
  root.addEventListener('touchmove', touchMove, { passive: false });
  root.addEventListener('touchend', touchEnd);
  root.addEventListener('touchcancel', touchEnd);
  root.addEventListener('pointerdown', pointerStart);
  document.addEventListener('pointerup', pointerEnd);
  document.addEventListener('pointercancel', pointerEnd);
  root.addEventListener('scroll', scroll, { passive: true });
  document.addEventListener('keydown', key);
  root.addEventListener('focusin', focus);
  reduced.addEventListener('change', motionChanged);
  return () => {
    cancel();
    resize.disconnect();
    root.removeEventListener('wheel', wheel);
    root.removeEventListener('touchstart', touchStart);
    root.removeEventListener('touchmove', touchMove);
    root.removeEventListener('touchend', touchEnd);
    root.removeEventListener('touchcancel', touchEnd);
    root.removeEventListener('pointerdown', pointerStart);
    document.removeEventListener('pointerup', pointerEnd);
    document.removeEventListener('pointercancel', pointerEnd);
    root.removeEventListener('scroll', scroll);
    document.removeEventListener('keydown', key);
    root.removeEventListener('focusin', focus);
    reduced.removeEventListener('change', motionChanged);
    page.style.removeProperty('--inspiration-scroll-height');
    if (paperTransform) paper?.style.setProperty('transform', paperTransform);
    else paper?.style.removeProperty('transform');
    page.removeAttribute('data-inspiration-stage');
    toolbar.removeAttribute('data-stuck');
  };
}
