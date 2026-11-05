import assert from 'node:assert/strict';
import avatarModule from './helpers/load-agent-avatar.cjs';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(path.resolve('app/manage-ui/package.json'));
const React = require('react');
const { create, act } = require('react-test-renderer');
const ts = require('typescript');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const code = ts.transpileModule(fs.readFileSync('app/manage-ui/src/pages/InspirationAgentDock.tsx', 'utf8'), {
  compilerOptions: { esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const pending = [];
const keyListeners = new Set();
const module = { exports: {} };
vm.runInNewContext(`(function(require,module,exports){${code}\n})(require,module,module.exports)`, {
  module, AbortController, AbortSignal, document: { body: {} },
  window: { addEventListener: (type, listener) => { keyListeners.add(listener); }, removeEventListener: (type, listener) => { keyListeners.delete(listener); } },
  require: name => name.endsWith('.css') ? {} : name === 'react-dom' ? { createPortal: node => node }
    : name === 'react-i18next' ? { useTranslation: () => ({ t: key => key }) }
      : name === '../api/client' ? { getInspirationAgentDock: signal => new Promise((resolve, reject) => pending.push({ resolve, reject, signal })) }
        : name === '../components/AgentAvatar' ? avatarModule : require(name),
});
const Dock = module.exports.default;
const ref = React.createRef();
let renderer;
const view = active => React.createElement(Dock, { ref, active });
const key = agent => JSON.stringify([agent.backendId, agent.id]);
const agent = (id, backendId, executionCount, execute = true) => ({ id, backendId, name: id, backendName: backendId, executionCount,
  capabilities: { execute, reason: execute ? null : 'unsupported' } });
const initial = [agent('same', 'native', 8), agent('same', 'external', 2), agent('unused', 'other', 0, false)];
const entries = () => renderer.root.findAllByProps({ role: 'listitem' });
let scroll;
act(() => { renderer = create(view(false), { createNodeMock: element => {
  if (!element.props['data-inspiration-agent-scroll']) return null;
  scroll = { scrollLeft: 0, querySelectorAll: () => entries().map(node => ({ dataset: { inspirationAgentTarget: node.props['data-inspiration-agent-target'] }, querySelector: () => null })) };
  return scroll;
} }); });
assert.equal(pending.length, 1, 'preload before the first gesture');
assert.equal(renderer.toJSON(), null);
await act(async () => { pending.shift().resolve({ agents: initial }); });
act(() => { ref.current.prepare(); renderer.update(view(true)); });
assert.deepEqual(entries().map(node => node.props['data-inspiration-agent-target']), initial.map(key));
for (const [index, entry] of entries().entries()) {
  assert.ok(entry.props['aria-label'].startsWith(initial[index].name), 'each avatar is announced by its agent name');
  assert.ok(entry.findAll(node => node.type === 'span' && node.children?.[0] === initial[index].name).length > 0,
    'the agent name shows under its avatar');
  assert.equal(entry.findByProps({ role: 'status' }).children[0], 'inspiration.agentDock.dropHint', 'each avatar owns its release hint');
}
assert.deepEqual(Array.from(ref.current.targets(), target => key(target.agent)), initial.slice(0, 2).map(key), 'show disabled Agents without accepting drops');
const refreshed = [agent('same', 'external', 9), initial[0], initial[2]];
await act(async () => { pending.shift().resolve({ agents: refreshed }); });
assert.deepEqual(entries().map(node => node.props['data-inspiration-agent-target']), initial.map(key), 'an in-flight refresh cannot move drop targets');
act(() => { renderer.update(view(false)); });
assert.equal(renderer.toJSON(), null);
assert.equal(ref.current.targets().length, 0, 'canceled gestures leave no hidden targets');
act(() => { renderer.update(view(true)); });
assert.deepEqual(entries().map(node => node.props['data-inspiration-agent-target']), refreshed.map(key), 'new execution history orders the next gesture');
assert.equal(scroll.scrollLeft, 0);
act(() => { ref.current.prepare(); renderer.unmount(); });
const abandoned = pending.shift();
assert.equal(abandoned.signal.aborted, true, 'navigation aborts the roster request');
await act(async () => { abandoned.resolve({ agents: initial }); });

act(() => { renderer = create(view(true)); });
assert.equal(entries().length, 0);
assert.ok(JSON.stringify(renderer.toJSON()).includes('inspiration.agentDock.loading'));
await act(async () => { pending.shift().reject(new Error('Unavailable')); });
assert.ok(JSON.stringify(renderer.toJSON()).includes('inspiration.agentDock.failed'));
act(() => { ref.current.prepare(); });
await act(async () => { pending.shift().resolve({ agents: initial }); });
assert.equal(entries().length, 3, 'a slow first load becomes droppable during the gesture');
act(() => { renderer.unmount(); });

// A card's send button opens the same dock for a click choice: agents become buttons, Escape cancels.
{
  const picks = [];
  let canceled = 0;
  const pick = active => React.createElement(Dock, { ref, active, onPick: value => picks.push(value), onCancel: () => { canceled++; } });
  act(() => { renderer = create(pick(false)); });
  await act(async () => { pending.shift().resolve({ agents: initial }); });
  act(() => { renderer.update(pick(true)); });
  const buttons = renderer.root.findAll(node => node.type === 'button');
  assert.equal(buttons.length, initial.length, 'every agent is a button while picking');
  assert.equal(buttons[2].props.disabled, true, 'an agent that cannot run ideas cannot be picked');
  act(() => { buttons[1].props.onClick(); });
  assert.deepEqual(picks.map(key), [key(initial[1])], 'a click hands the idea to that agent');
  assert.ok(JSON.stringify(renderer.toJSON()).includes('inspiration.agentDock.pickHint'));
  act(() => { for (const listener of keyListeners) listener({ key: 'Escape' }); });
  assert.equal(canceled, 1, 'Escape cancels the choice');
  act(() => { renderer.unmount(); });
  assert.equal(keyListeners.size, 0, 'the Escape listener is removed with the dock');
}
console.log('PASS Agent dock: preload, complete roster, composite identity, visible names, fixed gesture order, refreshed ranking, disabled targets, click picking, failure recovery and cleanup');
