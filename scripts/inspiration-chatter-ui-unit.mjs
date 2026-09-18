import assert from 'node:assert/strict';
import avatarModule from './helpers/load-agent-avatar.cjs';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const root = process.cwd();
const require = createRequire(path.join(root, 'app/manage-ui/package.json'));
const ts = require('typescript');
const React = require('react');
const { create, act } = require('react-test-renderer');
const localizedPresets = ['zh-CN', 'en'].map(locale => {
  const source = fs.readFileSync(path.join(root, `app/manage-ui/src/i18n/locales/${locale}.ts`), 'utf8');
  const lines = JSON.parse(source.match(/"chatter":\s*\{[\s\S]*?"lines":\s*(\[[\s\S]*?\])/)[1]);
  assert.equal(lines.length, 20, `${locale} has all 20 presets`);
  assert.equal(new Set(lines).size, 20, `${locale} has no duplicate presets`);
  return { locale, lines };
});
let presetLines = localizedPresets[0].lines;
let randomValue = 0;
const file = path.join(root, 'app/manage-ui/src/pages/InspirationAgentChatter.tsx');
const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), { fileName: file, compilerOptions: {
  esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} }).outputText;
let now = 0;
let serial = 0;
const timers = new Map();
const events = new Map();
const document = { hidden: false, body: {}, addEventListener: (name, handler) => events.set(name, handler), removeEventListener: name => events.delete(name) };
const agents = ['a', 'b'].map(id => ({ id, backendId: 'shoggoth', name: id }));
let roster = agents;
let read = async () => ({ agents: roster });
const mod = { exports: {} };
vm.runInNewContext(`(function(require, module, exports) { ${compiled}\n})(require, module, module.exports);`, {
  require: name => name.endsWith('.css') ? {} : name === 'react-dom' ? { createPortal: node => node }
    : name === 'react-i18next' ? { useTranslation: () => ({ t: (key, options) => options?.returnObjects ? presetLines
      : key.startsWith('inspiration.chatter.lines.') ? presetLines[Number(key.split('.').at(-1))] : key }) }
      : name === '../api/client' ? { getIdleInspirationAgents: () => read() }
        : name === '../components/AgentAvatar' ? avatarModule : require(name),
  module: mod, document, AbortController, AbortSignal,
  Math: Object.assign(Object.create(Math), { random: () => randomValue }),
  window: { setTimeout: (callback, delay) => { const id = ++serial; timers.set(id, { at: now + delay, callback }); return id; },
    clearTimeout: id => timers.delete(id) },
});
const Chatter = mod.exports.default;
const advance = async ms => {
  const target = now + ms;
  while (true) {
    const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
    if (!next) break;
    now = next[1].at; timers.delete(next[0]);
    await act(async () => { await next[1].callback(); });
  }
  now = target;
};
let renderer;
act(() => { renderer = create(React.createElement(Chatter)); });
const bubbles = () => renderer.root.findAllByType('aside');
await advance(2500);
assert.equal(bubbles().length, 1);
assert.equal(bubbles()[0].props['data-agent'], '["shoggoth","a"]');
await advance(9999);
assert.equal(bubbles()[0].props['data-leaving'], undefined);
assert.equal(bubbles()[0].findAllByType('img').length, 1, 'the avatar stays visible with the message');
assert.equal(bubbles()[0].findAllByProps({ 'data-inspiration-chatter-bubble': true }).length, 1);
await advance(1);
assert.equal(bubbles()[0].props['data-leaving'], true, 'avatar and message start leaving together after 10 seconds');
await advance(219);
assert.equal(bubbles()[0].findAllByType('img').length, 1, 'the avatar remains in the shared exit animation');
assert.equal(bubbles()[0].findAllByProps({ 'data-inspiration-chatter-bubble': true }).length, 1,
  'the message remains with the avatar until the shared exit finishes');
await advance(1);
assert.equal(bubbles().length, 0, 'avatar and message are removed together');
assert.equal(renderer.root.findAllByType('img').length, 0);
assert.equal(renderer.root.findAllByProps({ 'data-inspiration-chatter-bubble': true }).length, 0);
await advance(11999);
assert.equal(bubbles().length, 0);
await advance(1);
assert.equal(bubbles().length, 1);
assert.equal(bubbles()[0].props['data-agent'], '["shoggoth","b"]');
roster = [agents[0]];
await advance(3000);
assert.equal(bubbles()[0].props['data-leaving'], true, 'busy speaker withdraws');
await advance(220);
assert.equal(bubbles().length, 0);
act(() => { document.hidden = true; events.get('visibilitychange')(); });
assert.equal(timers.size, 0);
act(() => { document.hidden = false; events.get('visibilitychange')(); });
await advance(3000);
act(() => { renderer.root.findByType('button').props.onClick(); });
await advance(220 + 59999);
assert.equal(bubbles().length, 0);
await advance(1);
assert.equal(bubbles().length, 1);
act(() => { renderer.update(React.createElement(Chatter, { paused: true })); });
assert.equal(bubbles().length, 0, 'drag dock or detail dialog pauses chatter');
assert.equal(timers.size, 0, 'pausing cancels chatter timers');
let resolve;
read = () => new Promise(done => { resolve = done; });
act(() => { renderer.update(React.createElement(Chatter)); });
await advance(2500);
act(() => { document.hidden = true; events.get('visibilitychange')(); document.hidden = false; events.get('visibilitychange')(); });
await act(async () => { resolve({ agents }); });
assert.equal(bubbles().length, 0, 'late visibility response cannot revive a greeting');
assert.equal(timers.size, 1, 'only one next speaker is scheduled');
act(() => { renderer.unmount(); });
assert.equal(timers.size, 0, 'leaving the inspiration route cancels all timers');
assert.equal(events.size, 0);

read = async () => ({ agents });
for (const { locale, lines } of localizedPresets) {
  presetLines = lines; randomValue = 0;
  act(() => { renderer = create(React.createElement(Chatter)); });
  await advance(2500);
  const message = () => renderer.root.findByType('p').children.join('');
  const seen = new Set([message()]);
  assert.equal(message(), lines[0]);
  for (let index = 1; index < lines.length; index++) {
    const candidates = lines.map((_, i) => i).filter(i => i !== index - 1);
    randomValue = (candidates.indexOf(index) + .5) / candidates.length;
    act(() => { renderer.root.findByType('button').props.onClick(); });
    await advance(60220);
    assert.equal(message(), lines[index], `${locale} preset ${index + 1} can appear`);
    seen.add(message());
  }
  assert.equal(seen.size, 20, `${locale} rotates through the complete preset pool`);
  randomValue = .999999;
  act(() => { renderer.root.findByType('button').props.onClick(); });
  await advance(60220);
  assert.notEqual(message(), lines[19], 'the last displayed line is excluded from the next random draw');
  act(() => { renderer.unmount(); });
  assert.equal(timers.size, 0); assert.equal(events.size, 0);
}
console.log('PASS Inspiration chatter: all 20 presets in both languages, no consecutive repeat, synchronized 10-second avatar and message dismissal, dock pause, busy withdrawal and cleanup');
