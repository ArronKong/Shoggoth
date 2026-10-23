import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(root, 'app/manage-ui/package.json'));
const ts = require('typescript');
const React = require('react');
const { create, act } = require('react-test-renderer');
const file = path.join(root, 'app/manage-ui/src/pages/InspirationTypewriter.tsx');
const compile = file => ts.transpileModule(fs.readFileSync(file, 'utf8'), { fileName: file, compilerOptions: {
  esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} }).outputText;
const compiled = compile(file);
const corpus = { exports: {} };
vm.runInNewContext(compile(path.join(path.dirname(file), 'inspiration-slogans.ts')), { exports: corpus.exports });
const { inspirationSlogans } = corpus.exports;
let now = 0;
let serial = 0;
let locale = 'zh-CN';
let randomValue = 0;
let randomCalls = 0;
const timers = new Map();
const visibilityListeners = new Set();
const motionListeners = new Set();
const resizeListeners = new Set();
const resizeFrames = new Map();
const viewportProperties = new Map();
const soundPlayers = [];
const soundPlaying = () => soundPlayers.some(player => player.typing && !player.disposed);
let viewportWidth = 680;
const printerNode = {};
const measureNode = { getBoundingClientRect: () => ({ width: viewportWidth }) };
const viewportNode = { firstElementChild: printerNode, getBoundingClientRect: () => ({ width: viewportWidth }),
  style: { getPropertyValue: name => viewportProperties.get(name), setProperty: (name, value) => viewportProperties.set(name, value) } };
const motion = { matches: false, addEventListener: (_, listener) => motionListeners.add(listener),
  removeEventListener: (_, listener) => motionListeners.delete(listener) };
const document = { hidden: false, addEventListener: (_, listener) => visibilityListeners.add(listener),
  removeEventListener: (_, listener) => visibilityListeners.delete(listener) };
const mod = { exports: {} };
vm.runInNewContext(`(function(require, module, exports) { ${compiled}\n})(require, module, module.exports);`, {
  require: name => name.endsWith('.css') ? new Proxy({}, { get: (_, key) => key })
    : name.endsWith('.svg') ? 'wordmark.svg'
      : name === './inspiration-slogans' ? corpus.exports
        : name === './inspiration-typewriter-sound' ? { createTypewriterSound() {
          const player = { typing: false, disposed: false, setTyping(value) { this.typing = value; }, dispose() { this.disposed = true; this.typing = false; } };
          soundPlayers.push(player); return player;
        } }
        : name === 'react-i18next' ? { useTranslation: () => ({ t: key => key, i18n: { resolvedLanguage: locale, language: locale } }) }
          : require(name),
  module: mod, document,
  getComputedStyle: () => ({ width: '680px' }),
  ResizeObserver: class {
    constructor(callback) { this.callback = callback; }
    observe(element) { assert.equal(element, measureNode); resizeListeners.add(this.callback); }
    disconnect() { resizeListeners.delete(this.callback); }
  },
  Math: Object.assign(Object.create(Math), { random: () => { randomCalls++; return randomValue; } }),
  window: { matchMedia: () => motion,
    requestAnimationFrame: callback => { const id = ++serial; resizeFrames.set(id, callback); return id; },
    cancelAnimationFrame: id => resizeFrames.delete(id),
    setTimeout: (callback, delay) => { const id = ++serial; timers.set(id, { at: now + delay, callback }); return id; },
    clearTimeout: id => timers.delete(id) },
});
const Typewriter = mod.exports.default;
const advance = async ms => {
  const target = now + ms;
  for (;;) {
    const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
    if (!next) break;
    now = next[1].at; timers.delete(next[0]);
    await act(async () => { next[1].callback(); });
  }
  now = target;
};
let renderer;
let props = { children: React.createElement('textarea', { value: '' }), saving: false, paperTone: 0, ideaCount: 15 };
act(() => { renderer = create(React.createElement(Typewriter, props), {
  createNodeMock: element => 'data-printer-viewport' in element.props ? viewportNode : element.type === 'span' ? measureNode : null,
}); });
for (const width of [800, 680, 620, 400, 340, 680]) {
  viewportWidth = width;
  act(() => resizeListeners.forEach(listener => listener()));
  act(() => { const frames = [...resizeFrames.values()]; resizeFrames.clear(); frames.forEach(callback => callback()); });
  assert.equal(Number(viewportProperties.get('--printer-scale')), Math.min(1, width / 680), 'the entire printer scales continuously below its design width and never grows above it');
}
const prompt = () => renderer.root.findAll(node => 'data-typewriter-prompt' in node.props)[0];
const displayedPrompt = () => prompt()?.children.join('');
const shownCount = value => renderer.root.findByProps({ 'data-inspiration-count': value }).children[0];
// Run the next timers until the screen reaches a state, within a time budget.
const advanceUntil = async (condition, budget) => {
  const deadline = now + budget;
  while (!condition()) {
    const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
    assert.ok(next && next[1].at <= deadline, 'the screen reaches its next state in time');
    await advance(next[1].at - now);
  }
};
// Type the rest of a sentence key by key and return the gaps between keys.
const typeOut = async text => {
  const gaps = [];
  while (displayedPrompt() !== text) {
    const typed = Array.from(displayedPrompt()).length, started = now;
    await advanceUntil(() => Array.from(displayedPrompt()).length > typed, 300);
    gaps.push(now - started);
  }
  return gaps;
};
const update = changes => act(() => { props = { ...props, ...changes }; renderer.update(React.createElement(Typewriter, props)); });
const first = inspirationSlogans[0];
const last = inspirationSlogans.at(-1);
assert.equal(displayedPrompt(), '');
assert.equal(soundPlaying(), false, 'the lead-in is silent');
assert.equal(renderer.root.findByProps({ 'data-inspiration-count': 15 }).props.lang, 'zh-CN');
await advance(300);
assert.equal(displayedPrompt(), Array.from(first[locale])[0]);
assert.equal(soundPlaying(), true, 'the first screen character starts the loop');
assert.equal(prompt().props['data-phase'], 'typing', 'the caret and lamp hold steady while keys land');
await advanceUntil(() => Array.from(displayedPrompt()).length === 2, 300);
update({ paperTone: 1 });
assert.equal(displayedPrompt(), Array.from(first[locale]).slice(0, 2).join(''), 'parent refreshes do not restart typing');
assert.equal(randomCalls, 1, 'parent refreshes do not select a different phrase');
const gaps = await typeOut(first[locale]);
assert.ok(new Set(gaps).size > 2 && gaps.every(gap => gap >= 70 && gap <= 290), 'keys land at a varied, human pace');
assert.equal(randomCalls, 1, 'the typing rhythm does not consume slogan randomness');
await advance(1999);
assert.equal(soundPlaying(), false, 'the completed sentence holds in silence');
assert.equal(displayedPrompt(), first[locale], 'the complete sentence stays for two seconds');
randomValue = 1 - Number.EPSILON;
await advanceUntil(() => prompt().props['data-phase'] === 'leaving', 400);
assert.equal(displayedPrompt(), first[locale], 'the finished sentence fades out before it clears');
await advanceUntil(() => displayedPrompt() === '', 200);
await advance(300);
assert.equal(displayedPrompt(), Array.from(last[locale])[0], 'the next cycle starts a randomly selected phrase');
await typeOut(last[locale]);
assert.equal(displayedPrompt(), last[locale], 'the random pool includes the end of the extracted corpus');

locale = 'en';
update({});
assert.equal(renderer.root.findByProps({ 'data-inspiration-count': 15 }).props.lang, 'en', 'the count follows live language changes independently of the draft');
assert.equal(displayedPrompt(), '', 'a locale change starts the translation cleanly');
await advance(300); await typeOut(last.en);
assert.equal(displayedPrompt(), last.en, 'changing language keeps the corresponding phrase');
assert.equal(randomCalls, 2, 'locale changes do not choose an unrelated slogan');

// The last English phrase also occurs earlier in the corpus. This draw would
// repeat its visible text if selection excluded only the previous pair's index.
const duplicate = inspirationSlogans.findIndex(slogan => slogan.en === last.en);
assert.notEqual(duplicate, inspirationSlogans.length - 1);
randomValue = (duplicate + 0.5) / (inspirationSlogans.length - 1);
await advanceUntil(() => displayedPrompt() === '', 2600);
const nextEnglish = inspirationSlogans[duplicate - 1].en;
await advance(300); await typeOut(nextEnglish);
assert.equal(displayedPrompt(), nextEnglish);
assert.notEqual(displayedPrompt(), last.en, 'duplicate English translations cannot appear consecutively');

update({ children: React.createElement('textarea', { value: '用户正在输入的内容' }) });
assert.equal(displayedPrompt(), nextEnglish, 'editing a note never replaces the screen slogan with the draft');
assert.equal(timers.size, 1, 'typing in the note leaves the decorative loop running');
assert.equal(shownCount(15).children.join(''), '15', 'the count is independent of draft length');
assert.equal(shownCount(15).props['data-tick'], undefined, 'the first count appears without rolling');
update({ saving: true });
assert.equal(timers.size, 0);
assert.equal(soundPlaying(), false, 'saving stops the decorative typing sound');
locale = 'zh-CN';
randomValue = 0;
update({ children: React.createElement('textarea', { value: '' }), saving: false, ideaCount: 16 });
assert.equal(shownCount(16).children.join(''), '16');
assert.equal(shownCount(16).props['data-tick'], '', 'a newly saved note rolls the counter up');
await advance(300);
assert.equal(soundPlaying(), true);
update({ active: false });
assert.equal(soundPlaying(), false, 'collapsing the typewriter stops sound immediately');
assert.equal(timers.size, 0, 'the collapsed screen does not keep typing offscreen');
update({ active: true });
await advance(300);
assert.equal(soundPlaying(), true, 'expanding resumes sound with screen typing');

act(() => { document.hidden = true; visibilityListeners.forEach(listener => listener()); });
assert.equal(timers.size, 0, 'hidden pages stop the loop');
assert.equal(soundPlaying(), false, 'backgrounding the page stops sound');
act(() => { document.hidden = false; visibilityListeners.forEach(listener => listener()); });
await advance(300);
assert.equal(displayedPrompt(), Array.from(first[locale])[0]);
act(() => { motion.matches = true; motionListeners.forEach(listener => listener()); });
assert.equal(displayedPrompt(), first[locale]);
assert.equal(timers.size, 0, 'reduced motion shows the full sentence without a timer');
assert.equal(soundPlaying(), false, 'static reduced-motion text does not make typing sounds');
locale = 'en';
update({});
assert.equal(displayedPrompt(), first.en, 'reduced motion still follows the selected language');
assert.equal(timers.size, 0);
act(() => { motion.matches = false; motionListeners.forEach(listener => listener()); });
await advance(300); await typeOut(first.en);
assert.equal(displayedPrompt(), first.en);
await advanceUntil(() => soundPlaying(), 2800);
act(() => renderer.unmount());
assert.equal(timers.size, 0, 'leaving the route cancels the loop');
assert.equal(soundPlaying(), false, 'leaving the route during typing stops sound');
assert.ok(soundPlayers.every(player => player.disposed), 'unmount releases every sound player');
assert.equal(visibilityListeners.size, 0);
assert.equal(motionListeners.size, 0);
assert.equal(resizeListeners.size, 0, 'leaving the route stops observing printer size');
assert.equal(resizeFrames.size, 0, 'leaving the route cancels pending scale updates');
console.log('PASS Inspiration typewriter: proportional responsive scaling, random bilingual corpus, sequential human-paced typing, two-second hold and fade, rolling count, no consecutive duplicates, stable locale/refresh behavior, independent note input, recorded count, visibility, reduced motion and cleanup');
