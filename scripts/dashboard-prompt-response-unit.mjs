import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(root, 'app/manage-ui/package.json'));
const ts = require('typescript');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const compile = source => ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} }).outputText;
const responseModule = { exports: {} };
vm.runInNewContext(compile(read('app/manage-ui/src/lib/dashboardPromptResponses.ts')), { exports: responseModule.exports });
const { acknowledgeDashboardPrompt, withoutRespondedDashboardPrompts,
  dashboardPromptResponseRevision, subscribeDashboardPromptResponses } = responseModule.exports;

// Execute the actual Chat response callback and REST function with isolated
// transports. No installed App, provider, or approval operation is contacted.
function sourceNode(file, predicate) {
  const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found;
  const visit = node => { if (predicate(node)) found = node; else ts.forEachChild(node, visit); };
  visit(source);
  assert.ok(found, `Missing response entry point in ${file}`);
  return { node: found, source };
}
const chat = sourceNode('app/manage-ui/src/pages/ChatPage.tsx', node =>
  ts.isVariableDeclaration(node) && node.name.getText() === 'respondPrompt');
const chatCallback = chat.node.initializer.arguments[0].getText(chat.source);
const rest = sourceNode('app/manage-ui/src/api/client.ts', node =>
  ts.isFunctionDeclaration(node) && node.name?.text === 'respondBackendPrompt');

let backendId = 'shoggoth', send, execRespond, restSend;
const sent = [], notices = [];
const context = {
  exports: {}, acknowledgeDashboardPrompt,
  activeKeyRef: { current: 'session-a' },
  backendOfSession: () => backendId,
  isOpenClawQuestionPrompt: () => false,
  isOpenClawExecApproval: entry => entry.approvalSource === 'openclaw_exec',
  messagesRef: { current: [] }, promptHistoryAnchor: () => [],
  execApprovals: { respond: (...args) => execRespond(...args) },
  send: (...args) => { sent.push(args); return send(...args); },
  pendingPromptsRef: { current: new Map() },
  replacePendingPrompts() {}, timelineFeed() {}, renderLiveStateForSession() {},
  inFlightRef: { current: new Set() }, updateSessionMessages() {},
  t: key => key, setToast: notice => notices.push(notice), setTimeout: () => 0,
  jsonFetch: (...args) => restSend(...args),
};
vm.createContext(context);
vm.runInContext(compile(`const respond = ${chatCallback}; exports.chat = respond;`), context);
vm.runInContext(compile(rest.node.getText(rest.source)), context);
const respondChat = context.exports.chat, respondRest = context.exports.respondBackendPrompt;
const entry = (requestId, runId = 'run-a') => ({ id: requestId, version: 1, runId, requestId,
  kind: 'runtime_approval', fields: [] });
const remaining = items => withoutRespondedDashboardPrompts({ generatedAt: 1, running: [],
  approvals: [{ backend: 'shoggoth', supported: true, items }] }).approvals[0].items;
const pending = prompt => ({ id: prompt.id, backendId: 'shoggoth', runId: prompt.runId, requestId: prompt.requestId });
const receipt = prompt => ({ payload: { state: 'responded', requestId: prompt.requestId,
  run: { id: prompt.runId, status: 'running', waitingRequestId: null } } });

let notifications = 0;
const unsubscribe = subscribeDashboardPromptResponses(() => notifications++);
const approved = entry('chat-ack');
let release;
send = () => new Promise(resolve => { release = resolve; });
const response = respondChat(approved, { choice: 'once' });
assert.equal(remaining([pending(approved)]).length, 1, 'Clicking an approval is not an acknowledgment');
backendId = 'other-backend';
release(receipt(approved));
await response;
const foreignBackend = { ...pending(approved), backendId: 'other-backend' };
const foreignRun = { ...pending(approved), runId: 'other-run' };
assert.equal(remaining([pending(approved), foreignBackend, foreignRun]).length, 2,
  'Chat acknowledgment uses the original backend and exact run/request identity');
assert.equal(sent[0][0], 'chat.respond');
assert.equal(notifications, 1);
acknowledgeDashboardPrompt({ backendId: 'shoggoth', runId: approved.runId, requestId: approved.requestId });
assert.equal(notifications, 1, 'Duplicate receipts are idempotent');
backendId = 'shoggoth';

const failed = entry('chat-failed');
send = async () => { throw new Error('offline'); };
await assert.rejects(respondChat(failed, { choice: 'once' }), /offline/);
assert.equal(remaining([pending(failed)]).length, 1, 'A failed Chat response remains pending and retryable');
assert.equal(notices.at(-1).kind, 'error');
for (const wrong of [
  { payload: {} },
  { payload: { ...receipt(failed).payload, requestId: 'wrong-request' } },
  { payload: { ...receipt(failed).payload, run: { id: 'wrong-run' } } },
]) {
  send = async () => wrong;
  await respondChat(failed, { choice: 'once' });
  assert.equal(remaining([pending(failed)]).length, 1, 'An unrelated or unknown receipt cannot hide a pending approval');
}
const input = { ...entry('chat-input'), kind: 'user_input' };
send = async () => receipt(input);
await respondChat(input, { action: 'submit', answers: { answer: 'fixture' } });
assert.equal(remaining([pending(input)]).length, 0, 'Input responses use the same acknowledgment boundary');

const exec = { ...entry('exec-request'), approvalSource: 'openclaw_exec', sessionKey: 'session-exec' };
backendId = 'openclaw';
const execItems = [{ id: exec.requestId, backendId: 'openclaw' }];
execRespond = async () => { throw new Error('not acknowledged'); };
await assert.rejects(respondChat(exec, { choice: 'once' }), /not acknowledged/);
assert.equal(remaining(execItems).length, 1);
execRespond = async () => {};
await respondChat(exec, { choice: 'deny' });
assert.equal(remaining(execItems).length, 0, 'OpenClaw approvals are cleared only after their controller acknowledges the response');

const restPrompt = entry('rest-ack');
const restInput = { runId: restPrompt.runId, requestId: restPrompt.requestId, kind: 'approval', choice: 'once' };
restSend = () => new Promise(resolve => { release = resolve; });
const restResponse = respondRest('shoggoth', restInput);
assert.equal(remaining([pending(restPrompt)]).length, 1);
release({ runId: restInput.runId, status: 'running' });
await restResponse;
assert.equal(remaining([pending(restPrompt)]).length, 0, 'Dashboard REST acknowledgments also survive route remounts');
const invalidRest = { ...restInput, requestId: 'rest-unconfirmed' };
for (const result of [{ runId: 'wrong-run', status: 'running' }, { runId: restInput.runId, status: 'waiting_approval' }]) {
  restSend = async () => result;
  await respondRest('shoggoth', invalidRest);
  assert.equal(remaining([pending(entry(invalidRest.requestId))]).length, 1);
}
restSend = async () => { throw new Error('offline'); };
await assert.rejects(respondRest('shoggoth', invalidRest), /offline/);
assert.equal(remaining([pending(entry(invalidRest.requestId))]).length, 1);
unsubscribe();
const revision = dashboardPromptResponseRevision();
acknowledgeDashboardPrompt({ backendId: 'shoggoth', requestId: 'unsubscribed' });
assert.equal(dashboardPromptResponseRevision(), revision + 1);
assert.equal(notifications, 4, 'Unmounted listeners are removed');
console.log('PASS Chat and Dashboard response acknowledgment: pending, failure, unknown receipt, session switch, input, OpenClaw and REST');
