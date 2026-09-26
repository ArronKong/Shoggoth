import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(root, 'app/manage-ui/package.json'));
const ts = require('typescript');
const React = require('react');
const { create, act } = require('react-test-renderer');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const host = type => props => React.createElement(type, props, props.children);
const compile = file => ts.transpileModule(fs.readFileSync(path.join(root, 'app/manage-ui/src', file), 'utf8'), {
  fileName: file, compilerOptions: { esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX,
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const pageCode = compile('pages/InspirationPage.tsx') + '\nexports.pickNextPaperTone = require("./inspiration-draft").pickNextPaperTone;';
const cacheCode = compile('lib/usePageCache.ts');
const wallCode = compile('pages/inspiration-wall-pages.ts');
const execution = { exports: {} };
vm.runInNewContext(compile('pages/inspiration-execution.ts'), { exports: execution.exports });
const draftKey = 'shoggoth.inspiration.capture.v1';
const flush = () => new Promise(setImmediate);

async function fixture({ filter = 'saved', reduced = false, initialCount = 0,
  initialDraft = { body: 'Keep this idea.\n留住这一张纸。', paperTone: 1, operationId: randomUUID() } } = {}) {
  const draft = initialDraft;
  const state = { randomValue: 0, randomCalls: 0, contentRenders: 0, failWrite: false, failRead: false, failStart: false, calls: [], starts: [], gestures: [], flights: [], errors: [], successes: [], saved: [],
    agents: ['default', 'specific'].map(id => ({ id, name: id, backendId: 'shoggoth', capabilities: { execute: true } })),
    route: filter, observers: new Set(), holdMore: null, holdStart: null, holdSave: null };
  state.saved = Array.from({ length: initialCount }, (_, index) => ({ id: randomUUID(), body: `Idea ${index}`, title: null,
    revision: 1, status: 'saved', favorite: false, archivedAt: null, acceptedAt: null, latestExecution: null, createdAt: 1, updatedAt: 1 }));
  const storage = new Map(draft ? [[draftKey, JSON.stringify(draft)]] : []);
  const cache = { exports: {} };
  vm.runInNewContext(cacheCode, { exports: cache.exports, require });
  const translation = { t: key => key };
  const toast = { success: value => state.successes.push(value), error: value => state.errors.push(value) };
  const stubs = {
    'react-i18next': { useTranslation: () => translation },
    'react-router-dom': { Link: host('a'), useSearchParams: () => {
      const [params, setParams] = React.useState(() => new URLSearchParams({ filter }));
      state.route = params.get('filter'); return [params, setParams];
    } },
    '../lib/usePageCache': cache.exports,
    '../lib/page-refresh': { useRegisterPageLoading() {}, useRegisterPageRefresh(_path, refresh) { state.refresh = refresh; } },
    '../lib/navigation-guard': { useNavigationGuard() {} },
    '../lib/markdown': { toSanitizedMarkdownHtml: value => value },
    '../lib/inspiration-navigation': {},
    '../components/ui': { useConfirm: () => async () => false, useToast: () => toast },
    '../components/Field': { TextArea: host('textarea'), TextInput: host('input'), Field: host('label'), Select: host('select'), Option: host('option') },
    '../components/PageHead': { PageHead: host('header') },
    '../components/FilterTabs': host('nav'), '../components/SearchCapsule': host('input'), '../components/Modal': host('dialog'),
    './ChatPromptCard': host('aside'), './InspirationActivity': host('section'), './InspirationRunBar': host('section'),
    './InspirationActionIcon': host('i'), './InspirationStatusIcon': { __esModule: true, default: host('i'), inspirationGrowthStage: () => 0 },
    './InspirationAutoGrowth': host('section'), './InspirationAgentChatter': host('aside'),
    './InspirationAgentDock': React.forwardRef((props, ref) => {
      React.useImperativeHandle(ref, () => ({ prepare() {}, targets: () => [], scrollElement: () => null }));
      return React.createElement('aside', { 'data-dock': true, ...props });
    }),
    './inspiration-execution': execution.exports,
    './inspiration-scroll-stages': { attachInspirationScrollStages() {} },
    './inspiration-card-drag': { beginInspirationCardDrag: (_source, _pointer, options) => {
      state.gestures.push(options); options.onActive(true); return () => options.onActive(false);
    } },
    './InspirationArchiveControls': () => null, './InspirationTypewriter': props => React.createElement('div', { ref: props.paperRef, 'data-paper': props.paperTone }, props.children),
    './InspirationCapture': host('section'),
    './InspirationContent': props => { state.contentRenders++; return props.renderText(props.body, 0); },
    './InspirationMedia': { __esModule: true, default: props => React.createElement('div', { ...props, 'data-media-editor': true }, React.createElement('textarea', { ...props.inputProps, value: props.body, disabled: props.disabled, onChange: event => props.onChange(previous => ({ ...previous, body: event.target.value })) })), InspirationMediaPreview: host('aside') },
    './inspiration-paper-motion': { prepareInspirationPaperFlight: () => {
      if (reduced) return null;
      let finish;
      const flight = { finished: new Promise(resolve => { finish = resolve; }),
        play(target) { flight.target = target; return flight.finished; },
        cancel() { flight.canceled = true; finish(); }, finish: () => finish() };
      state.flights.push(flight); return flight;
    } },
    '../api/client': {
      getInspirationAgents: async () => ({ agents: state.agents }),
      startInspiration: async (id, input) => {
        state.starts.push({ id, input });
        if (state.holdStart) await state.holdStart;
        if (state.failStart) throw new Error('Start unavailable');
        return { idea: state.saved.find(idea => idea.id === id) };
      },
      createInspiration: async input => {
        state.calls.push({ ...input });
        if (state.holdSave) await state.holdSave;
        if (state.failWrite) throw new Error('Save unavailable');
        const idea = { ...input, id: state.nextIdeaId ?? randomUUID(), title: null, revision: 1, status: 'saved', favorite: false,
          archivedAt: null, acceptedAt: null, latestExecution: null, createdAt: 1, updatedAt: 1 };
        state.saved.unshift(idea); return { idea };
      },
      listInspirations: async ({ filter, cursor, limit, query }) => {
        if (state.failRead) throw new Error('Refresh unavailable');
        if (filter === 'saved' && cursor && state.holdMore) await state.holdMore;
        const items = ['all', 'saved'].includes(filter) ? state.saved.filter(idea => !query || idea.body.includes(query)) : [];
        const start = Number(cursor || 0), end = start + limit;
        return { items: items.slice(start, end), total: items.length, nextCursor: end < items.length ? String(end) : null, hasMore: end < items.length };
      },
    },
  };
  const wall = { exports: {} };
  const media = { exports: {} };
  vm.runInNewContext(compile('pages/inspiration-media.ts'), { exports: media.exports, TextEncoder, require: name => stubs[name] || require(name) });
  stubs['./inspiration-media'] = media.exports;
  vm.runInNewContext(wallCode, { exports: wall.exports, require: name => stubs[name] || require(name) });
  stubs['./inspiration-wall-pages'] = wall.exports;
  const mod = { exports: {} };
  const globals = { exports: mod.exports, TextEncoder, URLSearchParams, crypto: { randomUUID },
    Math: Object.assign(Object.create(Math), { random: () => { state.randomCalls++; return state.randomValue; } }),
    IntersectionObserver: class {
      constructor(callback) { this.callback = callback; }
      observe() { state.observers.add(this); }
      disconnect() { state.observers.delete(this); }
    },
    require: name => name.endsWith('.css') ? {} : stubs[name] || require(name),
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    window: { setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
      addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: reduced }) },
    document: { hidden: false, addEventListener() {}, removeEventListener() {} },
  };
  const draftModule = { exports: {} };
  vm.runInNewContext(compile('pages/inspiration-draft.ts'), { ...globals, exports: draftModule.exports });
  stubs['./inspiration-draft'] = draftModule.exports;
  vm.runInNewContext(pageCode, globals);
  let renderer;
  await act(async () => {
    renderer = create(React.createElement(mod.exports.default), { unstable_isConcurrent: true,
      createNodeMock: () => ({ querySelector: () => ({ focus() {}, style: {}, scrollHeight: 146 }), closest: () => null }) });
    await flush();
  });
  const input = () => renderer.root.findByType('textarea');
  const cards = () => renderer.root.findAllByType('article');
  const press = async (event = {}) => {
    let prevented = false;
    await act(async () => {
      input().props.onKeyDown({ key: 'Enter', nativeEvent: {}, ...event, preventDefault() { prevented = true; } }); await flush();
    });
    return prevented;
  };
  const submit = () => press();
  const edit = body => act(() => input().props.onChange({ target: { value: body } }));
  const pickup = (index = 0) => act(() => cards()[index].props.onPointerDown({ isPrimary: true, button: 0,
    target: { closest: () => null }, currentTarget: {}, pointerId: 1, clientX: 10, clientY: 10 }));
  const drop = (agent = null) => act(async () => {
    const gesture = state.gestures.at(-1); gesture.onActive(false); gesture.onDrop({ element: {}, agent }); await flush();
  });
  const revealMore = () => act(async () => {
    const observers = [...state.observers];
    for (const observer of observers) { observer.callback([{ isIntersecting: true }]); observer.callback([{ isIntersecting: true }]); }
    await flush();
  });
  return { state, draft, storage, renderer, input, cards, press, submit, edit, revealMore, pickup, drop,
    pickNextPaperTone: mod.exports.pickNextPaperTone };
}

{
  const f = await fixture({ initialCount: 120 });
  while (f.cards().length < 120) await f.revealMore();
  const measurements = [];
  const measure = (name, action) => {
    const renders = f.state.contentRenders;
    const start = performance.now();
    action();
    const result = { name, cardRenders: f.state.contentRenders - renders, elapsedMs: Math.round((performance.now() - start) * 10) / 10 };
    measurements.push(result);
    if (process.env.INSPIRATION_PERF_BASELINE !== '1') assert.equal(result.cardRenders, 0, `${name} must not rerender the saved wall`);
  };
  measure('20 draft edits', () => {
    for (let index = 0; index < 20; index++) f.edit(`Draft ${index}`);
  });
  measure('search field edit', () => act(() => f.renderer.root.findByType('input').props.onChange('Idea')));
  measure('start card drag', () => f.pickup());
  assert.equal(f.state.gestures.length, 1, 'the memoized card still starts its drag');
  assert.equal(JSON.parse(f.storage.get(draftKey)).body, 'Draft 19', 'draft durability remains synchronous');
  assert.equal(f.cards().length, 120, 'all revealed notes remain mounted');
  const replacement = { ...f.state.saved[0], body: 'Updated note after polling', favorite: true };
  f.state.saved[0] = replacement;
  await act(async () => { await f.state.refresh(); await flush(); });
  assert.ok(f.cards()[0].findAllByType('p').some(node => node.children.includes(replacement.body)),
    'polling still renders changed note content, even when its revision is unchanged');
  assert.equal(f.cards()[0].findAllByType('button').find(node => node.props['aria-label'] === 'inspiration.unfavorite')?.props['aria-pressed'], true);
  console.log('Inspiration wall interaction work:', JSON.stringify({ cards: 120, measurements }));
  act(() => f.renderer.unmount());
}

{
  const attachment = { id: randomUUID(), name: 'picture.png', mimeType: 'image/png', size: 48 };
  const f = await fixture({ initialDraft: null, reduced: true });
  const editor = () => f.renderer.root.findByProps({ 'data-media-editor': true });
  act(() => editor().props.onBusyChange(true));
  f.edit('Typing while an image uploads');
  await f.submit(); assert.equal(f.state.calls.length, 0, 'Enter cannot drop an upload still in progress');
  act(() => { editor().props.onChange(previous => ({ ...previous, attachments: [...previous.attachments, attachment] })); editor().props.onBusyChange(false); });
  assert.equal(f.input().props.value, 'Typing while an image uploads', 'finishing an upload preserves the latest text');
  f.edit('');
  const restoredDraft = JSON.parse(f.storage.get(draftKey));
  assert.deepEqual(restoredDraft.attachments, [attachment]);
  act(() => f.renderer.unmount());
  const restored = await fixture({ initialDraft: restoredDraft, reduced: true });
  restored.state.failWrite = true; await restored.submit();
  assert.equal(JSON.parse(restored.storage.get(draftKey)).attachments[0].id, attachment.id);
  restored.state.failWrite = false; await restored.submit();
  assert.equal(restored.state.calls[1].operationId, restoredDraft.operationId, 'a failed save keeps the attachment-only retry identity');
  assert.equal(restored.state.calls[1].body, '');
  assert.equal(restored.state.calls[1].attachments[0].id, attachment.id);
  assert.equal(JSON.parse(restored.storage.get(draftKey)).attachments, undefined, 'a successful save starts a fresh draft');
  act(() => restored.renderer.unmount());
}
{
  const f = await fixture({ initialDraft: null, reduced: true });
  const paper = () => f.renderer.root.findByProps({ 'data-paper': 0 });
  assert.ok(paper(), 'first use starts with the main FCFCFA paper');
  assert.equal(f.state.randomCalls, 0, 'opening a fresh page does not draw a random color');
  for (const randomValue of [0, 1 - Number.EPSILON, 0]) {
    f.state.randomValue = randomValue;
    f.edit('A new idea'); await f.submit();
  }
  assert.deepEqual(f.state.calls.map(call => call.paperTone), [0, 1, 7], 'each saved note keeps the color shown while writing');
  assert.equal(f.state.randomCalls, 3, 'each successful save draws the next color once');
  assert.equal(JSON.parse(f.storage.get(draftKey)).paperTone, 0, 'the main color can be selected again after another color');
  act(() => f.renderer.unmount());
}
{
  const f = await fixture();
  for (let previous = 0; previous < 8; previous++) {
    const counts = Array(8).fill(0);
    // Equal-sized intervals of the random source prove weights without a flaky statistical test.
    const samples = previous === 0 ? 7000 : 8000;
    for (let index = 0; index < samples; index++) {
      f.state.randomValue = (index + 0.5) / samples;
      counts[f.pickNextPaperTone(previous)]++;
    }
    assert.equal(counts[previous], 0, 'the previous color is never eligible');
    for (let tone = 0; tone < 8; tone++) {
      if (tone !== previous) assert.equal(counts[tone], tone === 0 ? 2000 : 1000, 'eligible main paper has exactly twice the weight');
    }
  }
  act(() => f.renderer.unmount());
}
{
  const f = await fixture({ reduced: true });
  f.state.randomValue = 1 - Number.EPSILON;
  await f.submit();
  const nextDraft = JSON.parse(f.storage.get(draftKey));
  assert.equal(nextDraft.paperTone, 7);
  act(() => f.renderer.unmount());
  const restored = await fixture({ initialDraft: nextDraft, reduced: true });
  assert.ok(restored.renderer.root.findByProps({ 'data-paper': 7 }), 'reload restores the next paper, including newly added colors');
  assert.equal(restored.state.randomCalls, 0, 'reload does not reroll a saved draft');
  restored.edit('Continue on the same paper'); await restored.submit();
  assert.equal(restored.state.calls[0].paperTone, 7);
  act(() => restored.renderer.unmount());
}
{
  const initialDraft = { body: 'Legacy draft', operationId: randomUUID() };
  const f = await fixture({ initialDraft, reduced: true });
  f.state.nextIdeaId = '11111111-1111-4111-8111-111111111110';
  await f.submit();
  assert.deepEqual(f.state.calls[0], initialDraft, 'legacy retry payloads keep their exact identity');
  assert.equal(f.cards()[0].props['data-paper'], 1, 'legacy notes retain their original ID-based color');
  assert.notEqual(JSON.parse(f.storage.get(draftKey)).paperTone, f.cards()[0].props['data-paper'], 'the next paper excludes the actual legacy card color');
  act(() => f.renderer.unmount());
}

{
  const f = await fixture({ initialCount: 1, reduced: true });
  const chatter = () => f.renderer.root.findAllByType('aside').find(node => typeof node.props.paused === 'boolean');
  const dock = () => f.renderer.root.findByProps({ 'data-dock': true });
  f.edit('An unfinished next idea');
  assert.equal(chatter().props.paused, true);
  f.pickup();
  assert.equal(chatter().props.paused, true, 'the full Agent dock replaces decorative chatter during dragging');
  assert.equal(dock().props.active, true, 'all Agents are offered even with an unfinished draft');
  assert.equal(f.state.starts.length, 0, 'long press alone never starts an Agent');
  let release;
  f.state.holdStart = new Promise(resolve => { release = resolve; });
  await f.drop(); await f.drop();
  assert.equal(chatter().props.paused, true, 'ending the drag restores the draft pause');
  assert.equal(dock().props.active, false);
  assert.equal(f.state.starts.length, 1, 'a pending handoff cannot be submitted twice');
  assert.equal(f.state.starts[0].input.agentId, 'default');
  assert.equal(f.state.starts[0].input.expectedRevision, 1);
  assert.equal(f.state.starts[0].input.workspace, null);
  await act(async () => { release(); await flush(); });
  f.pickup(); await f.drop(f.state.agents[1]);
  assert.equal(f.state.starts.at(-1).input.agentId, 'specific', 'the avatar target selects its exact Agent');
  act(() => f.renderer.unmount());
}
{
  const f = await fixture({ initialCount: 1 });
  f.pickup(); await f.drop({ ...f.state.agents[1], backendId: 'unavailable' });
  assert.equal(f.state.starts.length, 0, 'an unavailable speaker never falls back to another Agent');
  assert.deepEqual(f.state.errors, ['inspiration.noAgent']);
  f.state.failStart = true;
  f.pickup(); await f.drop();
  f.state.failStart = false;
  f.pickup(); await f.drop();
  assert.equal(f.state.starts[0].input.operationId, f.state.starts[1].input.operationId, 'retrying a failed handoff preserves operation identity');
  act(() => f.renderer.unmount());
}
{
  const f = await fixture({ reduced: true });
  await f.submit();
  assert.equal(f.state.calls.length, 1);
  assert.deepEqual(f.state.successes, [], 'saving an idea does not show a success toast');
  act(() => f.renderer.unmount());
}

{
  const f = await fixture({ initialCount: 45 });
  const ids = () => f.cards().map(card => card.props['data-inspiration-id']);
  const original = ids();
  assert.equal(original.length, 20);
  await f.revealMore();
  assert.equal(f.cards().length, 40, 'reaching the bottom appends the next batch only once');
  assert.deepEqual(ids().slice(0, 20), original, 'loaded cards remain in place');
  await f.revealMore();
  assert.equal(f.cards().length, 45, 'the final partial batch is included');
  assert.equal(new Set(ids()).size, 45, 'no note appears twice');
  assert.equal(f.state.observers.size, 0, 'loading stops when the cursor is exhausted');
  act(() => f.renderer.unmount());
}
{
  const f = await fixture({ initialCount: 45 });
  f.state.failRead = true;
  await f.revealMore();
  assert.equal(f.cards().length, 20, 'failed load-more requests preserve existing notes');
  assert.equal(f.state.observers.size, 0, 'a failed batch does not trigger a request loop');
  f.state.failRead = false;
  const retry = f.renderer.root.findAllByType('button').find(button => button.children.includes('common.refresh'));
  await act(async () => { retry.props.onClick(); await flush(); });
  assert.equal(f.cards().length, 40, 'retry resumes the failed batch without skipping notes');
  act(() => f.renderer.unmount());
}
{
  const f = await fixture({ initialCount: 45 });
  let release;
  f.state.holdMore = new Promise(resolve => { release = resolve; });
  await f.revealMore();
  act(() => f.renderer.root.findByType('nav').props.onChange('favorite'));
  await act(flush);
  assert.equal(f.cards().length, 0);
  await act(async () => { release(); await flush(); });
  assert.equal(f.cards().length, 0, 'late batches cannot leak notes into another filter');
  act(() => f.renderer.unmount());
  assert.equal(f.state.observers.size, 0);
}
{
  const f = await fixture({ reduced: true });
  assert.equal(await f.press({ shiftKey: true }), false, 'Shift + Enter remains a newline');
  assert.equal(await f.press({ nativeEvent: { isComposing: true } }), false, 'Enter confirms IME text without saving');
  assert.equal(await f.press({ nativeEvent: { keyCode: 229 } }), false, 'IME confirmation is preserved when composition state is unavailable');
  assert.equal(await f.press({ repeat: true }), true, 'held Enter neither repeats a save nor inserts a newline');
  assert.equal(f.state.calls.length, 0);
  f.edit(' \n '); await f.submit();
  assert.equal(f.state.calls.length, 0, 'Enter does not save an empty note');
  f.edit('x'.repeat(16 * 1024 + 1)); await f.submit();
  assert.equal(f.state.calls.length, 0, 'Enter respects the note size limit');
  assert.equal(f.input().props['aria-describedby'], 'inspiration-capture-error');
  assert.equal(f.renderer.root.findByProps({ id: 'inspiration-capture-error' }).props.role, 'alert');
  f.edit(f.draft.body);
  assert.equal(await f.press(), true, 'plain Enter saves without inserting a newline');
  assert.equal(f.state.calls.length, 1);
  assert.equal(f.state.calls[0].body, f.draft.body, 'multiline text is saved intact');
  assert.equal(f.cards().length, 1);
  assert.equal(f.input().props.value, '');
  act(() => f.renderer.unmount());
}
{
  const f = await fixture(); f.state.failWrite = true;
  await f.submit();
  assert.equal(f.input().props.value, f.draft.body, 'failed saves leave the text intact');
  assert.deepEqual(JSON.parse(f.storage.get(draftKey)), f.draft, 'failed saves preserve the paper color and retry identity');
  assert.equal(f.state.randomCalls, 0, 'failed saves do not reroll the next paper');
  assert.equal(f.state.flights.length, 0, 'failed saves never detach the sheet');
  assert.equal(f.cards().length, 0);
  f.state.failWrite = false; f.state.failRead = true;
  await f.submit();
  assert.equal(f.state.calls[1].operationId, f.state.calls[0].operationId);
  assert.equal(f.cards().length, 1, 'the POST-confirmed destination exists before animation finishes');
  assert.equal(f.cards()[0].props['data-paper'], 1);
  assert.equal(JSON.parse(f.storage.get(draftKey)).paperTone, 0);
  f.edit('The next idea'); await f.submit();
  assert.equal(f.state.calls.length, 2, 'saving again is guarded until the paper lands');
  await act(async () => { f.state.flights[0].finish(); await flush(); });
  assert.equal(f.cards().length, 1, 'a failed list refresh does not erase the saved card');
  assert.equal(f.input().props.value, 'The next idea', 'finishing an earlier transfer never clears a new draft');
  act(() => f.renderer.unmount());
}
{
  const f = await fixture({ filter: 'active' });
  await f.submit();
  assert.equal(f.cards().length, 1, 'saving from another view inserts the destination into the saved list');
  assert.ok(f.state.flights[0].target);
  act(() => f.renderer.root.findByType('nav').props.onChange('active'));
  await act(flush);
  assert.equal(f.state.flights[0].canceled, true, 'changing filters cancels the in-flight overlay');
  assert.equal(f.cards().length, 0, 'the saved card is not leaked into a different filter');
  act(() => f.renderer.unmount());
}
{
  const f = await fixture({ reduced: true }); await f.submit();
  assert.equal(f.state.flights.length, 0);
  assert.equal(f.cards().length, 1, 'reduced motion still completes the save');
  assert.equal(f.input().props.value, '');
  act(() => f.renderer.unmount());
}
{
  const f = await fixture(); let release;
  f.state.holdSave = new Promise(resolve => { release = resolve; });
  await f.submit();
  const newer = { ...f.draft, body: 'New edit from the desktop printer', operationId: randomUUID() };
  f.storage.set(draftKey, JSON.stringify(newer));
  await act(async () => { release(); await flush(); });
  assert.equal(f.input().props.value, newer.body, 'a delayed save must preserve the other window’s newer draft');
  assert.deepEqual(JSON.parse(f.storage.get(draftKey)), newer);
  assert.equal(f.state.saved[0].body, f.draft.body, 'the submitted snapshot is saved intact');
  act(() => f.renderer.unmount());
}
{
  const longDraft = { body: 'x'.repeat(16 * 1024 + 1), paperTone: 1, operationId: randomUUID() };
  const f = await fixture({ initialDraft: longDraft });
  assert.equal(f.input().props.value, longDraft.body, 'an over-limit draft remains editable after reload or cross-window sync');
  await f.submit(); assert.equal(f.state.calls.length, 0);
  act(() => f.renderer.unmount());
}
console.log('PASS Inspiration capture: eight weighted non-repeating colors, first-use default, draft reload, legacy color, Enter save, Shift + Enter newline, IME and repeat guards, size limit, retry-safe failures, confirmed landing card, refresh failure, cross-window draft preservation, duplicate guard, filter interruption and reduced motion');
