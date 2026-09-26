import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../app/manage-ui/package.json', import.meta.url));
const ts = require('typescript');
const code = ts.transpileModule(fs.readFileSync(new URL('../app/manage-ui/src/pages/inspiration-scroll-stages.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function fixture({ reducedMotion = false, longWall = false, paperScale = 1 } = {}) {
  let now = 0, id = 0, scrollTop = 0;
  const frames = new Map(), timers = new Map(), observers = new Set();
  class Element {
    listeners = new Map(); attrs = new Map(); props = new Map();
    parentElement = null; clientHeight = 0; scrollHeight = 0; scrollTop = 0;
    computed = { overflowY: 'visible', top: '92px' };
    style = { getPropertyValue: key => this.props.get(key) || '',
      setProperty: (key, value) => this.props.set(key, value), removeProperty: key => this.props.delete(key) };
    constructor(name) { this.name = name; }
    addEventListener(name, fn) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name).add(fn); }
    removeEventListener(name, fn) { this.listeners.get(name)?.delete(fn); }
    fire(type, props = {}) {
      const event = { target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...props };
      for (const fn of this.listeners.get(type) || []) fn(event);
      return event;
    }
    contains(node) { return node === this || Boolean(node?.parentElement && this.contains(node.parentElement)); }
    closest(selector) {
      if (selector === 'main') return root;
      if (selector === '[data-inspiration-workbench]') return this === input ? workbench : null;
      return selector.includes(this.name) ? this : null;
    }
    querySelector(selector) {
      if (selector.includes('[data-inspiration-resizing]') && workbench.attrs.has('data-inspiration-resizing')) return workbench;
      return selector === '[data-inspiration-workbench]' ? workbench : selector === '[data-paper-window]' ? paper : null;
    }
    setAttribute(key, value) { this.attrs.set(key, value); }
    removeAttribute(key) { this.attrs.delete(key); }
    toggleAttribute(key, on) { if (on) this.attrs.set(key, ''); else this.attrs.delete(key); }
    getBoundingClientRect() {
      if (this === paper) return { bottom: 24 + paperBottom(), width: 486 * paperScale };
      return { top: this === root ? 24 : 24 + anchorTop - root.scrollTop + offset() };
    }
  }
  const root = new Element('main'), page = new Element('div'), toolbar = new Element('nav'), anchor = new Element('div');
  const workbench = new Element('section'), wall = new Element('section'), input = new Element('textarea'), document = new Element('document');
  const paper = new Element('paper-window'); paper.parentElement = workbench;
  paper.computed = { width: '486px', overflowClipMargin: '40px' };
  document.body = new Element('body');
  page.parentElement = root; wall.parentElement = page; toolbar.parentElement = wall; anchor.parentElement = wall;
  workbench.parentElement = page; input.parentElement = workbench;
  const offset = () => Number(wall.props.get('transform')?.match(/,\s*(-?[\d.e+]+)px/)?.[1] || 0);
  const paperShift = () => Number(paper.props.get('transform')?.match(/,\s*(-?[\d.e+]+)px/)?.[1] || 0);
  const paperBottom = () => anchorTop - 63 - root.scrollTop + offset() + paperShift() * paperScale;
  const visualTop = () => root.scrollTop - offset();
  root.clientHeight = 800;
  let anchorTop = 440;
  Object.defineProperty(root, 'scrollTop', { get: () => scrollTop, set(value) {
    const max = Math.max(longWall ? 1500 : 0, (parseFloat(page.props.get('--inspiration-scroll-height')) || 800) - root.clientHeight);
    const next = Math.max(0, Math.min(value, max));
    if (next !== scrollTop) { scrollTop = next; root.fire('scroll'); }
  } });
  const media = new Element('media'); media.matches = reducedMotion;
  const mod = { exports: {} };
  vm.runInNewContext(code, { exports: mod.exports, Element, document, performance: { now: () => now },
    getComputedStyle: element => element.computed,
    ResizeObserver: class {
      constructor(callback) { this.callback = callback; observers.add(this); }
      observe() {} disconnect() { observers.delete(this); }
    },
    window: {
      matchMedia: () => media,
      requestAnimationFrame: fn => { const key = ++id; frames.set(key, fn); return key; },
      cancelAnimationFrame: key => frames.delete(key),
      setTimeout: (fn, delay) => { const key = ++id; timers.set(key, { fn, at: now + delay }); return key; },
      clearTimeout: key => timers.delete(key),
    },
  });
  const expandedChanges = [];
  const cleanup = mod.exports.attachInspirationScrollStages(page, toolbar, anchor, expanded => expandedChanges.push(expanded));
  const advance = (duration = 650, step = 16) => {
    const until = now + duration;
    while (now < until) {
      now = Math.min(until, now + step);
      for (const [key, timer] of [...timers]) if (timer.at <= now) { timers.delete(key); timer.fn(); }
      const pending = [...frames]; frames.clear(); pending.forEach(([, fn]) => fn(now));
    }
  };
  const wheel = (deltaY, props = {}) => {
    const event = root.fire('wheel', { target: page, deltaY, deltaX: 0, deltaMode: 0, ...props });
    if (!event.defaultPrevented && !props.target) root.scrollTop += deltaY;
    return event;
  };
  const resize = top => { anchorTop = top; for (const observer of observers) observer.callback(); };
  const resizeViewport = height => { root.clientHeight = height; root.scrollTop = root.scrollTop; resize(anchorTop); };
  return { root, page, toolbar, workbench, wall, paper, input, document, frames, media, observers, cleanup, advance, wheel, resize, resizeViewport, offset, visualTop, paperShift, paperBottom, expandedChanges };
}

{
  const f = fixture();
  assert.equal(f.root.scrollTop, 0);
  f.wheel(4); f.wheel(4); f.wheel(4); f.advance();
  assert.equal(f.root.scrollTop, 348, 'a small upward swipe reaches the pinned toolbar, including an empty wall');
  assert.equal(f.toolbar.attrs.has('data-stuck'), true, 'the opaque backdrop covers the whole typewriter at the exact stop');
  assert.equal(f.page.attrs.get('data-inspiration-stage'), 'wall');
  assert.deepEqual(f.expandedChanges, [false], 'collapse disables screen activity once, not on every animation frame');
  f.wheel(-16); f.advance();
  assert.equal(f.root.scrollTop, 0, 'a downward swipe restores the complete workbench');
  assert.equal(f.toolbar.attrs.has('data-stuck'), false);
  assert.deepEqual(f.expandedChanges, [false, true], 'expanding re-enables screen activity');
  f.cleanup();
  assert.equal(f.frames.size, 0); assert.equal(f.observers.size, 0);
  assert.equal(f.page.props.size, 0);
  assert.equal([...f.root.listeners.values(), ...f.document.listeners.values()].some(listeners => listeners.size), false);
}
{
  const f = fixture({ longWall: true });
  f.wheel(60);
  for (let i = 0; i < 12; i++) { f.advance(40); f.wheel(20); }
  assert.equal(f.root.scrollTop, 348, 'inertia from the first gesture cannot skip the wall stop');
  f.advance(200); f.wheel(200);
  assert.equal(f.root.scrollTop, 548, 'the next gesture scrolls the long wall normally');
  f.wheel(-30);
  assert.equal(f.root.scrollTop, 518, 'scrolling back through the cards keeps their native position');
  f.wheel(-190); f.advance();
  assert.equal(f.root.scrollTop, 0, 'crossing back through the wall stop reveals the workbench');
  f.cleanup();
}
{
  const f = fixture();
  f.wheel(60); f.advance(64);
  assert.ok(f.root.scrollTop > 0 && f.root.scrollTop < 348);
  const before = f.root.scrollTop;
  f.wheel(-60);
  assert.equal(f.root.scrollTop, before, 'changing destination does not jump the current position');
  f.advance(16);
  assert.ok(f.root.scrollTop > before, 'the reverse gesture first brakes the inherited forward velocity');
  f.advance(64);
  assert.ok(f.root.scrollTop < before, 'the spring then follows the reverse gesture');
  f.advance(); assert.equal(f.root.scrollTop, 0);
  assert.equal(f.wheel(30, { deltaX: 50 }).defaultPrevented, false);
  assert.equal(f.wheel(30, { ctrlKey: true }).defaultPrevented, false);
  f.input.scrollHeight = 400; f.input.clientHeight = 100; f.input.computed.overflowY = 'auto';
  assert.equal(f.wheel(30, { target: f.input }).defaultPrevented, false, 'the editor scrolls its own long draft');
  f.cleanup();
}
{
  const f = fixture({ reducedMotion: true });
  f.wheel(20);
  assert.equal(f.root.scrollTop, 348); assert.equal(f.frames.size, 0);
  f.resize(510);
  assert.equal(f.root.scrollTop, 418, 'resizing preserves the pinned stop');
  f.resizeViewport(1300);
  assert.equal(f.root.scrollTop, 418, 'growing an empty viewport preserves the stop even when the browser first clamps scrollTop');
  f.root.fire('focusin', { target: f.input });
  assert.equal(f.root.scrollTop, 0, 'keyboard focus restores the entire editor');
  f.document.fire('keydown', { target: f.document.body, key: 'PageDown' });
  assert.equal(f.root.scrollTop, 418); assert.equal(f.frames.size, 0);
  f.document.fire('keydown', { target: f.document.body, key: 'Home' });
  assert.equal(f.root.scrollTop, 0);
  f.cleanup();
}
{
  const f = fixture();
  f.root.fire('touchstart', { touches: [{ clientX: 300, clientY: 450 }] });
  const swipe = f.root.fire('touchmove', { target: f.page, touches: [{ clientX: 300, clientY: 400 }] });
  assert.equal(swipe.defaultPrevented, true);
  f.root.fire('touchend'); f.advance(); assert.equal(f.root.scrollTop, 348);
  f.root.fire('touchstart', { touches: [{ clientX: 300, clientY: 400 }] });
  f.root.fire('touchmove', { target: f.page, touches: [{ clientX: 300, clientY: 450 }] });
  f.root.fire('touchend'); f.advance(); assert.equal(f.root.scrollTop, 0);
  f.root.scrollTop = 140; f.advance(500);
  assert.equal(f.root.scrollTop, 348, 'scrollbar scrolling also settles out of the intermediate state');
  f.cleanup();
}
{
  const f = fixture();
  f.wheel(60);
  const positions = [f.visualTop()];
  for (let i = 0; i < 40; i++) { f.advance(16); positions.push(f.visualTop()); }
  assert.ok(positions[8] > 60 && positions[8] < 140, 'the visible machine body is still moving out after 128 ms, instead of disappearing in the first few frames');
  assert.ok(Math.max(...positions.slice(1).map((position, i) => position - positions[i])) < 30, 'collapse spreads the travel evenly without a sudden high-speed exit');
  assert.ok(Math.max(...positions) > 352 && Math.max(...positions) < 360, 'the wall has one small visible overshoot even without native scroll room');
  assert.equal(f.root.scrollTop, 348);
  assert.equal(f.offset(), 0);
  assert.equal(f.page.props.has('transform'), false, 'the sticky page title never participates in the rebound');
  f.wheel(-60);
  const returning = [];
  for (let i = 0; i < 30; i++) { f.advance(16); returning.push(f.visualTop()); }
  assert.ok(Math.min(...returning) < -4 && Math.min(...returning) > -12, 'the expanded workbench rebounds gently at the top boundary');
  assert.equal(f.root.scrollTop, 0);
  assert.equal(f.workbench.props.has('transform'), false);
  assert.equal(f.wall.props.has('transform'), false);
  f.cleanup();
}
{
  const f = fixture();
  f.wheel(60); f.advance(368);
  assert.ok(f.offset() < -4);
  f.resize(440);
  assert.equal(f.page.props.get('--inspiration-scroll-height'), '1148px', 'the elastic transform cannot move the measured docking point');
  const before = f.visualTop();
  f.wheel(-60);
  assert.equal(f.visualTop(), before, 'reversing during the rebound preserves its full visible position');
  f.advance();
  f.wheel(60); f.advance(368);
  f.media.matches = true; f.media.fire('change');
  assert.equal(f.root.scrollTop, 348);
  assert.equal(f.offset(), 0);
  assert.equal(f.frames.size, 0, 'reduced motion immediately removes an in-flight rebound');
  f.cleanup();
}
{
  const a = fixture(), b = fixture();
  a.wheel(60); b.wheel(60);
  a.advance(96, 16); b.advance(96, 8);
  assert.ok(Math.abs(a.visualTop() - b.visualTop()) < .001, '60 Hz and 120 Hz produce the same spring trajectory');
  a.advance(256, 16); b.advance(256, 8);
  assert.ok(Math.abs(a.visualTop() - b.visualTop()) < .001, 'the travel-to-spring handoff also stays independent of frame rate');
  a.advance(1000, 1000);
  assert.equal(a.root.scrollTop, 348);
  assert.equal(a.frames.size, 0, 'a delayed frame settles without unstable integration');
  a.cleanup(); b.cleanup();
}
for (const paperScale of [1, .5]) {
  const f = fixture({ paperScale });
  f.wheel(60); f.advance(32);
  assert.ok(f.paperShift() < 0, 'the sheet retracts from the beginning of the main scroll');
  const shift = f.paperShift();
  f.resize(440);
  assert.ok(Math.abs(f.paperShift() - shift) < .001, 'measuring a moving sheet cannot accumulate extra translation');
  for (let i = 0; i < 30; i++) {
    f.advance(16);
    if (f.toolbar.attrs.has('data-stuck')) assert.ok(f.paperBottom() + 40 * paperScale <= -7, 'paper and shadow clear the viewport before the toolbar backdrop appears, including zoomed layouts');
  }
  f.wheel(-60); f.advance(48);
  assert.ok(f.paperShift() > -77 / paperScale, 'expanding brings the paper back along its continuous trajectory');
  f.advance();
  assert.equal(f.paperBottom(), 377);
  assert.equal(f.paper.props.has('transform'), false);
  f.cleanup();
}
{
  const f = fixture();
  f.workbench.setAttribute('data-inspiration-resizing', '');
  f.root.fire('touchstart', { touches: [{ clientX: 300, clientY: 450 }] });
  const resize = f.root.fire('touchmove', { target: f.workbench, touches: [{ clientX: 300, clientY: 510 }] });
  assert.equal(resize.defaultPrevented, false, 'paper resizing owns its touch gesture');
  assert.equal(f.frames.size, 0, 'resizing cannot start the typewriter collapse animation');
  f.resize(620);
  assert.equal(f.root.scrollTop, 0, 'growing the sheet preserves the expanded workbench');
  f.root.fire('touchend'); f.workbench.removeAttribute('data-inspiration-resizing');
  f.wheel(60); f.advance();
  assert.equal(f.root.scrollTop, 528, 'scrolling still docks below the resized sheet');
  f.cleanup();
}
console.log('PASS inspiration two-stage scrolling: balanced collapse, continuous paper retraction, spring rebound, velocity continuity, frame-rate independence, gesture stops, nested scrolling, touch, keyboard, resize and cleanup');
