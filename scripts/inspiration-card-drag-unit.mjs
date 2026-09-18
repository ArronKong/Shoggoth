import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(path.resolve('app/manage-ui/package.json'));
const ts = require('typescript');
const compiled = ts.transpileModule(fs.readFileSync('app/manage-ui/src/pages/inspiration-card-drag.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const events = () => {
  const listeners = new Map();
  return { addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(listener); },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    dispatch(type, event = {}) { const e = { preventDefault() {}, stopPropagation() {}, ...event }; [...listeners.get(type) ?? []].forEach(listener => listener(e)); },
    count() { return [...listeners.values()].reduce((n, set) => n + set.size, 0); },
  };
};
class Element {
  constructor(rect = {}) {
    Object.assign(this, events());
    this.rect = rect; this.style = { opacity: '', userSelect: '', webkitUserSelect: '' };
    this.attributes = new Map(); this.childNodes = []; this.isConnected = true; this.scrollTop = this.scrollLeft = 0;
  }
  getBoundingClientRect() { return { ...this.rect, right: this.rect.left + this.rect.width, bottom: this.rect.top + this.rect.height }; }
  setAttribute(k, v) { this.attributes.set(k, v); }
  getAttribute(k) { return this.attributes.get(k) ?? null; }
  hasAttribute(k) { return this.attributes.has(k); }
  removeAttribute(k) { this.attributes.delete(k); }
  append(...children) { for (const child of children) { child.remove(); child.parent = this; child.isConnected = true; this.childNodes.push(child); } }
  remove() { if (this.parent) this.parent.childNodes = this.parent.childNodes.filter(child => child !== this); this.parent = null; this.isConnected = false; }
  contains(other) { return other === this || this.childNodes.some(child => child.contains(other)); }
  closest(selector) { return selector === 'main' ? this.viewport : selector === '[lang]' ? this.locale : null; }
  querySelectorAll() { return this.childNodes.flatMap(child => [...(child.hasAttribute('id') || child.hasAttribute('data-card-interactive') ? [child] : []), ...child.querySelectorAll()]); }
  cloneNode() { const copy = new Element(this.rect); copy.style = { ...this.style }; copy.attributes = new Map(this.attributes); copy.append(...this.childNodes.map(child => child.cloneNode())); return copy; }
  setPointerCapture(id) { this.capture = id; }
  hasPointerCapture(id) { return this.capture === id; }
  releasePointerCapture() { this.capture = null; }
  showPopover() { this.topLayer = true; }
}
function fixture({ reduced = false, popover = true } = {}) {
  let now = 0, id = 0;
  const timers = new Map(), frames = new Map();
  const document = { ...events(), hidden: false, body: new Element(), documentElement: { lang: 'en' },
    createElement: () => new Element() };
  const window = { ...events(), innerWidth: 1280, innerHeight: 900, matchMedia: () => ({ matches: reduced }), getSelection: () => null,
    setTimeout: (fn, ms) => { timers.set(++id, { fn, at: now + ms }); return id; }, clearTimeout: id => timers.delete(id),
    requestAnimationFrame: fn => { frames.set(++id, fn); return id; }, cancelAnimationFrame: id => frames.delete(id) };
  const source = new Element({ left: 100, top: 120, width: 400, height: 240 });
  source.setAttribute('id', 'source'); source.setAttribute('data-inspiration-id', 'idea');
  source.locale = new Element(); source.locale.setAttribute('lang', 'zh-CN');
  const text = new Element(); text.setAttribute('id', 'text');
  const action = new Element(); action.setAttribute('data-card-interactive', '');
  source.append(text, action);
  if (!popover) source.cloneNode = () => { const ghost = Element.prototype.cloneNode.call(source); ghost.showPopover = undefined; return ghost; };
  const viewport = new Element({ left: 64, top: 0, width: 1200, height: 900 }); source.viewport = viewport;
  const strip = new Element({ left: 400, top: 780, width: 600, height: 100 });
  const target = { element: new Element({ left: 500, top: 800, width: 64, height: 48 }), agent: { id: 'one' } };
  strip.append(target.element);
  const defaultTarget = { element: new Element({ left: 600, top: 40, width: 48, height: 48 }), agent: null };
  const active = [], dropped = [];
  const mod = { exports: {} };
  vm.runInNewContext(compiled, { exports: mod.exports, require: () => '/seed.svg', window, document, Node: Element,
    performance: { now: () => now }, getComputedStyle: () => ({ borderTopLeftRadius: '24px', display: 'flex', flexDirection: 'column', gap: '32px', padding: '24px 24px 20px', fontFamily: 'ChillKai' }) });
  const cancel = mod.exports.beginInspirationCardDrag(source, { pointerId: 1, clientX: 220, clientY: 200 }, {
    targets: () => [target, defaultTarget], scrollContainer: () => strip, onActive: value => active.push(value), onDrop: value => dropped.push(value),
  });
  const advance = ms => { now += ms; for (const [key, timer] of [...timers]) if (timer.at <= now) { timers.delete(key); timer.fn(); } };
  const frame = ms => { now += ms; const queued = [...frames.values()]; frames.clear(); queued.forEach(fn => fn(now)); };
  const move = (x, y, pointerId = 1) => document.dispatch('pointermove', { clientX: x, clientY: y, pointerId });
  const release = (x, y, pointerId = 1) => document.dispatch('pointerup', { clientX: x, clientY: y, pointerId });
  const pickup = () => { advance(400); return document.body.childNodes[0]; };
  const clean = () => {
    assert.equal(source.style.opacity, ''); assert.equal(source.style.userSelect, ''); assert.equal(source.style.webkitUserSelect, '');
    assert.equal(source.hasAttribute('data-inspiration-dragging'), false); assert.equal(source.hasPointerCapture(1), false);
    assert.equal(document.body.childNodes.length, 0); assert.equal(document.count() + window.count() + viewport.count(), 0);
    for (const t of [target, defaultTarget]) { assert.equal(t.element.hasAttribute('data-inspiration-drop-over'), false); assert.equal(t.element.hasAttribute('data-inspiration-drop-ready'), false); }
    assert.equal(timers.size + frames.size, 0);
    source.dispatch('pointerdown'); assert.equal(source.count(), 0, 'the next gesture clears the one-click guard');
  };
  return { source, document, window, viewport, target, defaultTarget, strip, active, dropped, cancel, advance, frame, move, release, pickup, clean };
}
{
  const f = fixture(); f.advance(399); assert.equal(f.document.body.childNodes.length, 0); f.advance(1);
  const ghost = f.document.body.childNodes[0], [content, icon] = ghost.childNodes;
  assert.equal(f.source.style.opacity, '0', 'pickup leaves an empty slot'); assert.equal(ghost.style.opacity, '1');
  assert.equal(ghost.topLayer, true); assert.equal(ghost.popover, 'manual'); assert.equal(ghost.inert, true);
  assert.equal(ghost.lang, 'zh-CN'); assert.equal(ghost.style.fontFamily, 'ChillKai');
  assert.equal(ghost.hasAttribute('id'), false); assert.equal(ghost.hasAttribute('data-inspiration-id'), false);
  assert.equal(ghost.querySelectorAll().length, 0, 'the floating copy has no duplicated IDs or card controls');
  assert.equal(ghost.style.transform, 'translate3d(100px, 120px, 0)');
  f.move(532, 824); f.frame(100);
  assert.equal(ghost.style.width, '216px'); assert.equal(ghost.style.height, '136px'); assert.equal(ghost.style.borderRadius, '20px');
  assert.equal(content.style.opacity, '0.5'); assert.equal(icon.style.opacity, '0.5');
  assert.equal(ghost.style.transform, 'translate3d(460.8px, 772.8px, 0)', 'the grab point moves linearly with the morph');
  assert.equal(content.style.width, '400px', 'text retains its original wrapping');
  f.move(300, 450); f.frame(50);
  assert.equal(ghost.style.width, '308px'); assert.equal(content.style.opacity, '0.75', 'leaving reverses from the current frame');
  f.move(532, 824); f.frame(150);
  assert.equal(ghost.style.width, '32px'); assert.equal(ghost.style.height, '32px'); assert.equal(ghost.style.borderRadius, '16px');
  assert.equal(content.style.opacity, '0'); assert.equal(icon.style.opacity, '1');
  assert.equal(ghost.style.transform, 'translate3d(509.6px, 801.6px, 0)', 'the pointer sits inside the circle at 70% across and down, matching the green reference point');
  assert.equal(f.target.element.hasAttribute('data-inspiration-drop-over'), true);
  f.release(532, 824, 2); assert.equal(f.active.length, 1, 'another pointer cannot release the gesture');
  f.release(532, 824); f.release(532, 824);
  assert.deepEqual(f.active, [true, false]); assert.deepEqual(f.dropped, [f.target]); f.clean();
}
for (const reason of ['move', 'scroll', 'release']) {
  const f = fixture(); f.advance(200);
  if (reason === 'move') f.move(250, 200);
  if (reason === 'scroll') f.viewport.dispatch('scroll');
  if (reason === 'release') f.release(220, 200);
  f.advance(400); assert.deepEqual(f.active, []); f.clean();
}
{
  const f = fixture(); const ghost = f.pickup();
  f.move(200, 779); f.frame(200);
  assert.equal(ghost.style.width, '400px', '121px from the bottom is outside the band');
  f.move(200, 780); f.frame(100);
  assert.equal(ghost.style.width, '216px', 'entering the bottom 120px starts the same linear morph without an Agent beneath');
  f.frame(100); assert.equal(ghost.style.width, '32px');
  assert.equal(f.target.element.hasAttribute('data-inspiration-drop-over'), false, 'the bottom band is not itself an execution target');
  f.move(532, 824); f.frame(16);
  assert.equal(f.target.element.hasAttribute('data-inspiration-drop-over'), true);
  f.move(1100, 880); f.frame(200);
  assert.equal(ghost.style.width, '32px', 'moving away from the avatar within the band keeps the seed compact');
  assert.equal(f.target.element.hasAttribute('data-inspiration-drop-over'), false);
  assert.equal(f.viewport.scrollTop, 0, 'the handoff band does not scroll the wall behind the dock');
  f.move(1100, 779); f.frame(100);
  assert.equal(ghost.style.width, '216px', 'leaving the band reverses the morph continuously');
  f.frame(100); assert.equal(ghost.style.width, '400px');
  f.move(200, 880); f.frame(200); f.release(200, 880);
  assert.equal(f.dropped.length, 0, 'releasing in empty bottom space cannot start an Agent'); f.clean();
}
for (const reduced of [false, true]) {
  const f = fixture({ reduced }); const ghost = f.pickup();
  f.move(1100, 880); f.frame(100);
  assert.equal(ghost.style.width, reduced ? '32px' : '216px');
  f.move(1281, 901); f.frame(100);
  assert.equal(ghost.style.width, '32px', 'crossing the bottom-right corner during pickup must finish shrinking');
  for (const [x, y] of [[1279.75, 899.75], [1280, 900], [1280.5, 880], [1100, 900.5], [1281, 901], [-1, 880], [1400, 1100]]) {
    f.move(x, y); f.frame(200);
    assert.equal(ghost.style.width, '32px', `captured pointer at (${x}, ${y}) must stay compact at the App edges`);
    assert.equal(ghost.style.height, '32px');
    assert.equal(ghost.childNodes[0].style.opacity, '0', 'card text stays hidden at the edges');
    assert.equal(f.target.element.hasAttribute('data-inspiration-drop-over'), false);
  }
  assert.equal(f.viewport.scrollTop, 0, 'crossing the window edges does not scroll the wall');
  f.move(1100, 779); f.frame(100);
  assert.equal(ghost.style.width, reduced ? '400px' : '216px', 'moving above the bottom band still restores the card');
  f.frame(100); assert.equal(ghost.style.width, '400px');
  f.move(1281, 901); f.frame(200); f.release(1281, 901);
  assert.equal(f.dropped.length, 0, 'releasing outside the App cannot start an Agent'); f.clean();
}
{
  const f = fixture({ reduced: true }); const ghost = f.pickup();
  f.move(200, 780); f.frame(1); assert.equal(ghost.style.width, '32px');
  f.window.innerHeight = 1000; f.frame(1);
  assert.equal(ghost.style.width, '400px', 'the bottom band follows a resized App window');
  f.move(200, 880); f.frame(1); assert.equal(ghost.style.width, '32px');
  f.move(624, 64); f.frame(1);
  assert.equal(ghost.style.width, '32px', 'the existing default Agent tab remains a compact target');
  f.cancel(); f.clean();
}
for (const reason of ['escape', 'cancel', 'lostcapture', 'blur', 'hidden', 'route', 'removed', 'outside']) {
  const f = fixture(); f.pickup(); f.move(532, 824); f.frame(200);
  if (reason === 'escape') f.document.dispatch('keydown', { key: 'Escape' });
  if (reason === 'cancel') f.document.dispatch('pointercancel', { pointerId: 1 });
  if (reason === 'lostcapture') f.source.dispatch('lostpointercapture', { pointerId: 1 });
  if (reason === 'blur') f.window.dispatch('blur');
  if (reason === 'hidden') { f.document.hidden = true; f.document.dispatch('visibilitychange'); }
  if (reason === 'route') f.cancel();
  if (reason === 'removed') { f.source.isConnected = false; f.frame(16); }
  if (reason === 'outside') f.release(300, 450);
  assert.equal(f.dropped.length, 0, reason); f.clean();
}
{
  const f = fixture({ reduced: true, popover: false }); const ghost = f.pickup();
  assert.equal(ghost.style.zIndex, '2147483647', 'older webviews still float above the dock');
  f.move(532, 824); f.frame(1); assert.equal(ghost.style.width, '32px', 'reduced motion snaps to the circular affordance');
  f.move(300, 450); f.frame(1); assert.equal(ghost.style.width, '400px');
  f.release(624, 64); assert.deepEqual(f.dropped, [f.defaultTarget], 'the default Agent tab still accepts release'); f.clean();
}
{
  const f = fixture(); f.pickup(); f.move(998, 825); f.frame(16); assert.ok(f.strip.scrollLeft > 0, 'wide rosters still auto-scroll');
  f.target.element.rect.left = 1010; f.release(1030, 824); assert.equal(f.dropped.length, 0, 'clipped Agents outside the strip cannot accept drops'); f.clean();
}
console.log('PASS card drag: long press, empty source, top layer, 120px bottom band, captured pointer at window edges, linear/reversible circle morph, text fade, reduced motion, target hit testing and complete cleanup');
