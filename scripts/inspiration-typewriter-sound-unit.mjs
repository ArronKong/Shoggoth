import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../app/manage-ui/package.json', import.meta.url));
const ts = require('typescript');
const code = ts.transpileModule(fs.readFileSync(new URL('../app/manage-ui/src/pages/inspiration-typewriter-sound.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture({ decodeGate, resumeGate, fetchError = false, duration = 40, desktop } = {}) {
  const contexts = [], sources = [], listeners = new Map(), requests = [];
  const randomOffsets = [.1, .7, .4];
  class AudioContext {
    state = 'suspended'; destination = {}; closed = false; decodeCalls = 0;
    constructor() { contexts.push(this); }
    async decodeAudioData() { this.decodeCalls++; return decodeGate ? decodeGate.promise : { duration }; }
    async resume() { if (resumeGate) await resumeGate.promise; this.state = 'running'; }
    async suspend() { this.state = 'suspended'; }
    async close() { this.state = 'closed'; this.closed = true; }
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
    createBufferSource() {
      const source = { started: false, stopped: false, disconnected: false, loop: false, playbackRate: { value: 1 },
        connect() {}, disconnect() { this.disconnected = true; },
        start(when, offset) { this.started = true; this.when = when; this.offset = offset; }, stop() { this.stopped = true; } };
      sources.push(source); return source;
    }
  }
  const mod = { exports: {} };
  vm.runInNewContext(code, {
    exports: mod.exports, AudioContext, window: { AudioContext, openclawDesktop: desktop }, AbortController,
    Math: Object.assign(Object.create(Math), { random: () => randomOffsets.shift() ?? .5 }),
    document: {
      addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(listener); },
      removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    },
    async fetch(url, options) {
      requests.push({ url, ...options });
      if (fetchError) throw new Error('Unavailable');
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(4) };
    },
  });
  const player = mod.exports.createTypewriterSound();
  return { player, contexts, sources, requests, listeners,
    gesture: type => listeners.get(type)?.forEach(listener => listener()) };
}

for (const status of ['not-determined', 'denied', 'restricted', 'unknown']) {
  let current = status, checks = 0, prompts = 0;
  const f = fixture({ desktop: {
    async getMicrophoneAccessStatus() { checks++; return current; },
    async requestMicrophoneAccess() { prompts++; return true; },
  } });
  f.player.setTyping(true); await flush();
  f.gesture('pointerdown'); f.gesture('keydown'); await flush();
  assert.ok(checks > 0);
  assert.equal(f.contexts.length, 0, 'unapproved ambient sound never opens a duplex audio device');
  assert.equal(f.requests.length, 0);
  assert.equal(prompts, 0, 'entering, typing and clicking on the page cannot request recording permission');
  current = 'granted';
  f.gesture('pointerdown'); await flush();
  assert.equal(f.sources.length, 1, 'sound resumes after a separate recording action grants access');
  f.player.dispose();
}
{
  const gate = deferred(), f = fixture({ desktop: { getMicrophoneAccessStatus: () => gate.promise } });
  f.player.setTyping(true); f.player.dispose(); gate.resolve('granted'); await flush();
  assert.equal(f.contexts.length, 0, 'a late status response cannot open audio after navigation');
}
{
  const f = fixture({ desktop: { getMicrophoneAccessStatus: async () => { throw new Error('IPC unavailable'); } } });
  f.player.setTyping(true); await flush();
  assert.equal(f.contexts.length, 0, 'a failed native status check leaves the optional effect silent');
  f.player.dispose();
}

{
  const f = fixture();
  assert.equal(f.requests.length, 0, 'no audio is fetched before screen typing starts');
  f.player.setTyping(true); await flush();
  assert.equal(f.sources.length, 1); assert.equal(f.sources[0].started, true); assert.equal(f.sources[0].loop, true);
  assert.equal(f.sources[0].playbackRate.value, 2.5, 'the audio plays at 2.5 times its original speed');
  assert.equal(f.sources[0].when, 0, 'randomizing the excerpt does not delay screen typing audio');
  assert.equal(f.sources[0].offset, 2);
  assert.equal(f.requests[0].url, '/audio/typewriter-loop.wav');
  f.player.setTyping(true); f.gesture('pointerdown'); await flush();
  assert.equal(f.sources.length, 1, 'each additional character or gesture cannot layer another loop');
  f.player.setTyping(false); await flush();
  assert.equal(f.sources[0].stopped, true); assert.equal(f.sources[0].disconnected, true);
  assert.equal(f.contexts[0].state, 'suspended', 'silent holds suspend the audio context');
  f.player.setTyping(true); await flush();
  assert.equal(f.sources.length, 2);
  assert.equal(f.sources[1].playbackRate.value, 2.5);
  assert.equal(f.sources[1].offset, 14, 'each new typing burst draws a fresh start position within the first 20 seconds');
  assert.equal(f.requests.length, 1); assert.equal(f.contexts[0].decodeCalls, 1, 'the next phrase reuses decoded audio');
  f.player.dispose(); await flush();
  assert.ok(f.sources.every(source => source.stopped)); assert.equal(f.contexts[0].closed, true);
  assert.equal(f.requests[0].signal.aborted, true);
  assert.ok([...f.listeners.values()].every(listeners => listeners.size === 0));
  f.player.setTyping(true); f.player.dispose(); await flush();
  assert.equal(f.sources.length, 2, 'a disposed player stays silent');
}
{
  const f = fixture({ duration: 8 });
  f.player.setTyping(true); await flush();
  assert.equal(f.sources[0].offset, .8, 'short recordings cap the random range at their actual duration');
  f.player.dispose();
}
{
  const gate = deferred(), f = fixture({ decodeGate: gate });
  f.player.setTyping(true); await flush();
  f.player.setTyping(false); gate.resolve({ duration: 40 }); await flush();
  assert.equal(f.sources.length, 0, 'collapsing during decode cannot play a late sound');
  f.player.setTyping(true); await flush();
  assert.equal(f.sources.length, 1, 'expansion can use the buffer decoded while silent');
  f.player.dispose();
}
{
  const gate = deferred(), f = fixture({ resumeGate: gate });
  f.player.setTyping(true); await flush();
  f.gesture('keydown'); await flush();
  f.player.setTyping(false); gate.resolve(); await flush();
  assert.equal(f.sources.length, 0, 'pending autoplay or gesture resume cannot escape a later stop');
  f.player.dispose();
}
{
  const gate = deferred(), f = fixture({ decodeGate: gate });
  f.player.setTyping(true); await flush(); f.player.dispose();
  gate.resolve({ duration: 40 }); await flush();
  assert.equal(f.sources.length, 0, 'leaving while loading never starts sound after unmount');
  assert.equal(f.contexts[0].closed, true);
}
{
  const f = fixture({ fetchError: true });
  f.player.setTyping(true); await flush();
  assert.equal(f.sources.length, 0, 'asset failures are contained');
  f.player.dispose();
}
console.log('PASS Inspiration typing audio: no device or permission request before native authorization, 2.5x speed, random excerpt per burst, loop cadence, buffer reuse, no overlap, collapse/load/resume races, autoplay gestures, unmount cleanup and asset failures');
