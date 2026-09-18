import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(root, 'app/manage-ui/package.json'));
const ts = require('typescript');
const file = path.join(root, 'app/manage-ui/src/pages/inspiration-paper-motion.ts');
const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} }).outputText;
const events = () => {
  const listeners = new Map();
  return { listeners,
    addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(listener); },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    dispatch(type) { [...listeners.get(type) ?? []].forEach(listener => listener()); },
    count() { return [...listeners.values()].reduce((sum, set) => sum + set.size, 0); },
  };
};
const motion = { ...events(), matches: false };
const document = { ...events(), hidden: false };
const window = { ...events(), matchMedia: () => motion };
const mod = { exports: {} };
vm.runInNewContext(compiled, { exports: mod.exports, window, document, getComputedStyle: element => ({ ...element.computedStyle, ...element.style }) });
const { prepareInspirationPaperFlight: prepare } = mod.exports;

class Element {
  constructor(rect) {
    this.rect = rect; this.style = { visibility: '', display: '' }; this.attributes = new Map();
    this.computedStyle = {};
    this.isConnected = true; this.animations = []; this.children = [];
  }
  getBoundingClientRect() { return { ...this.rect }; }
  setAttribute(key, value) { this.attributes.set(key, value); }
  removeAttribute(key) { this.attributes.delete(key); }
  querySelector(selector) { return (selector === '[data-inspiration-media-content]' ? this.mediaContent : selector === '[data-inspiration-body]' ? this.bodyNode : this.input) ?? null; }
  querySelectorAll(selector) { return selector === 'textarea' ? this.inputs ?? (this.input ? [this.input] : []) : []; }
  cloneNode() {
    const copy = new Element(this.rect);
    copy.attributes = new Map(this.attributes);
    copy.computedStyle = { ...this.computedStyle };
    copy.value = this.value;
    copy.scrollTop = this.scrollTop;
    if (this.input) {
      copy.input = this.input.cloneNode();
      copy.input.parentElement = this.input.parentElement.cloneNode();
      if (this.input.captureAncestor) copy.input.captureAncestor = this.input.captureAncestor.cloneNode();
    }
    if (this.inputs) copy.inputs = [copy.input, ...this.inputs.slice(1).map(input => input.cloneNode())];
    return copy;
  }
  append(...children) { for (const child of children) { this.children.push(child); child.parent = this; } }
  remove() { this.isConnected = false; this.parent.children = this.parent.children.filter(child => child !== this); }
  closest(selector) { return selector === '[data-inspiration-capture]' ? this.captureAncestor : this.viewport; }
  scrollIntoView(options) { this.scrolled = options; }
  animate(keyframes, options) {
    let resolve, reject;
    const animation = { keyframes, options,
      finished: new Promise((yes, no) => { resolve = yes; reject = no; }),
      complete: () => resolve(), cancel: () => { animation.canceled = true; reject(new Error('Canceled')); },
    };
    this.animations.push(animation);
    return animation;
  }
}
document.createElement = () => new Element({});
const fixture = () => {
  const source = new Element({ left: 500, top: 100, width: 480, height: 260 });
  source.computedStyle = { width: '480px', borderTopLeftRadius: '0px', borderTopRightRadius: '0px', borderBottomRightRadius: '24px', borderBottomLeftRadius: '24px', boxShadow: '1px 0px 0px #fff inset, 4px 18px 24px -12px #0002' };
  source.input = new Element({ height: 196 });
  source.input.computedStyle = { fontSize: '12px', lineHeight: '20px' };
  Object.assign(source.input, { value: 'Small ideas grow.\n让灵感生长。', scrollTop: 12 });
  source.input.parentElement = new Element({});
  source.input.parentElement.computedStyle = { paddingTop: '32px', paddingRight: '32px', paddingBottom: '32px', paddingLeft: '32px' };
  source.setAttribute('data-paper', '1');
  const page = new Element({ left: 80, top: -40, width: 1000, height: 900 });
  page.viewport = new Element({ top: 0, bottom: 600 });
  const target = new Element({ left: 100, top: 500, bottom: 732, width: 300, height: 232 });
  target.computedStyle = { borderTopLeftRadius: '24px', borderTopRightRadius: '24px', borderBottomRightRadius: '24px', borderBottomLeftRadius: '24px', paddingTop: '24px', paddingRight: '24px', paddingBottom: '16px', paddingLeft: '24px' };
  target.bodyNode = new Element({ height: 140 });
  return { source, page, target };
};
const assertClean = ({ source, page, target }) => {
  assert.equal(page.children.length, 0, 'the travelling copy is removed');
  assert.equal(source.style.visibility, '');
  assert.equal(target.style.visibility, '');
  assert.equal(target.style.display, '', 'the saved card participates in layout after landing or interruption');
  assert.equal(target.attributes.has('data-paper-landing'), false);
  assert.equal(window.count() + document.count() + motion.count(), 0, 'no motion listeners survive');
};

{
  const desktop = fixture();
  const flight = prepare(desktop.source, desktop.page, { x: 1200, y: 12 });
  const carrier = desktop.page.children[0];
  const complete = flight.play(null);
  assert.equal(carrier.animations[0].id, 'inspiration-paper-eject');
  assert.ok(!carrier.animations[0].keyframes.at(-1).transform.includes('scale'), 'a desktop sheet exits at its original size');
  carrier.animations[0].complete();
  await new Promise(setImmediate);
  const travel = carrier.animations.at(-1);
  assert.equal(travel.id, 'inspiration-paper-to-tray');
  const last = travel.keyframes.at(-1);
  assert.ok(last.transform.startsWith('translate3d(460px, -218px, 0) scale(0.02'), 'the paper center reaches the actual tray coordinates');
  assert.equal(last.opacity, 0);
  assert.ok(travel.keyframes.every(frame => !('width' in frame) && !('height' in frame)), 'desktop flight scales the printed sheet without layout changes');
  travel.complete(); desktop.source.animations[0].complete();
  await complete; assertClean(desktop);
}

{
  const desktop = fixture();
  const flight = prepare(desktop.source, desktop.page, { x: 1200, y: 12 });
  const carrier = desktop.page.children[0];
  const complete = flight.play(null);
  carrier.animations[0].complete(); await new Promise(setImmediate);
  window.dispatch('resize'); await complete; assertClean(desktop);
}

{
  const nested = fixture();
  nested.source.input.captureAncestor = nested.source.input.parentElement;
  nested.source.input.parentElement = new Element({});
  const flight = prepare(nested.source, nested.page);
  const copied = nested.page.children[0].children[1].input;
  assert.equal(copied.captureAncestor.style.paddingTop, '32px', 'media editors preserve the paper insets when printing');
  assert.equal(copied.parentElement.style.paddingTop, undefined, 'the inner media scroller does not gain a second inset');
  flight.cancel();
  assertClean(nested);
}

{
  const inline = fixture();
  const second = new Element({ height: 40 });
  second.value = '语音后面的文字'; second.computedStyle = { fontSize: '12px', lineHeight: '20px' };
  inline.source.inputs = [inline.source.input, second];
  const flight = prepare(inline.source, inline.page);
  const copied = inline.page.children[0].children[1].inputs;
  second.value = '';
  assert.equal(copied[1].value, '语音后面的文字', 'printing freezes every text segment around inline media');
  assert.equal(copied[1].style.height, '40px');
  assert.equal(copied[1].readOnly, true);
  flight.cancel(); assertClean(inline);
}

const f = fixture();
const flight = prepare(f.source, f.page);
const carrier = f.page.children[0];
const sheet = carrier.children[1];
assert.equal(f.source.style.visibility, 'hidden');
assert.equal(carrier.style.left, '420px');
assert.equal(carrier.style.top, '140px');
f.source.input.value = '';
f.source.setAttribute('data-paper', '2');
assert.equal(sheet.input.value, 'Small ideas grow.\n让灵感生长。', 'clearing the next editor preserves the travelling text');
assert.equal(sheet.attributes.get('data-paper'), '1', 'the travelling sheet retains its saved paper color');
assert.equal(sheet.input.scrollTop, 12);
// Scrolling between capture and layout must not change the page-space landing.
f.page.rect.top -= 40;
f.target.rect.top -= 40;
const finished = flight.play(f.target);
assert.equal(f.target.style.visibility, 'hidden', 'the destination cannot appear before the paper arrives');
assert.equal(f.target.style.display, 'none', 'the list reserves no slot during ejection');
assert.equal(f.source.style.visibility, '');
assert.equal(f.source.animations[0].keyframes[0].transform, 'translateY(-100%)', 'the next sheet starts entirely above its clipping window');
assert.ok(f.source.animations[0].options.delay >= carrier.animations[0].options.duration, 'the next paper only feeds after the saved sheet is ejected');
const feedPositions = f.source.animations[0].keyframes.map(frame => Number(frame.transform.match(/translateY\(([-\d.]+)%\)/)[1]));
assert.ok(Math.max(...feedPositions) > 0 && Math.max(...feedPositions) < 8, 'the next sheet passes its resting position with a small physical recoil');
assert.equal(feedPositions.at(-1), 0, 'the new sheet settles exactly at its input position');
assert.equal(f.target.scrolled, undefined, 'the printer stays in view during ejection');
assert.equal(carrier.attributes.get('data-paper-flight'), 'ejecting');
assert.ok(carrier.animations[0].keyframes.every(frame => /^translate3d\(0, [\d.]+px, 0\)$/.test(frame.transform) && !('width' in frame) && !('height' in frame)),
  'ejection comes straight out of the printer before the sheet travels or resizes');
const cornerFrames = carrier.animations[0].keyframes;
assert.equal(cornerFrames[0].borderTopLeftRadius, '0px', 'the paper leaves the printer with square top corners');
assert.ok(parseFloat(cornerFrames.find(frame => frame.offset === .25).borderTopLeftRadius) > 0,
  'the top corners visibly round during ejection');
assert.ok(cornerFrames.every(frame => frame.borderTopLeftRadius === frame.borderTopRightRadius), 'both top corners round together');
assert.ok(cornerFrames.filter(frame => frame.offset * carrier.animations[0].options.duration >= 120)
  .every(frame => frame.borderTopLeftRadius === '24px'), 'the top corners reach 24px within the first 120ms');
assert.equal(sheet.animations.length, 0, 'the ejected paper does not bend, rotate or scale');
carrier.animations[0].complete();
await new Promise(resolve => setImmediate(resolve));
assert.equal(carrier.attributes.get('data-paper-flight'), 'travelling');
assert.equal(f.target.style.display, '', 'the list makes room only when transfer begins');
assert.equal(f.target.style.visibility, 'hidden');
assert.equal(carrier.animations[1].keyframes[0].transform.replaceAll('px', ''), carrier.animations[0].keyframes.at(-1).transform.replaceAll('px', ''),
  'the free flight begins at the ejected position without a jump');
assert.equal(carrier.animations[1].keyframes.at(-1).transform,
  'translate3d(-400px, 400px, 0)');
assert.equal(carrier.animations[1].keyframes[0].width, '480px');
assert.equal(carrier.animations[1].keyframes[0].height, '260px');
assert.equal(carrier.animations[1].keyframes[0].borderTopLeftRadius, cornerFrames.at(-1).borderTopLeftRadius,
  'transfer continues from the rounded ejection without snapping back to square');
assert.equal(carrier.animations[1].keyframes.at(-1).width, '300px');
assert.equal(carrier.animations[1].keyframes.at(-1).height, '232px');
assert.ok([...carrier.animations[0].keyframes, ...carrier.animations[1].keyframes]
  .every(frame => !/scale|rotate|perspective/.test(frame.transform)), 'text is never transformed along with a scaled paper');
assert.equal(sheet.input.parentElement.animations[0].keyframes.at(-1).paddingLeft, '24px');
assert.equal(sheet.input.animations[0].keyframes.at(-1).height, '140px', 'the text box reflows to the card content dimensions');
assert.ok([...carrier.animations[0].keyframes, ...carrier.animations[1].keyframes]
  .every(frame => !('opacity' in frame)), 'the paper does not fade during ejection or travel');
assert.equal(f.target.scrolled.block, 'nearest');
f.source.animations[0].complete();
sheet.input.parentElement.animations[0].complete();
sheet.input.animations[0].complete();
carrier.animations[1].complete();
await new Promise(resolve => setImmediate(resolve));
assert.equal(f.target.style.visibility, '');
assert.equal(carrier.attributes.get('data-paper-flight'), 'landed');
assert.equal(f.page.children.length, 1, 'the travelling sheet remains until its card has appeared');
f.target.animations[0].complete(); carrier.animations[2].complete();
await finished;
assertClean(f);

{
  const f = fixture();
  const scale = .65;
  f.source.rect.width *= scale; f.source.rect.height *= scale; f.source.input.rect.height *= scale;
  const flight = prepare(f.source, f.page);
  const carrier = f.page.children[0];
  const copy = carrier.children[1].input;
  assert.equal(carrier.style.width, '312px');
  assert.equal(carrier.style.height, '169px');
  assert.equal(carrier.style.borderTopLeftRadius, '0px', 'ejection starts with the square top corners');
  assert.equal(carrier.style.borderTopRightRadius, '0px');
  assert.equal(parseFloat(carrier.style.borderBottomLeftRadius), 24 * scale, 'ejection preserves the rounded bottom corners');
  assert.equal(parseFloat(carrier.style.borderBottomRightRadius), 24 * scale);
  assert.equal(carrier.children[1].style.borderRadius, 'inherit');
  assert.equal(parseFloat(copy.style.fontSize), 12 * scale, 'detaching a zoomed paper preserves its visible text size');
  assert.equal(parseFloat(copy.style.lineHeight), 20 * scale);
  assert.equal(parseFloat(copy.parentElement.style.paddingLeft), 32 * scale, 'the zoomed text does not jump at the start of ejection');
  assert.equal(copy.scrollTop, 12 * scale, 'scrolled drafts retain the same visible lines');
  const finished = flight.play(f.target);
  assert.equal(copy.animations.length, 0, 'text stays unchanged for the entire ejection');
  for (const frame of carrier.animations[0].keyframes.filter(frame => frame.offset >= .5)) {
    assert.equal(parseFloat(frame.borderTopLeftRadius), 24 * scale, 'the quick corner transition respects the printer scale');
    assert.equal(parseFloat(frame.borderTopRightRadius), 24 * scale);
  }
  carrier.animations[0].complete();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(copy.animations[0].keyframes.at(-1).fontSize, '12px', 'transfer returns the text to the list font size');
  assert.equal(copy.animations[0].keyframes.at(-1).lineHeight, '20px');
  assert.equal(carrier.animations[1].keyframes.at(-1).width, '300px');
  assert.equal(parseFloat(carrier.animations[1].keyframes[0].borderTopLeftRadius), 24 * scale);
  for (const property of ['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomRightRadius', 'borderBottomLeftRadius']) {
    assert.equal(carrier.animations[1].keyframes.at(-1)[property], '24px', 'the paper lands with the list corner radius');
  }
  flight.cancel(); await finished; assertClean(f);
}

for (const phase of ['eject', 'travel']) for (const interruption of ['route', 'resize', 'hidden', 'reduced']) {
  const f = fixture();
  const flight = prepare(f.source, f.page);
  const finished = flight.play(f.target);
  if (phase === 'travel') {
    f.page.children[0].animations[0].complete();
    await new Promise(resolve => setImmediate(resolve));
  }
  if (interruption === 'route') flight.cancel();
  if (interruption === 'resize') window.dispatch('resize');
  if (interruption === 'hidden') { document.hidden = true; document.dispatch('visibilitychange'); }
  if (interruption === 'reduced') { motion.matches = true; motion.dispatch('change'); }
  await finished;
  assertClean(f);
  document.hidden = false; motion.matches = false;
}
for (const unavailable of ['hidden', 'reduced', 'unsupported']) {
  const f = fixture();
  if (unavailable === 'hidden') document.hidden = true;
  if (unavailable === 'reduced') motion.matches = true;
  if (unavailable === 'unsupported') f.source.animate = undefined;
  assert.equal(prepare(f.source, f.page), null);
  assertClean(f);
  document.hidden = false; motion.matches = false;
}
const missing = fixture();
await prepare(missing.source, missing.page).play(null);
assertClean(missing);
console.log('PASS Inspiration printer: translation-only ejection without a grid slot, real-size transfer and text reflow, spring feed, preserved text/color, handoff, both-phase interruptions, reduced motion and cleanup');
