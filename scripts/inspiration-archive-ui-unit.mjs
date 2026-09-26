import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(root, 'app/manage-ui/package.json'));
const React = require('react'), ts = require('typescript'), { create, act } = require('react-test-renderer');
const code = ts.transpileModule(fs.readFileSync(path.join(root, 'app/manage-ui/src/pages/InspirationArchiveControls.tsx'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const flush = () => new Promise(setImmediate);

async function fixture(extra = {}) {
  const state = { busy: false, timers: new Map(), saves: [], messages: [], picks: 0, reducedMotion: false,
    failSave: false, cancelSave: false, deferredSave: null, draft: { body: 'current draft', attachments: [] }, readDraft: null };
  const exports = {}, stubs = {
    'react-i18next': { useTranslation: () => ({ t: key => key }) },
    '../components/ui': { useToast: () => ({ success: message => state.messages.push(message), error: message => state.messages.push(message) }) },
    './InspirationArchiveControls.module.css': {},
    '../assets/inspiration/storage-wordmark.svg': 'storage-wordmark.svg',
    './inspiration-archive': {
      chooseInspirationArchiveDestination: async () => {
        state.picks++;
        return state.cancelSave ? null : async bytes => {
          if (state.failSave) throw new Error('archiveSaveFailed');
          state.saves.push(bytes);
          return state.deferredSave ? await state.deferredSave : true;
        };
      },
      collectInspirationNotes: async draft => { state.readDraft = draft; return [draft]; },
      buildInspirationArchive: async () => new Uint8Array([80, 75, 3, 4]),
    },
  };
  vm.runInNewContext(code, { exports, Error, structuredClone,
    window: { matchMedia: () => ({ matches: state.reducedMotion }), setTimeout(fn, delay) {
      assert.equal(delay, 320); const key = randomUUID(); state.timers.set(key, fn); return key;
    }, clearTimeout(key) { state.timers.delete(key); } },
    require: name => stubs[name] ?? require(name) });
  let renderer, props = { disabled: false, ideaCount: 1082, getDraft: () => state.draft,
    onBusyChange: value => { state.busy = value; }, ...extra };
  await act(async () => { renderer = create(React.createElement(exports.default, props)); });
  const button = () => renderer.root.findByProps({ 'data-inspiration-storage': true });
  const click = (detail = 1) => act(async () => { button().props.onClick({ detail }); await flush(); });
  const eject = () => act(async () => {
    const timers = [...state.timers.values()]; state.timers.clear();
    for (const fn of timers) fn(); await flush();
  });
  const update = changes => act(async () => { props = { ...props, ...changes }; renderer.update(React.createElement(exports.default, props)); await flush(); });
  const isEjected = () => renderer.root.findByProps({ 'data-inspiration-sd-card': true }).props['data-ejected'];
  const unmount = () => act(() => renderer.unmount());
  return { state, renderer, click, button, eject, update, isEjected, unmount };
}

{
  const f = await fixture();
  assert.equal(f.renderer.root.findByProps({ 'data-inspiration-sd-count': 1082 }).children.join(''), '1082');
  await f.click(); await f.click();
  assert.equal(f.state.picks, 0, 'the SD card ejects before the save picker opens');
  assert.equal(f.state.timers.size, 1, 'rapid clicks do not schedule duplicate exports');
  assert.equal(f.state.busy, true); assert.equal(f.button().props.disabled, true);
  for (const type of ['dialog', 'nav', 'input']) assert.equal(f.renderer.root.findAllByType(type).length, 0, 'no intermediate dialog or import controls');
  await f.eject();
  assert.equal(f.state.picks, 1, 'export starts automatically after ejection');
  assert.deepEqual(f.state.readDraft, f.state.draft); assert.notEqual(f.state.readDraft, f.state.draft);
  assert.equal(f.state.saves.length, 1); assert.equal(f.state.busy, false); assert.equal(f.isEjected(), undefined);
  assert.deepEqual(f.state.messages, ['inspiration.storage.exported']); f.unmount();
}
{
  const f = await fixture(); f.state.cancelSave = true;
  await f.click(0); assert.equal(f.state.picks, 0, 'keyboard activation uses the same ejection sequence');
  await f.eject();
  assert.equal(f.state.readDraft, null, 'canceling the picker skips export work');
  assert.equal(f.state.busy, false); assert.equal(f.state.saves.length, 0); assert.equal(f.isEjected(), undefined);
  assert.equal(f.state.messages.length, 0, 'cancel is silent');
  f.state.cancelSave = false; f.state.failSave = true;
  await f.click(); await f.eject();
  assert.deepEqual(f.state.messages, ['inspiration.storage.archiveSaveFailed']);
  assert.equal(f.state.busy, false); assert.equal(f.isEjected(), undefined);
  f.state.failSave = false;
  await f.click(); await f.eject(); assert.equal(f.state.saves.length, 1, 'save errors leave the button ready to retry');
  f.unmount();
}
{
  let handled = 0, finish;
  const f = await fixture({ disabled: true, openRequest: 'export-request', onOpenRequestHandled: () => { handled++; } });
  assert.equal(f.state.picks, 0, 'defer export requests while capture work is in progress');
  f.state.deferredSave = new Promise(resolve => { finish = resolve; });
  await f.update({ disabled: false });
  assert.equal(f.state.picks, 1); assert.equal(f.state.timers.size, 0, 'programmatic exports open the picker directly');
  assert.equal(handled, 1); assert.equal(f.state.busy, true);
  await f.update({ openRequest: 'export-request' }); await f.click();
  assert.equal(f.state.picks, 1, 'rerenders and clicks cannot open another picker during a save');
  await act(async () => { finish(false); await flush(); });
  assert.equal(f.state.messages.length, 0, 'native picker cancellation has no success toast');
  await f.update({ openRequest: 'export-request' }); assert.equal(f.state.picks, 1, 'handled requests are not replayed');
  f.unmount();
}
{
  const f = await fixture(); await f.click(); f.unmount();
  assert.equal(f.state.timers.size, 0); assert.equal(f.state.busy, false); assert.equal(f.state.picks, 0, 'unmounting cancels a pending ejection');
}
{
  const f = await fixture(); f.state.reducedMotion = true;
  await f.click(); assert.equal(f.state.timers.size, 0); assert.equal(f.state.picks, 1); f.unmount();
}
console.log('PASS Inspiration export: SD-to-picker sequence, no import UI, single-flight save, cancellation, retry, programmatic requests, draft preservation and reduced motion');
