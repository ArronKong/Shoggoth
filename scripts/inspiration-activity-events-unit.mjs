import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const { WebSocket } = require('ws');
const { startPreview } = require('./shoggoth-inspiration-preview.cjs');

test('the shared activity observer receives real broker events and reads the matching run projection', { timeout: 15000 }, async t => {
  const f = await startPreview(0);
  t.after(() => f.close());
  const store = f.service.inspirationStore;
  const idea = store.list().find(idea => idea.title === '城市散步路线');
  const execution = store.latestExecution(idea.id);
  const sessionKey = `agent:${execution.agentId}:${execution.sessionKey}`;
  let hooks;
  const watch = f.backend.watchSession.bind(f.backend);
  f.backend.watchSession = (key, callbacks, options) => {
    if (key === sessionKey) hooks = callbacks;
    return watch(key, callbacks, options);
  };
  const file = path.resolve('app/manage-ui/src/pages/inspiration-activity-events.ts');
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  // Node's test client supplies the Origin header browsers send automatically.
  const frames = [];
  class BrowserSocket extends WebSocket {
    constructor(url) {
      super(url, { origin: f.url });
      this.on('message', data => { const frame = JSON.parse(data); frames.push({ type: frame.type, event: frame.event, id: frame.id, ok: frame.ok, error: frame.error }); });
      this.on('error', error => frames.push({ error: error.message }));
      this.on('close', code => frames.push({ close: code }));
    }
  }
  vm.runInNewContext(code, { module, exports: module.exports, WebSocket: BrowserSocket, URLSearchParams,
    location: new URL(f.url), setTimeout, clearTimeout });
  let reads = 0, latest;
  const stop = module.exports.watchInspirationActivity(sessionKey, execution.runId, () => {
    void fetch(`${f.url}/__api/inspirations/activity?id=${idea.id}&runId=${execution.runId}`)
      .then(response => response.json()).then(value => { latest = value; reads++; });
  });
  t.after(stop);
  const until = async predicate => {
    const end = Date.now() + 5000;
    while (!predicate()) {
      assert.ok(Date.now() < end, `broker activity notification timed out: ${JSON.stringify({ watching: !!hooks, reads, frames })}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  await until(() => hooks && reads > 0);
  reads = 0;
  const text = 'A newly persisted trajectory event, delivered through the Chat broker';
  const session = f.service.chatSessionStore.getSession(execution.sessionKey);
  f.service.transcriptStore.appendEvent({ id: crypto.randomUUID(), profileId: execution.profileId,
    sessionId: session.id, runId: execution.runId, kind: 'assistant', content: { text } });
  const sentAt = Date.now();
  hooks.delta(text);
  await until(() => reads > 0);
  assert.equal(latest.runId, execution.runId);
  assert.ok(latest.trajectory.parts.some(part => part.text === text));
  assert.ok(Date.now() - sentAt < 1000, 'live events must not wait for the old 2.5-second poll');
});
