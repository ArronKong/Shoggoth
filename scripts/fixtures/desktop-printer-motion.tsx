import React from 'react';
import { createRoot } from 'react-dom/client';
import DesktopInspiration from '../../app/manage-ui/src/pages/DesktopInspiration';
import { UiProvider } from '../../app/manage-ui/src/components/ui';
import type { DesktopPrinterGeometry } from '../../app/manage-ui/src/lib/desktop-inspiration';
import i18n from '../../app/manage-ui/src/i18n';
import '../../app/manage-ui/src/styles.css';

document.documentElement.setAttribute('data-desktop-inspiration', '');
document.documentElement.style.colorScheme = 'light';
void i18n.changeLanguage('zh-CN');
localStorage.setItem('shoggoth.inspiration.capture.v1', JSON.stringify({ body: '记下一闪而过的想法。', operationId: crypto.randomUUID(), paperTone: 0 }));
const shows = new Set<(geometry: DesktopPrinterGeometry) => void>(), hides = new Set<() => void>();
const exits = new Set<(id: number) => void>();
const geometries = new Set<(geometry: DesktopPrinterGeometry) => void>();
const errors: string[] = [], acknowledged: unknown[] = [];
let serial = 0, visible = false, requested = false, busy = false, saved = 0, manual = false, reduced = false;
const mediaEvents = new EventTarget();
const realMatchMedia = window.matchMedia.bind(window);
window.matchMedia = query => query !== '(prefers-reduced-motion: reduce)' ? realMatchMedia(query) : ({
  get matches() { return reduced; }, media: query,
  addEventListener: mediaEvents.addEventListener.bind(mediaEvents), removeEventListener: mediaEvents.removeEventListener.bind(mediaEvents),
} as MediaQueryList);
const animations = () => document.getAnimations().filter(animation => animation.id.startsWith('desktop-printer-'));
const animate = Element.prototype.animate;
Element.prototype.animate = function (frames, options) {
  const animation = animate.call(this, frames, options);
  if (manual && typeof options === 'object' && options.id?.startsWith('desktop-printer-')) {
    animation.play = () => { animation.pause(); animation.currentTime = 0; };
  }
  return animation;
};
const geometry = (): DesktopPrinterGeometry => ({ top: 0, center: innerWidth / 2, tray: { x: innerWidth - 36, y: 12 }, presentationId: serial });
const show = () => { requested = true; serial++; shows.forEach(callback => callback(geometry())); };
// Force-hidden is used only to reset the frame probe; user controls use dismiss.
const hide = () => { if (busy) return; requested = false; visible = false; serial++; hides.forEach(callback => callback()); };
const dismiss = () => { if (busy || !requested) return; requested = false; serial++; exits.forEach(callback => callback(serial)); };
const rect = (selector: string) => {
  const element = document.querySelector<HTMLElement>(selector)!;
  const bounds = element.getBoundingClientRect();
  return { top: bounds.top, bottom: bounds.bottom, width: bounds.width, height: bounds.height,
    transform: getComputedStyle(element).transform, visibility: getComputedStyle(element).visibility };
};
const inspect = () => ({ machine: rect('[data-typewriter-housing]'), paper: rect('[data-paper]'),
  outlet: rect('[data-paper-window]'), workbench: rect('[data-desktop-workbench]'),
  focused: document.activeElement?.tagName, draft: document.querySelector('textarea')?.value,
  animations: animations().map(animation => ({ id: animation.id, state: animation.playState, time: animation.currentTime })),
  active: document.querySelector('[data-desktop-printer]')?.hasAttribute('data-active'), visible, saved, acknowledged: acknowledged.length, errors });
if (!(window as unknown as { openclawDesktop?: { desktopInspiration?: unknown } }).openclawDesktop?.desktopInspiration) Object.assign(window, { openclawDesktop: { desktopInspiration: {
  surface: true, ready: async () => { show(); return geometry(); },
  reveal: async (id: number) => { acknowledged.push(inspect()); if (!requested || id !== serial) return false; visible = true; return true; },
  conceal: async (id: number) => { if (requested || id !== serial) return false; visible = false; hides.forEach(callback => callback()); return true; },
  dismiss: async () => { dismiss(); return true; }, trayTarget: async () => geometry().tray,
  setInteractive() {}, setBusy(value: boolean) { busy = value; },
  onShow(callback: (value: DesktopPrinterGeometry) => void) { shows.add(callback); return () => shows.delete(callback); },
  onHide(callback: (id: number) => void) { exits.add(callback); return () => exits.delete(callback); },
  onHidden(callback: () => void) { hides.add(callback); return () => hides.delete(callback); },
  onGeometry(callback: (value: DesktopPrinterGeometry) => void) { geometries.add(callback); return () => geometries.delete(callback); },
} } });
const fetchOriginal = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = new URL(String(input), location.href);
  if (!url.pathname.startsWith('/__api/')) return fetchOriginal(input, init);
  if (init?.method === 'POST') {
    saved++;
    const draft = JSON.parse(String(init.body));
    return Response.json({ idea: { ...draft, id: crypto.randomUUID(), createdAt: Date.now(), updatedAt: Date.now(), status: 'saved' } });
  }
  return Response.json({ items: [], total: saved, hasMore: false, nextCursor: null });
};
window.addEventListener('error', event => errors.push(event.message));
window.addEventListener('unhandledrejection', event => errors.push(String(event.reason)));
const at = (ms: number) => { animations().forEach(animation => { animation.pause(); animation.currentTime = ms; }); return inspect(); };
const fixture = { show, hide, dismiss, inspect, at, acknowledged,
  finish() { animations().forEach(animation => animation.finish()); },
  setManual(value: boolean) { manual = value; },
  setReduced(value: boolean) { reduced = value; mediaEvents.dispatchEvent(new Event('change')); },
  reposition() { geometries.forEach(callback => callback(geometry())); },
};
Object.assign(window, { __desktopPrinterFixture: fixture });
createRoot(document.getElementById('root')!).render(<UiProvider>
  <DesktopInspiration />
  <aside data-desktop-interactive style={{ position: 'fixed', zIndex: 20, bottom: 24, left: 24, right: 24, display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', justifyContent: 'center', font: '12px system-ui' }}>
    <span>隔离动效预览</span>
    <button onClick={() => { manual = false; show(); }}>重新呼出</button>
    <button onClick={() => { manual = false; dismiss(); }}>收起</button>
    <button onClick={() => { manual = true; show(); }}>逐帧：起点</button>
    <button onClick={() => at(100)}>机器滑入</button>
    <button onClick={() => at(220)}>便签送出</button>
    <button onClick={() => at(540)}>默认位置</button>
    <button onClick={() => { manual = true; dismiss(); }}>逐帧：收起</button>
    <button onClick={() => at(60)}>便签收回</button>
    <button onClick={() => at(200)}>机器退场</button>
    <button onClick={() => at(300)}>退场终点</button>
  </aside>
</UiProvider>);
