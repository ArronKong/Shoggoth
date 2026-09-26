import type { InspirationAgent } from '../types';
import seedIcon from '../assets/inspiration/seed.svg';

export type InspirationDropTarget = { element: HTMLElement; agent: InspirationAgent | null; hint?: HTMLElement | null };

// Keep the gesture outside React's render loop. Only pickup and release change
// application state; the floating paper follows the pointer once per frame.
export function beginInspirationCardDrag(source: HTMLElement, pointer: {
  pointerId: number; clientX: number; clientY: number;
}, options: {
  targets: () => InspirationDropTarget[];
  scrollContainer?: () => HTMLElement | null;
  onActive: (active: boolean) => void;
  onDrop: (target: InspirationDropTarget) => void;
}) {
  let x = pointer.clientX, y = pointer.clientY;
  let active = false, stopped = false;
  let frame = 0;
  let ghost: HTMLElement | null = null;
  let content: HTMLElement | null = null;
  let icon: HTMLElement | null = null;
  let morph = 0, lastFrame = 0;
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const morphDuration = 200, iconSize = 32;
  const bottomZoneHeight = 120;
  const iconGrabOffset = iconSize * .7;
  const sourceStyle = getComputedStyle(source);
  const radius = parseFloat(sourceStyle.borderTopLeftRadius) || 0;
  let over: InspirationDropTarget | undefined;
  let marked: HTMLElement[] = [];
  const saved = { opacity: source.style.opacity, userSelect: source.style.userSelect, webkitUserSelect: source.style.webkitUserSelect };
  source.style.userSelect = 'none'; source.style.webkitUserSelect = 'none';
  const viewport = source.closest('main');
  const rect = source.getBoundingClientRect();
  const offsetX = x - rect.left, offsetY = y - rect.top;
  const contains = (r: DOMRect) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  const locate = (targets = options.targets()) => {
    const strip = options.scrollContainer?.();
    const insideStrip = strip && contains(strip.getBoundingClientRect());
    return targets.find(target => {
      if (strip?.contains(target.element) && !insideStrip) return false;
      const r = target.element.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && contains(r);
    });
  };
  const highlight = () => {
    const targets = options.targets();
    const elements = targets.map(target => target.element);
    marked.filter(element => !elements.includes(element)).forEach(element => element.removeAttribute('data-inspiration-drop-ready'));
    elements.filter(element => !marked.includes(element)).forEach(element => element.setAttribute('data-inspiration-drop-ready', ''));
    marked = elements;
    const next = locate(targets);
    if (next?.element !== over?.element) {
      over?.element.removeAttribute('data-inspiration-drop-over');
      next?.element.setAttribute('data-inspiration-drop-over', '');
    }
    if (next?.hint) {
      const bounds = next.element.getBoundingClientRect();
      // Keep edge labels inside the content viewport without narrowing the avatar track.
      const centered = bounds.left + (bounds.width - next.hint.offsetWidth) / 2;
      next.hint.style.left = `${Math.max(64, Math.min(window.innerWidth - next.hint.offsetWidth, centered))}px`;
    }
    over = next;
  };
  const tick = (now: number) => {
    if (stopped || !active) return;
    if (!source.isConnected) { cancel(); return; }
    highlight();
    // The full bottom band prepares the seed before it reaches an Agent.
    // Only locate() determines whether releasing actually hands it over.
    // Captured pointers can cross the window's side or bottom edges. Keep the
    // seed compact there; only moving above the band should expand the paper.
    const inBottomZone = y >= Math.max(0, window.innerHeight - bottomZoneHeight);
    const compact = Boolean(over) || inBottomZone;
    // One reversible linear progress keeps size, corners and text synchronized.
    // Fix the inner layout at its original size so shrinking never reflows text.
    const step = Math.max(0, now - lastFrame) / morphDuration;
    lastFrame = now;
    morph = motion.matches ? (compact ? 1 : 0) : compact ? Math.min(1, morph + step) : Math.max(0, morph - step);
    const mix = (from: number, to: number) => from + (to - from) * morph;
    if (ghost && content && icon) {
      Object.assign(ghost.style, {
        width: `${mix(rect.width, iconSize)}px`, height: `${mix(rect.height, iconSize)}px`,
        borderRadius: `${mix(radius, iconSize / 2)}px`,
        // Keep the grab point inside the circle, at 70% across and down.
        transform: `translate3d(${x - mix(offsetX, iconGrabOffset)}px, ${y - mix(offsetY, iconGrabOffset)}px, 0)`,
      });
      content.style.opacity = String(1 - morph);
      icon.style.opacity = String(morph);
      ghost.setAttribute('data-inspiration-drag-morphed', String(morph === 1));
    }
    const strip = options.scrollContainer?.();
    const overStrip = strip && contains(strip.getBoundingClientRect());
    if (overStrip) {
      const r = strip.getBoundingClientRect();
      const edge = 36;
      const delta = x < r.left + edge ? -Math.min(10, (r.left + edge - x) / 4)
        : x > r.right - edge ? Math.min(10, (x - r.right + edge) / 4) : 0;
      strip.scrollLeft += delta;
    }
    if (viewport && !over && !overStrip && !inBottomZone) {
      const r = viewport.getBoundingClientRect();
      if (x >= r.left && x <= r.right) {
        const delta = y < r.top + 60 ? -Math.min(14, (r.top + 60 - y) / 4)
          : y > r.bottom - 60 ? Math.min(14, (y - r.bottom + 60) / 4) : 0;
        viewport.scrollTop += delta;
      }
    }
    frame = window.requestAnimationFrame(tick);
  };
  const suppressClick = (event: MouseEvent) => {
    if (event.target instanceof Node && source.contains(event.target)) { event.preventDefault(); event.stopPropagation(); }
    clearClickGuard();
  };
  const clearClickGuard = () => {
    source.removeEventListener('click', suppressClick, true);
    source.removeEventListener('pointerdown', clearClickGuard);
  };
  const cancel = () => {
    if (stopped) return;
    stopped = true;
    window.clearTimeout(timer); window.cancelAnimationFrame(frame);
    document.removeEventListener('pointermove', move, true);
    document.removeEventListener('pointerup', release, true);
    document.removeEventListener('pointercancel', pointerCanceled);
    source.removeEventListener('lostpointercapture', pointerCanceled);
    document.removeEventListener('keydown', key);
    document.removeEventListener('visibilitychange', visibility);
    document.removeEventListener('touchmove', touchMove);
    source.removeEventListener('contextmenu', contextMenu);
    source.removeEventListener('dragstart', contextMenu);
    window.removeEventListener('blur', cancel);
    viewport?.removeEventListener('scroll', scroll);
    if (source.hasPointerCapture?.(pointer.pointerId)) source.releasePointerCapture(pointer.pointerId);
    marked.forEach(element => { element.removeAttribute('data-inspiration-drop-ready'); element.removeAttribute('data-inspiration-drop-over'); });
    ghost?.remove();
    Object.assign(source.style, saved); source.removeAttribute('data-inspiration-dragging');
    if (active) {
      options.onActive(false);
      // Cover pointerup even after Escape cancels a held gesture. A fresh
      // pointerdown restores ordinary clicks immediately.
      source.addEventListener('pointerdown', clearClickGuard, { once: true });
    }
  };
  const move = (event: PointerEvent) => {
    if (event.pointerId !== pointer.pointerId) return;
    x = event.clientX; y = event.clientY;
    if (!active && Math.hypot(x - pointer.clientX, y - pointer.clientY) > 8) cancel();
    else if (active) event.preventDefault();
  };
  const release = (event: PointerEvent) => {
    if (event.pointerId !== pointer.pointerId) return;
    x = event.clientX; y = event.clientY;
    const target = active ? locate() : undefined;
    if (active) { event.preventDefault(); event.stopPropagation(); }
    cancel();
    if (target) options.onDrop(target);
  };
  const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); cancel(); } };
  const visibility = () => { if (document.hidden) cancel(); };
  const pointerCanceled = (event: PointerEvent) => { if (event.pointerId === pointer.pointerId) cancel(); };
  const scroll = () => { if (!active) cancel(); };
  const touchMove = (event: TouchEvent) => { if (active) event.preventDefault(); };
  const contextMenu = (event: Event) => event.preventDefault();
  const timer = window.setTimeout(() => {
    if (!source.isConnected || document.hidden) { cancel(); return; }
    active = true;
    source.setPointerCapture?.(pointer.pointerId);
    source.addEventListener('click', suppressClick, true);
    window.getSelection()?.removeAllRanges();
    ghost = source.cloneNode(true) as HTMLElement;
    ghost.removeAttribute('id'); ghost.removeAttribute('data-inspiration-id');
    ghost.querySelectorAll('[id], [data-card-interactive]').forEach(element => {
      if (element.hasAttribute('data-card-interactive')) element.remove(); else element.removeAttribute('id');
    });
    ghost.setAttribute('data-inspiration-drag-ghost', ''); ghost.setAttribute('aria-hidden', 'true'); ghost.inert = true;
    ghost.lang = source.closest('[lang]')?.getAttribute('lang') ?? document.documentElement.lang;
    content = document.createElement('div');
    content.setAttribute('data-inspiration-drag-content', '');
    Object.assign(content.style, { position: 'absolute', left: '0', top: '0', display: sourceStyle.display,
      flexDirection: sourceStyle.flexDirection, gap: sourceStyle.gap, boxSizing: 'border-box',
      width: `${rect.width}px`, height: `${rect.height}px`, padding: sourceStyle.padding });
    content.append(...ghost.childNodes);
    icon = document.createElement('span');
    icon.setAttribute('data-inspiration-drag-icon', '');
    Object.assign(icon.style, { position: 'absolute', left: '50%', top: '50%', width: '16px', height: '16px',
      transform: 'translate(-50%, -50%)', background: 'currentColor', mask: `url("${seedIcon}") center / contain no-repeat`, opacity: '0' });
    ghost.append(content, icon);
    Object.assign(ghost.style, { position: 'fixed', left: '0', top: '0', width: `${rect.width}px`, height: `${rect.height}px`,
      right: 'auto', bottom: 'auto', minWidth: '0', minHeight: '0', maxWidth: 'none', maxHeight: 'none',
      padding: '0', border: '0', boxSizing: 'border-box', overflow: 'hidden', fontFamily: sourceStyle.fontFamily,
      margin: '0', zIndex: '2147483647', pointerEvents: 'none', transition: 'none', opacity: '1',
      willChange: 'transform', transform: `translate3d(${rect.left}px, ${rect.top}px, 0)` });
    document.body.append(ghost);
    // A manual popover puts the paper above dialogs/tooltips as well as the dock.
    // Older webviews retain the fixed, high-z-index fallback.
    if (typeof ghost.showPopover === 'function') {
      ghost.popover = 'manual';
      ghost.showPopover();
    }
    source.style.opacity = '0'; source.setAttribute('data-inspiration-dragging', '');
    options.onActive(true);
    lastFrame = performance.now();
    tick(lastFrame);
  }, 400);
  document.addEventListener('pointermove', move, { capture: true, passive: false });
  document.addEventListener('pointerup', release, true);
  document.addEventListener('pointercancel', pointerCanceled);
  source.addEventListener('lostpointercapture', pointerCanceled);
  document.addEventListener('keydown', key);
  document.addEventListener('visibilitychange', visibility);
  document.addEventListener('touchmove', touchMove, { passive: false });
  source.addEventListener('contextmenu', contextMenu);
  source.addEventListener('dragstart', contextMenu);
  window.addEventListener('blur', cancel);
  viewport?.addEventListener('scroll', scroll, { passive: true });
  return cancel;
}
