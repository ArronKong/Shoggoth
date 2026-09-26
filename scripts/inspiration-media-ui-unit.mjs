import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(root, 'app/manage-ui/package.json'));
const ts = require('typescript'), React = require('react');
const { create, act } = require('react-test-renderer');
const compile = file => ts.transpileModule(fs.readFileSync(path.join(root, 'app/manage-ui/src/pages', file), 'utf8'), {
  fileName: file, compilerOptions: { esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const flush = () => new Promise(setImmediate);
const contentCode = compile('inspiration-content.ts');
const mediaCode = compile('inspiration-media.ts'), editorCode = compile('InspirationMedia.tsx'), previewCode = compile('InspirationMediaPreview.tsx');

async function fixture(options = {}) {
  const state = { attachments: [], busy: false, uploads: [], fail: false, tracksStopped: 0, recorders: [], permission: null, microphoneRequests: 0, mediaRequests: 0, durationDecoders: 0, timers: new Map(), players: [], observers: new Set(), visibilityListeners: new Set(), opened: 0 };
  const document = { hidden: false,
    addEventListener(type, listener) { if (type === 'visibilitychange') state.visibilityListeners.add(listener); },
    removeEventListener(type, listener) { if (type === 'visibilitychange') state.visibilityListeners.delete(listener); },
  };
  const stream = { getTracks: () => [{ stop() { state.tracksStopped++; } }] };
  class Recorder {
    static isTypeSupported(type) { return type === 'audio/webm;codecs=opus'; }
    constructor(_stream, options) { this.mimeType = options.mimeType; this.state = 'inactive'; state.recorders.push(this); }
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      queueMicrotask(() => { this.ondataavailable?.({ data: new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4])]) }); this.onstop?.(); });
    }
  }
  class DurationDecoder {
    constructor() { state.durationDecoders++; }
    async decodeAudioData() { return { duration: 2.05 }; }
  }
  class DeviceContext { constructor() { throw new Error('Passive previews must never open a real audio device'); } }
  const globals = { TextEncoder, File, Blob, Uint8Array, btoa, DOMException, AbortController, document, crypto: { randomUUID },
    ResizeObserver: class { observe() {} disconnect() {} },
    IntersectionObserver: class {
      constructor(callback) { this.callback = callback; }
      observe(target) { this.target = target; state.observers.add(this); }
      disconnect() { state.observers.delete(this); }
    },
    OfflineAudioContext: DurationDecoder, AudioContext: DeviceContext, fetch: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) }),
    window: { openclawDesktop: options.nativePermission === undefined ? undefined : { requestMicrophoneAccess: async () => { state.microphoneRequests++; return options.nativePermission; } },
      OfflineAudioContext: options.decodeDuration ? DurationDecoder : undefined,
      AudioContext: options.decodeDuration ? DeviceContext : undefined,
      matchMedia: () => ({ matches: false }), setInterval(callback) { const key = randomUUID(); state.timers.set(key, callback); return key; }, clearInterval(key) { state.timers.delete(key); } },
    navigator: { mediaDevices: { getUserMedia: () => { state.mediaRequests++; return state.permission || Promise.resolve(stream); } } }, MediaRecorder: Recorder };
  const media = { exports: {} };
  vm.runInNewContext(mediaCode, { ...globals, exports: media.exports, require: name => name === '../api/client' ? {
    writeInspirationMedia: async input => {
      state.uploads.push(input);
      if (state.fail) throw new Error('offline');
      return { attachment: input.attachment, nextOffset: input.offset + Buffer.from(input.content, 'base64').length };
    },
  } : require(name) });
  const preview = { exports: {} }, editor = { exports: {} }, content = { exports: {} };
  const localRequire = name => name === '../components/Field' ? { TextArea: React.forwardRef((props, ref) => React.createElement('textarea', { ...props, ref })) }
    : name === './inspiration-content' ? content.exports : name.endsWith('.css') ? {} : name.endsWith('.svg') ? name
    : name === './InspirationMediaPreview' ? preview.exports
    : name === './inspiration-media' ? media.exports : name === 'react-i18next' ? { useTranslation: () => ({ t: key => key }) } : require(name);
  vm.runInNewContext(contentCode, { ...globals, exports: content.exports, require: localRequire });
  vm.runInNewContext(previewCode, { ...globals, exports: preview.exports, require: localRequire });
  vm.runInNewContext(editorCode, { ...globals, exports: editor.exports, require: localRequire });
  function Wrapper() {
    const [value, setValue] = React.useState({ body: options.body || '', attachments: options.attachments || [] });
    const { body, attachments } = value; state.body = body; state.attachments = attachments;
    if (options.preview) return React.createElement(preview.exports.default, { attachments, compact: options.compact, onOpen: () => { state.opened++; } });
    return React.createElement(editor.exports.default, { body, attachments, capture: options.capture, onChange: setValue, onBusyChange: value => { state.busy = value; } });
  }
  let renderer;
  await act(async () => { renderer = create(React.createElement(Wrapper), { createNodeMock(element) {
    if (element.type === 'div') return { player: state.players.at(-1), clientWidth: 342, scrollHeight: 100, clientHeight: 100, scrollTop: 0, toggleAttribute() {} };
    if (element.type === 'textarea') return { style: {}, scrollHeight: 20, focus() {}, setSelectionRange() {} };
    if (!['audio', 'video'].includes(element.type)) return null;
    const player = { paused: true, currentTime: 0, duration: options.duration ?? 95, plays: 0, pauses: 0, clientWidth: 0,
      async play() { this.paused = false; this.plays++; element.props.onPlay?.(); },
      pause() { this.paused = true; this.pauses++; element.props.onPause?.(); } };
    state.players.push(player); return player;
  } }); await flush(); });
  const button = label => renderer.root.findAllByType('button').find(node => node.props['aria-label'] === label || node.children.includes(label));
  const click = label => act(async () => { button(label).props.onClick(); await flush(); });
  const pick = files => act(async () => { renderer.root.findAllByType('input').find(node => node.props.type === 'file').props.onChange({ target: { files, value: 'chosen' } }); await flush(); });
  const event = kind => renderer.root.findAllByType('div').find(node => typeof node.props[kind] === 'function');
  const intersect = (player, visible, height = 112) => act(async () => {
    [...state.observers].find(observer => observer.target.player === player).callback([{ isIntersecting: visible, intersectionRect: { width: 180, height } }]); await flush();
  });
  const hide = hidden => act(async () => { document.hidden = hidden; state.visibilityListeners.forEach(listener => listener()); await flush(); });
  return { state, renderer, stream, button, click, pick, event, intersect, hide, media: media.exports };
}
{
  const f = await fixture({ capture: true, body: '第一行\n第二行\n第三行' });
  const inputs = () => f.renderer.root.findAllByType('textarea');
  assert.equal(inputs()[0].props.spellCheck, false, 'note text disables browser spelling marks');
  act(() => inputs()[0].props.onSelect({ currentTarget: { selectionEnd: 4 } }));
  await f.click('inspiration.media.record');
  act(() => inputs()[0].props.onSelect({ currentTarget: { selectionEnd: 11 } }));
  await f.click('inspiration.media.stop');
  assert.equal(f.state.attachments[0].textOffset, 4, 'recording stays at its starting caret even when the caret moves');
  assert.deepEqual(inputs().map(input => input.props.value), ['第一行\n', '第二行\n第三行']);
  act(() => inputs()[0].props.onChange({ currentTarget: { value: '新增\n第一行\n', selectionEnd: 7 } }));
  assert.equal(f.state.attachments[0].textOffset, 7, 'editing text before a voice note moves its saved position');
  act(() => inputs()[1].props.onSelect({ currentTarget: { selectionEnd: 4 } }));
  await f.click('inspiration.media.record');
  act(() => inputs()[0].props.onChange({ currentTarget: { value: '第一行\n', selectionEnd: 4 } }));
  await f.click('inspiration.media.stop');
  assert.deepEqual(Array.from(f.state.attachments, item => item.textOffset), [4, 8], 'editing during recording rebases both existing and incoming media');
  assert.deepEqual(inputs().map(input => input.props.value), ['第一行\n', '第二行\n', '第三行']);
  act(() => f.renderer.unmount());
}
{
  const f = await fixture({ body: '前面\n后面' });
  let resolvePermission;
  f.state.permission = new Promise(resolve => { resolvePermission = resolve; });
  act(() => f.renderer.root.findByType('textarea').props.onSelect({ currentTarget: { selectionEnd: 3 } }));
  await f.click('inspiration.media.record');
  act(() => f.renderer.root.findByType('textarea').props.onChange({ currentTarget: { value: '增加\n前面\n后面', selectionEnd: 6 } }));
  await act(async () => { resolvePermission(f.stream); await flush(); });
  f.state.fail = true;
  await f.click('inspiration.media.stop');
  act(() => f.renderer.root.findByType('textarea').props.onChange({ currentTarget: { value: '前面\n后面', selectionEnd: 3 } }));
  f.state.fail = false;
  await f.click('inspiration.media.retry');
  assert.equal(f.state.attachments[0].textOffset, 3, 'permission waits and failed uploads preserve the chosen line through edits');
  act(() => f.renderer.unmount());
}
{
  const samePoint = ['first', 'second'].map(name => ({ id: randomUUID(), name: `${name}.wav`, mimeType: 'audio/wav', size: 80, textOffset: 2 }));
  const f = await fixture({ body: '🌱后文', attachments: samePoint });
  const inputs = () => f.renderer.root.findAllByType('textarea');
  assert.deepEqual(inputs().map(input => input.props.value), ['🌱', '', '后文'], 'positions use native textarea UTF-16 offsets');
  act(() => inputs()[1].props.onChange({ currentTarget: { value: '中间', selectionEnd: 2 } }));
  assert.deepEqual(Array.from(f.state.attachments, item => item.textOffset), [2, 4], 'typing between two recordings at the same offset only moves the later one');
  act(() => inputs()[1].props.onSelect({ currentTarget: { selectionEnd: 2 } }));
  await f.click('inspiration.media.record'); await f.click('inspiration.media.stop');
  assert.equal(f.state.attachments[0].id, samePoint[0].id);
  assert.equal(f.state.attachments[2].id, samePoint[1].id, 'a new recording is inserted before the next recording at the same text position');
  assert.deepEqual(inputs().map(input => input.props.value), ['🌱', '中间', '', '后文']);
  act(() => f.renderer.unmount());
}
{
  const f = await fixture({ duration: Infinity, decodeDuration: true });
  await f.pick([new File(['streaming WebM'], 'recording.webm', { type: 'audio/webm' })]);
  await act(async () => { f.renderer.root.findByType('audio').props.onLoadedMetadata(); await flush(); });
  assert.match(JSON.stringify(f.renderer.toJSON()), /0'02''/);
  assert.equal(f.renderer.root.findAllByType('input').find(node => node.props.type === 'range').props.max, 2.05);
  assert.equal(f.state.durationDecoders, 1, 'streaming audio duration is decoded offline without opening a device');
  act(() => f.renderer.unmount());
}
const png = (size = 12) => new File([Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(size - 8)])], 'test.png', { type: 'image/png' });

{
  const attachments = [
    ['animated.gif', 'image/gif'], ['clip.mp4', 'video/mp4'], ['IMG_1234.HEIC', 'image/heic'], ['IMG_1234.MOV', 'video/quicktime'], ['voice.wav', 'audio/wav'],
  ].map(([name, mimeType]) => ({ id: randomUUID(), name, mimeType, size: 100 }));
  const f = await fixture({ preview: true, compact: true, attachments });
  const [movie, live, audio] = f.state.players;
  assert.equal(f.state.observers.size, 2);
  assert.ok([...f.state.observers].every(observer => observer.target.clientWidth > 0), 'visibility uses the media region even while the poster/video has no intrinsic width');
  assert.equal(movie.plays, 0, 'videos wait until their visible area intersects the viewport');
  assert.equal(live.plays, 0);
  for (const video of f.renderer.root.findAllByType('video')) {
    assert.equal(video.props.muted, true); assert.equal(video.props.loop, true); assert.equal(video.props.controls, undefined);
  }
  assert.equal(f.renderer.root.findAllByType('button').filter(node => node.props['aria-label'] === 'inspiration.media.play').length, 1, 'only audio keeps a list playback button');
  assert.equal(f.button('inspiration.media.playLive'), undefined);
  assert.equal(f.renderer.root.findAllByType('img').filter(node => node.props.alt === 'animated.gif').length, 1, 'GIFs use the native animated image');
  await f.intersect(movie, true); await f.intersect(live, true);
  assert.equal(movie.paused, false); assert.equal(live.paused, false); assert.equal(audio.plays, 0);
  await act(async () => [...f.state.observers].find(observer => observer.target.player === movie).callback([
    { isIntersecting: false, intersectionRect: { width: 0, height: 0 } },
    { isIntersecting: true, intersectionRect: { width: 180, height: 20 } },
  ]));
  assert.equal(movie.paused, false, 'rapid scrolling uses the latest visibility entry');
  await f.intersect(movie, true, 0);
  assert.equal(movie.paused, true, 'clipped media at the edge of a capped card does not keep playing');
  await f.hide(true); assert.equal(live.paused, true);
  await f.hide(false); assert.equal(live.paused, false); assert.equal(movie.paused, true, 'returning to the tab resumes only visible videos');
  await act(async () => f.renderer.root.findAllByType('video')[0].props.onError());
  assert.match(f.renderer.root.findAllByType('video')[0].props.src, /preview=1/);
  await f.intersect(movie, true); assert.equal(movie.paused, false, 'codec fallback also participates in viewport playback');
  await act(async () => f.renderer.root.findAllByType('button').find(node => node.findAllByType('video').some(video => video.props['aria-label'] === 'clip.mp4')).props.onClick());
  assert.equal(f.state.opened, 1, 'clicking the video itself opens its detail');
  const lateObserver = [...f.state.observers].find(observer => observer.target.player === movie);
  act(() => f.renderer.unmount());
  lateObserver.callback([{ isIntersecting: true, intersectionRect: { width: 180, height: 112 } }]);
  assert.equal(movie.paused, true); assert.equal(live.paused, true);
  assert.equal(f.state.observers.size, 0); assert.equal(f.state.visibilityListeners.size, 0);

  const detail = await fixture({ preview: true, attachments: attachments.slice(0, 4) });
  assert.equal(detail.state.observers.size, 0, 'detail media never starts automatically');
  assert.ok(detail.button('inspiration.media.play')); assert.ok(detail.button('inspiration.media.playLive'));
  await detail.click('inspiration.media.play'); assert.equal(detail.state.players[0].paused, false);
  await detail.click('inspiration.media.pause'); assert.equal(detail.state.players[0].paused, true);
  act(() => detail.renderer.unmount());
}
{
  const f = await fixture({ capture: true });
  assert.deepEqual(f.renderer.root.findAllByType('button').map(node => node.props['aria-label']), ['inspiration.media.record']);
  assert.doesNotMatch(JSON.stringify(f.renderer.toJSON()), /inspiration.media.hint/);
  await act(async () => { f.event('onDrop').props.onDrop({ dataTransfer: { files: [png()] }, preventDefault() {} }); await flush(); });
  assert.equal(f.state.attachments.length, 1, 'the minimal toolbar preserves drag and drop input');
  await f.click('inspiration.media.record'); await f.click('inspiration.media.stop');
  assert.equal(f.state.attachments.length, 2); assert.equal(f.state.busy, false);
  act(() => f.renderer.unmount());
}
{
  const f = await fixture();
  await f.pick([png(30 * 1024)]);
  assert.equal(f.state.uploads.length, 2, 'uploads fit the service frame instead of sending one oversized message');
  assert.equal(f.state.attachments.length, 1);
  assert.equal(f.state.busy, false);
  assert.equal(f.renderer.root.findByType('img').props.alt, 'test.png');
  let prevented = false;
  await act(async () => {
    f.event('onPaste').props.onPaste({ clipboardData: { items: [{ kind: 'file', getAsFile: () => png() }] }, preventDefault() { prevented = true; } }); await flush();
  });
  assert.equal(prevented, true); assert.equal(f.state.attachments.length, 2);
  await act(async () => { f.event('onDrop').props.onDrop({ dataTransfer: { files: [png()] }, preventDefault() {} }); await flush(); });
  assert.equal(f.state.attachments.length, 3);
  await f.click('inspiration.media.remove'); assert.equal(f.state.attachments.length, 2);
  await f.pick([new File(['<svg/>'], 'x.svg', { type: 'image/svg+xml' })]);
  assert.equal(f.state.attachments.length, 3);
  assert.equal(f.state.attachments[2].mimeType, 'application/octet-stream', 'unknown types are opaque downloads');
  assert.equal(f.renderer.root.findAllByType('a').find(node => node.props.download === 'x.svg').props.href,
    `/__api/inspirations/media?id=${f.state.attachments[2].id}`);
  act(() => f.renderer.unmount());
}
{
  const f = await fixture({ capture: true, body: 'before\nafter' });
  act(() => f.renderer.root.findByType('textarea').props.onSelect({ currentTarget: { selectionEnd: 7 } }));
  await act(async () => {
    f.event('onPaste').props.onPaste({ clipboardData: { files: [new File(['# 文档'], '说明.md', { type: '' })], items: [] }, preventDefault() {} });
    await flush();
  });
  await f.pick([new File(['document'], 'Plan.docx'), new File(['presentation'], 'Deck.pptx')]);
  assert.equal(f.state.attachments.length, 3);
  assert.equal(f.state.attachments[0].textOffset, 7);
  assert.equal(f.state.attachments[0].mimeType, 'text/markdown');
  assert.equal(f.renderer.root.findAllByType('img').length, 0, 'documents are filename rows, without image previews');
  for (const name of ['说明.md', 'Plan.docx', 'Deck.pptx']) {
    const row = f.renderer.root.findAllByType('a').find(node => node.props.download === name);
    assert.equal(row.findByType('svg').props.strokeWidth, '1');
    assert.ok(row.findAllByType('span').some(node => node.props.title === name));
  }
  const textParts = () => f.renderer.root.findAllByType('textarea');
  assert.equal(textParts().filter(node => node.props['data-file-gap']).length, 2, 'only empty insertion points between documents collapse');
  const gap = textParts()[1];
  act(() => gap.props.onChange({ currentTarget: { value: '中间文字', selectionEnd: 4 } }));
  assert.equal(textParts()[1].props['data-file-gap'], undefined, 'typing between files restores a normal text line');
  assert.equal(f.state.body, 'before\n中间文字after');
  assert.deepEqual(Array.from(f.state.attachments, item => item.textOffset), [7, 11, 11]);
  act(() => textParts()[1].props.onChange({ currentTarget: { value: '', selectionEnd: 0 } }));
  assert.equal(textParts()[1].props['data-file-gap'], true, 'clearing the inserted text restores the compact gap');
  act(() => f.renderer.unmount());
}
{
  const f = await fixture(); f.state.fail = true;
  await f.pick([png()]);
  assert.equal(f.state.busy, true, 'an unsaved file prevents saving or silently navigating away');
  const operation = f.state.uploads[0].attachment.id;
  f.state.fail = false; await f.click('inspiration.media.retry');
  assert.equal(f.state.uploads[1].attachment.id, operation, 'retry uses the same upload identity');
  assert.equal(f.state.attachments.length, 1); assert.equal(f.state.busy, false);
  act(() => f.renderer.unmount());
}
{
  const f = await fixture();
  await f.click('inspiration.media.record');
  assert.equal(f.state.busy, true); assert.equal(f.state.recorders.length, 1);
  await f.click('inspiration.media.stop');
  assert.equal(f.state.attachments[0].mimeType, 'audio/webm');
  assert.ok(f.state.tracksStopped > 0); assert.equal(f.state.timers.size, 0);
  assert.equal(f.renderer.root.findByType('audio').props.controls, undefined, 'playback uses the Figma controls');
  await act(async () => f.renderer.root.findByType('audio').props.onLoadedMetadata());
  assert.match(JSON.stringify(f.renderer.toJSON()), /1'35''/);
  await f.click('inspiration.media.play'); assert.equal(f.state.players[0].paused, false);
  await f.click('inspiration.media.pause'); assert.equal(f.state.players[0].paused, true);
  await act(async () => f.renderer.root.findAllByType('input').find(node => node.props.type === 'range').props.onChange({ target: { value: '30' } }));
  assert.equal(f.state.players[0].currentTime, 30);
  await act(async () => f.renderer.root.findByType('audio').props.onEnded());
  assert.equal(f.state.players[0].currentTime, 0);
  assert.equal(f.state.busy, false);
  await f.click('inspiration.media.record');
  const before = f.state.tracksStopped;
  await act(async () => { f.renderer.unmount(); await flush(); });
  assert.ok(f.state.tracksStopped > before); assert.equal(f.state.timers.size, 0);
  assert.equal(f.state.attachments.length, 1, 'unmount never appends a partial recording');
}
{
  const f = await fixture();
  const { middleEllipsis, normalizeMediaType, formatInspirationMediaTime } = f.media;
  assert.equal(middleEllipsis('short.jpg', 20, s => s.length), 'short.jpg');
  assert.equal(middleEllipsis('Photography-Aurora-Finland.jpg', 17, s => s.length), 'Photogra…land.jpg');
  const unicode = middleEllipsis('冬日❄️与家人👨‍👩‍👧‍👦一起去旅行.jpg', 14, s => [...s].length);
  assert.ok(unicode.endsWith('.jpg')); assert.ok(!unicode.includes('\uFFFD'));
  assert.equal(formatInspirationMediaTime(5450), "1h30'50''");
  assert.equal(normalizeMediaType('', 'IMG_1234.HEIC'), 'image/heic');
  await f.pick([new File(['photo'], 'IMG_1234.HEIC'), new File(['video'], 'IMG_1234.MOV')]);
  assert.equal(f.state.attachments.length, 2);
  assert.equal(f.renderer.root.findAllByProps({ 'data-kind': 'live' }).length, 1);
  assert.match(f.renderer.root.findByType('video').props.src, /preview=1/);
  await f.click('inspiration.media.playLive'); assert.equal(f.state.players[0].plays, 1);
  await f.click('inspiration.media.pause'); assert.equal(f.state.players[0].paused, true);
  await f.click('inspiration.media.remove'); assert.equal(f.state.attachments.length, 0, 'removing a Live Photo removes both resources');
  await f.pick([new File(['GIF89a'], 'animated.gif'), new File(['movie'], 'video.mp4')]);
  assert.equal(f.renderer.root.findAllByProps({ 'data-kind': 'image' }).length, 1);
  assert.equal(f.renderer.root.findAllByProps({ 'data-kind': 'video' }).length, 1);
  await act(async () => f.renderer.root.findByType('video').props.onLoadedMetadata({ currentTarget: { videoWidth: 0, videoHeight: 0 } }));
  assert.equal(f.renderer.root.findAllByProps({ 'data-kind': 'audio' }).length, 1, 'audio-only containers use the audio player regardless of picker MIME');
  act(() => f.renderer.unmount());
}
{
  const f = await fixture();
  f.state.permission = Promise.reject(new DOMException('denied', 'NotAllowedError'));
  await f.click('inspiration.media.record');
  assert.equal(f.state.busy, false); assert.equal(f.state.recorders.length, 0);
  assert.match(JSON.stringify(f.renderer.toJSON()), /inspiration.media.permissionDenied/);
  act(() => f.renderer.unmount());
}
{
  const f = await fixture(); let release;
  f.state.permission = new Promise(resolve => { release = resolve; });
  await f.click('inspiration.media.record');
  assert.equal(f.state.busy, true);
  act(() => f.renderer.unmount());
  await act(async () => { release(f.stream); await flush(); });
  assert.equal(f.state.tracksStopped, 1, 'late microphone grants are released after navigation');
  assert.equal(f.state.recorders.length, 0);
}
for (const nativePermission of [false, true]) {
  const f = await fixture({ nativePermission });
  assert.equal(f.state.microphoneRequests, 0, 'mounting the editor never requests native microphone permission');
  assert.equal(f.state.mediaRequests, 0, 'mounting the editor never starts media capture');
  await f.click('inspiration.media.record');
  assert.equal(f.state.microphoneRequests, 1, 'only the record action requests native permission');
  assert.equal(f.state.mediaRequests, nativePermission ? 1 : 0, 'a denied native request never reaches getUserMedia');
  if (nativePermission) await f.click('inspiration.media.stop');
  else assert.match(JSON.stringify(f.renderer.toJSON()), /inspiration.media.permissionDenied/);
  act(() => f.renderer.unmount());
}
console.log('PASS Inspiration media UI: viewport autoplay, clipped/hidden pause, detail controls, voice-only capture toolbar, file selection, paste, drop, chunk upload, preview, removal, retry identity, recording, playback, explicit native permission and microphone cleanup');
