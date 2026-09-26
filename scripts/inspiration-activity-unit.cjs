"use strict";
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { selectExecutionMessages, activityParts, executionArtifacts, loadInspirationActivity } = require('../app/core/inspiration-activity');
const now = Date.now();
const execution = { ideaId: 'idea-1', runId: 'run-1', createdAt: now - 1000, finishedAt: null };
test('same prompt in successive rounds requires the current run or a local timestamp boundary', () => {
  const messages = [{ role: 'user', content: 'prompt', timestamp: now - 3000 }, { role: 'assistant', content: 'old' },
    { role: 'user', content: 'prompt', timestamp: now }, { role: 'assistant', content: 'new' },
    { role: 'user', content: 'later task', timestamp: now + 1000 }, { role: 'assistant', content: 'unrelated' }];
  assert.deepEqual(selectExecutionMessages(messages, execution, 'prompt', false, true).messages, messages.slice(2, 4));
  assert.equal(selectExecutionMessages(messages.slice(0, 2), execution, 'prompt', false, true).supported, false);
  assert.equal(selectExecutionMessages(messages, execution, 'prompt', false, false).supported, false);
  assert.deepEqual(selectExecutionMessages([{ role: 'assistant', runId: 'run-1', content: 'exact' }, { runId: 'run-2' }], execution, '', false, false).messages.length, 1);
});
test('projection keeps tool identities, nested results, errors, and recent bounded progress', () => {
  const round = selectExecutionMessages([
    { role: 'user', timestamp: execution.createdAt, content: 'current prompt' },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'done' }] },
    { role: 'assistant', content: 'continued progress' }, { role: 'user', content: 'the next round' },
  ], execution, 'current prompt', false, true);
  assert.equal(round.messages.length, 3, 'A tool result in a user envelope must not terminate the current round');
  const projected = activityParts([{ id: 'call', role: 'assistant', content: [{ type: 'toolCall', id: 'a', name: 'write', arguments: { path: 'a.pdf' } }] },
    { id: 'result', role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'done', is_error: true }] }]);
  assert.equal(projected.parts[0].toolCallId, 'a'); assert.equal(projected.parts[1].toolCallId, 'a');
  assert.equal(projected.parts[1].isError, true);
  const bounded = activityParts(Array.from({ length: 2000 }, (_, i) => ({ role: 'assistant', content: `progress ${i}` })));
  assert.equal(bounded.truncated, true); assert.equal(bounded.parts.length, 300); assert.equal(bounded.parts.at(-1).text, 'progress 1999');
});
test('artifacts must exist, be referenced by this run, and stay within permitted roots', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'inspiration-artifacts-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const output = path.join(root, 'report.html'); const unrelated = path.join(root, 'unrelated.pdf'); const link = path.join(root, 'link.pdf');
  fs.writeFileSync(output, '<h1>result</h1>'); fs.writeFileSync(unrelated, 'unrelated'); fs.symlinkSync(unrelated, link);
  const parts = [{ id: 'a', type: 'toolCall', toolCallId: 'write-1', toolArgs: { path: output } },
    { id: 'b', type: 'toolResult', toolCallId: 'write-1', text: 'saved', isError: false },
    { id: 'c', type: 'text', text: `[link](${link}) [missing](${root}/missing.docx) /etc/hosts` }];
  const files = await executionArtifacts({ ...execution, workspace: root, agentId: 'main', resultSummary: null }, parts, root);
  assert.deepEqual(files.items.map(file => file.path), [output]);
  const failed = await executionArtifacts({ ...execution, workspace: root, agentId: 'main', resultSummary: null },
    [parts[0], { ...parts[1], isError: true }], root);
  assert.equal(failed.items.length, 0);
});
test('activity rejects cross-idea and cross-run bindings before reading any backend', async () => {
  let reads = 0;
  const registry = { _requireInspirationOwner: () => ({ getInspirationActivityBinding: async () => ({ execution, prompt: '' }) }),
    _activeGet() { reads++; return null; } };
  await assert.rejects(loadInspirationActivity(registry, 'other', 'run-1'), { code: 'INSPIRATION_BINDING_INVALID' });
  await assert.rejects(loadInspirationActivity(registry, 'idea-1', 'other'), { code: 'INSPIRATION_BINDING_INVALID' });
  assert.equal(reads, 0);
});
test('native trajectory reads the exact run before Chat has ever populated its session cache', async () => {
  const { ShoggothBackend } = require('../app/core/shoggoth-backend');
  const backend = new ShoggothBackend();
  backend._profilesByAgent.set('agent-1', { id: 'profile-1', runtimeAccountId: 'account-1' });
  const message = { id: 'message-1', role: 'assistant', content: [{ type: 'text', text: 'current progress' }] };
  backend._page = async (method, params) => {
    assert.equal(method, 'chat.history'); assert.equal(params.sessionKey, 'session-1');
    return [{ runId: 'older-run', fragment: null, payload: { message: { ...message, id: 'older', content: [{ type: 'text', text: 'older' }] } } },
      { runId: 'run-1', fragment: null, payload: { message } }];
  };
  assert.equal(backend._sessionsByKey.size, 0);
  const history = await backend.getInspirationHistory({ ...execution, agentId: 'agent-1', profileId: 'profile-1', sessionKey: 'session-1' });
  assert.deepEqual(history.messages, [message]); assert.equal(history.exactRun, true);
  assert.equal(backend._sessionsByKey.size, 0);
});
