#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { CodexSecurityScanJobStore, originalScanObservation,
  CODEX_SECURITY_SCAN_TOOL_TIMEOUT_MS } = require('../app/agent-service/codex-security-scan-job-store');
const repoRoot = path.resolve(__dirname, '..');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const SOURCES = ['app/agent-service/codex-security-scan-job-store.js', 'app/agent-service/private-writer-lease.js',
  'app/agent-service/private-file.js', 'app/agent-service/security.js', 'scripts/codex-security-scan-job-store-unit.cjs'];
const hashes = () => Object.fromEntries(SOURCES.map(file => [file, digest(fs.readFileSync(path.join(repoRoot, file)))]));
const SCAN = 'b15b804f-96d0-4d19-9d87-3356e401203a';
const OTHER_SCAN = '184d0890-345f-4489-a63a-747382a69c20';
const SESSION = '022b5095-1c44-476a-8931-7d810e845501';
const roots = [], stores = [], checks = [];
let tick = 1_800_000_000_000;
function context(options = {}) {
  const root = fs.realpathSync(fs.mkdtempSync('/private/tmp/sg-security-scan-journal-'));
  fs.chmodSync(root, 0o700); roots.push(root);
  const paths = { trustedRoot: root, stateDir: path.join(root, 'state') };
  const store = new CodexSecurityScanJobStore({ paths, now: () => tick, ...options }).open(); stores.push(store);
  return { root, paths, store };
}
function input(overrides = {}) {
  return { operationId: 'original-scan-operation', requestDigest: digest('exact-start-arguments'),
    owner: { runId: 'original-run', profileId: 'profile-one', runtimeProfileId: 'native-profile-one',
      runtimeAccountId: 'native-account-one', nativeThreadId: 'original-native-thread', nativeTurnId: 'original-native-turn',
      accountGeneration: 3, workspace: '/private/tmp/original-isolated-workspace' },
    installation: { installationId: 'installation-one', releaseDigest: digest('release'), descriptorDigest: digest('descriptor'),
      sourceIdentity: 'bundled:codex-security', sourceDigest: '8d32d2544f37f8cc8f43df98216b2a505e6f71d9628c555086039daf1062e9fb' },
    capability: { bindingId: 'original-binding', bindingRevision: 2, connectionId: 'original-native-connection',
      authRevision: 4, principalIdentity: 'shoggoth-codex-security-native:' + digest('native-account-one'),
      toolIdentity: 'codex-security:original-start', contractDigest: digest('original-contract'), catalogRevision: digest('catalog'),
      grantEpoch: 6, grantRevision: 2 }, toolName: 'start_codex_security_scan', sourceSessionId: SESSION, ...overrides };
}
function scope(value) { return { operationId: value.operationId, requestDigest: value.requestDigest,
  runtimeAccountId: value.owner.runtimeAccountId, installationId: value.installation.installationId,
  principalIdentity: value.capability.principalIdentity }; }
function result(state = 'running', scanId = SCAN, workspaceId = SESSION) {
  return { content: [{ type: 'text', text: 'Original source structured state fixture' }],
    structuredContent: { workspace: { id: workspaceId, results: { scanId, progress: { status: state } } },
      scan: { scanId, progress: { status: state } } } };
}
function reject(fn, suffix) { assert.throws(fn, { code: 'CODEX_SECURITY_SCAN_JOB_' + suffix }); }
function prepareRunning(store, overrides = {}) {
  const value = input(overrides), handle = store.prepare(value);
  store.markSendStarted(handle); store.bindOriginalAcknowledgement(handle, result());
  return { value, handle };
}
function recordFile(store, operationId) { return path.join(store.directory, digest(operationId) + '.json'); }
function test(name, fn) { fn(); checks.push({ name, passed: true }); }
const before = hashes();
let passed = false;
try {
  test('private prepared intent captures exact immutable identity; cloned/foreign handles and extra caller fields cannot send', () => {
    const { store } = context(), value = input(), original = structuredClone(value), handle = store.prepare(value);
    assert.equal(store.prepare(original), handle); value.owner.runId = 'substitute-run';
    assert.equal(store.observe(scope(original)).state, 'prepared');
    reject(() => store.markSendStarted(structuredClone(handle)), 'HANDLE_INVALID');
    reject(() => store.prepare(value), 'SCOPE_MISMATCH');
    reject(() => store.prepare({ ...original, operationId: 'extra-field', ready: true }), 'INVALID');
    reject(() => store.prepare({ ...original, operationId: 'with-arguments', arguments: { token: 'never-store' } }), 'INVALID');
    let accessed = 0; const getter = { ...original, operationId: 'getter-field' };
    Object.defineProperty(getter, 'owner', { enumerable: true, get() { accessed++; return original.owner; } });
    reject(() => store.prepare(getter), 'INVALID'); assert.equal(accessed, 0);
    const publicStatus = store.observe(scope(original));
    assert.deepEqual(Object.keys(publicStatus), ['version', 'operationId', 'state', 'scanId', 'deadlineAt', 'revision', 'cancellation', 'needsVerification', 'fullPluginUsable']);
    assert.equal(publicStatus.fullPluginUsable, false);
  });
  test('durable send precedes the original 97-hour deadline; repeated original or fresh operation cannot hide an unresolved send', () => {
    const { store } = context(), value = input(), handle = store.prepare(value), started = store.markSendStarted(handle);
    assert.equal(CODEX_SECURITY_SCAN_TOOL_TIMEOUT_MS, 97 * 60 * 60 * 1000);
    assert.equal(started.deadlineAt, tick + CODEX_SECURITY_SCAN_TOOL_TIMEOUT_MS);
    reject(() => store.markSendStarted(handle), 'OBSERVE_ONLY');
    reject(() => store.prepare(value), 'OBSERVE_ONLY');
    store.markUnknown(handle);
    reject(() => store.prepare({ ...value, operationId: 'new-id-same-account' }), 'OWNER_BUSY');
    const body = fs.readFileSync(recordFile(store, value.operationId), 'utf8');
    assert.equal(body.includes('arguments'), false); assert.equal(body.includes('handoffClaimToken'), false);
  });
  test('only bounded original JSON can prove scan identity/completion; getters, human success, SDK draft and conflicting IDs/statuses fail closed', () => {
    assert.equal(originalScanObservation(result('complete')).state, 'complete');
    assert.equal(originalScanObservation(result('draft_ready')).state, 'acknowledged');
    reject(() => originalScanObservation({ content: [{ type: 'text', text: 'complete' }], structuredContent: { ready: true } }), 'RESPONSE_INVALID');
    reject(() => originalScanObservation({ ...result(), isError: true }), 'RESPONSE_INVALID');
    const wrong = result(); wrong.structuredContent.scan.scanId = OTHER_SCAN;
    reject(() => originalScanObservation(wrong), 'RESPONSE_INVALID');
    const states = result(); states.structuredContent.scan.progress.status = 'complete';
    reject(() => originalScanObservation(states), 'RESPONSE_INVALID');
    let accessed = 0; const getter = result(); Object.defineProperty(getter, 'structuredContent', { enumerable: true,
      get() { accessed++; return result().structuredContent; } });
    reject(() => originalScanObservation(getter), 'RESPONSE_INVALID'); assert.equal(accessed, 0);
    const huge = result(); huge.content[0].text = 'x'.repeat(4 * 1024 * 1024 + 1);
    reject(() => originalScanObservation(huge), 'RESPONSE_INVALID');
    const sparse = result(); sparse.content = Array(3); reject(() => originalScanObservation(sparse), 'RESPONSE_INVALID');
    reject(() => originalScanObservation(Object.assign(Object.create({}), result())), 'RESPONSE_INVALID');
  });
  test('original Workspace ID is required at acknowledgment; fresh source scan terminal state cannot be reused as another operation', () => {
    const { store } = context(), value = input(), handle = store.prepare(value); store.markSendStarted(handle);
    reject(() => store.bindOriginalAcknowledgement(handle, result('running', SCAN, OTHER_SCAN)), 'SCAN_CHANGED');
    store.bindOriginalAcknowledgement(handle, result('complete'));
    const next = store.prepare({ ...value, operationId: 'second-operation' }); store.markSendStarted(next);
    reject(() => store.bindOriginalAcknowledgement(next, result('complete')), 'SCAN_ALREADY_RECORDED');
    store.markUnknown(next);
    assert.equal(store.describe(handle).state, 'complete');
    reject(() => store.recordOriginalObservation(handle, { toolName: 'get_codex_security_scan', result: result('running') }), 'SCAN_CHANGED');
  });
  test('running does not regress to SDK acknowledgement; handoff-claim context is excluded from pure observation', () => {
    const { store } = context(), { handle } = prepareRunning(store);
    assert.equal(store.recordOriginalObservation(handle, { toolName: 'get_codex_security_scan', result: result('draft_ready') }).state, 'running');
    reject(() => store.recordOriginalObservation(handle, { toolName: 'get_codex_security_scan_context', result: result() }), 'OBSERVATION_REQUIRED');
    reject(() => store.recordOriginalObservation(handle, { toolName: 'get_codex_security_scan', result: result(), ready: true }), 'OBSERVATION_REQUIRED');
    reject(() => store.recordOriginalObservation(handle, { toolName: 'get_codex_security_scan', result: result('running', OTHER_SCAN) }), 'SCAN_CHANGED');
  });
  test('actual private reopen invalidates send handles and preserves IDs/deadline; lost start ACK reconciles only the exact original Workspace', () => {
    const c = context(), value = input(), handle = c.store.prepare(value); c.store.markSendStarted(handle);
    const deadline = c.store.describe(handle).deadlineAt; c.store.close(); tick += 50;
    const reopened = new CodexSecurityScanJobStore({ paths: c.paths, now: () => tick }).open(); stores.push(reopened);
    assert.equal(reopened.observe(scope(value)).state, 'needs_verification');
    reject(() => reopened.markSendStarted(handle), 'HANDLE_INVALID'); reject(() => reopened.prepare(value), 'OBSERVE_ONLY');
    const original = reopened.resumeObservation(scope(value)); reject(() => reopened.markSendStarted(original), 'HANDLE_INVALID');
    reject(() => reopened.recordOriginalObservation(original, { toolName: 'get_codex_security_scan', result: result() }), 'OBSERVATION_REQUIRED');
    reject(() => reopened.recordOriginalObservation(original, { toolName: 'open_codex_security_workspace', result: result('running', SCAN, OTHER_SCAN) }), 'SCAN_CHANGED');
    const observed = reopened.recordOriginalObservation(original, { toolName: 'open_codex_security_workspace', result: result() });
    assert.equal(observed.state, 'running'); assert.equal(observed.scanId, SCAN); assert.equal(observed.deadlineAt, deadline);
    assert.equal(reopened.findOriginalScan({ scanId: SCAN, runtimeAccountId: value.owner.runtimeAccountId,
      installationId: value.installation.installationId, principalIdentity: value.capability.principalIdentity }).kind, 'codex-security-original-scan-record');
    reject(() => reopened.findOriginalScan({ scanId: SCAN, runtimeAccountId: value.owner.runtimeAccountId,
      installationId: value.installation.installationId, principalIdentity: 'substitute-principal' }), 'SCOPE_MISMATCH');
    reopened.close(); const again = new CodexSecurityScanJobStore({ paths: c.paths, now: () => tick }).open(); stores.push(again);
    const firstRevision = again.observe(scope(value)).revision; again.close();
    const third = new CodexSecurityScanJobStore({ paths: c.paths, now: () => tick }).open(); stores.push(third);
    assert.equal(third.observe(scope(value)).revision, firstRevision);
  });
  test('a prepared crash without send receipt cannot invent a scan or convert a new ID into recovery', () => {
    const c = context(), value = input(); c.store.prepare(value); c.store.close();
    const reopened = new CodexSecurityScanJobStore({ paths: c.paths, now: () => tick }).open(); stores.push(reopened);
    const original = reopened.resumeObservation(scope(value));
    reject(() => reopened.recordOriginalObservation(original, { toolName: 'open_codex_security_workspace', result: result() }), 'OBSERVATION_REQUIRED');
    reject(() => reopened.prepare({ ...value, operationId: 'fresh-after-prepared-crash' }), 'OWNER_BUSY');
    assert.equal(reopened.describe(original).scanId, null);
  });
  test('cancel intent/send/lost ACK remain distinct; source canceled observation is required; restart forbids cancel replay', () => {
    const c = context(), { value, handle } = prepareRunning(c.store), cancel = { operationId: 'one-cancel', requestDigest: digest('exact-cancel') };
    const prepared = c.store.prepareCancel(handle, cancel); assert.equal(prepared.state, 'running'); assert.equal(prepared.cancellation, 'prepared');
    c.store.markCancelSendStarted(handle, cancel.operationId); c.store.markCancelUnknown(handle, cancel.operationId);
    reject(() => c.store.prepareCancel(handle, { ...cancel, operationId: 'second-cancel' }), 'CANCEL_ALREADY_RECORDED');
    reject(() => c.store.markCancelSendStarted(handle, cancel.operationId), 'OBSERVE_ONLY');
    c.store.close(); const reopened = new CodexSecurityScanJobStore({ paths: c.paths, now: () => tick }).open(); stores.push(reopened);
    const original = reopened.resumeObservation(scope(value)); reject(() => reopened.markCancelSendStarted(original, cancel.operationId), 'OBSERVE_ONLY');
    assert.equal(reopened.recordOriginalObservation(original, { toolName: 'get_codex_security_scan', result: result('running') }).cancellation, 'needs_verification');
    const actual = reopened.recordOriginalObservation(original, { toolName: 'get_codex_security_scan', result: result('canceled') });
    assert.equal(actual.state, 'canceled'); assert.equal(actual.cancellation, 'confirmed'); assert.equal(actual.needsVerification, false);
  });
  test('known-unsent cancellation is retained and not attributed to another upstream cancellation', () => {
    const { store } = context(), { handle } = prepareRunning(store), cancel = { operationId: 'cancel-rejected-before-send', requestDigest: digest('cancel') };
    store.prepareCancel(handle, cancel); store.failCancelUnsent(handle, cancel.operationId);
    const observed = store.recordOriginalObservation(handle, { toolName: 'get_codex_security_scan', result: result('canceled') });
    assert.equal(observed.cancellation, 'not_sent'); assert.equal(observed.state, 'canceled');
  });
  test('fixed original deadline never extends across reads or cancellation; completion can be verified after deadline', () => {
    const { store } = context(), { handle } = prepareRunning(store), deadline = store.describe(handle).deadlineAt;
    const previous = tick; tick = deadline;
    const expired = store.recordOriginalObservation(handle, { toolName: 'get_codex_security_scan', result: result() });
    assert.equal(expired.state, 'needs_verification'); assert.equal(expired.deadlineAt, deadline);
    store.prepareCancel(handle, { operationId: 'cancel-after-timeout', requestDigest: digest('cancel-expired') });
    assert.equal(store.describe(handle).deadlineAt, deadline);
    assert.equal(store.recordOriginalObservation(handle, { toolName: 'get_codex_security_scan', result: result('complete') }).state, 'complete');
    tick = previous;
    const overflow = context({ now: () => Number.MAX_SAFE_INTEGER }); const h = overflow.store.prepare(input());
    reject(() => overflow.store.markSendStarted(h), 'INVALID_TIME'); assert.equal(overflow.store.describe(h).state, 'prepared');
  });
  test('terminal tombstones and pending bounds are retained without destructive pruning', () => {
    const { store } = context({ maxPending: 1, maxRecords: 3 }), value = input();
    const first = store.prepare(value); store.failUnsent(first);
    reject(() => store.prepare(value), 'OBSERVE_ONLY');
    const second = store.prepare({ ...value, operationId: 'second' }); store.failUnsent(second);
    const third = store.prepare({ ...value, operationId: 'third' }); store.failUnsent(third);
    reject(() => store.prepare({ ...value, operationId: 'would-prune' }), 'RECORD_LIMIT');
    assert.equal(store.observe(scope(value)).state, 'not_sent');
    const limited = context({ maxPending: 1 }); limited.store.prepare(input());
    reject(() => limited.store.prepare({ ...value, operationId: 'other-account', owner: { ...value.owner, runtimeAccountId: 'other-account' } }), 'PENDING_LIMIT');
  });
  test('checksum tampering and actual writer inode/byte replacement fail closed before writes', () => {
    const c = context(), value = input(); c.store.prepare(value); c.store.close();
    const file = recordFile(c.store, value.operationId), body = JSON.parse(fs.readFileSync(file));
    body.record.state = 'not_sent'; fs.writeFileSync(file, JSON.stringify(body), { mode: 0o600 });
    reject(() => new CodexSecurityScanJobStore({ paths: c.paths, now: () => tick }).open(), 'CORRUPT');
    const other = context(), h = other.store.prepare(input()), lock = path.join(other.store.directory, 'writer.lock');
    fs.writeFileSync(lock, 'controlled changed owner record\n');
    reject(() => other.store.markSendStarted(h), 'WRITER_CHANGED');
  });
  test('actual atomic rename with lost acknowledgement freezes writes; reopening retains the original unknown and forbids resend', () => {
    const c = context(), value = input(), rename = fs.renameSync; let changed = 0;
    fs.renameSync = (from, to) => { rename(from, to);
      if (path.dirname(to) === c.store.directory && to.endsWith('.json') && changed++ === 0) {
        const error = new Error('controlled lost ACK after owned private rename'); error.code = 'EIO'; throw error;
      }
    };
    try { assert.throws(() => c.store.prepare(value), { code: 'EIO' }); } finally { fs.renameSync = rename; }
    assert.equal(changed, 1); reject(() => c.store.observe(scope(value)), 'WRITE_UNCERTAIN'); c.store.close();
    const reopened = new CodexSecurityScanJobStore({ paths: c.paths, now: () => tick }).open(); stores.push(reopened);
    assert.equal(reopened.observe(scope(value)).state, 'needs_verification'); reject(() => reopened.prepare(value), 'OBSERVE_ONLY');
  });
  assert.deepEqual(hashes(), before); passed = true;
  const report = { version: 1, verified: true, scope: 'actual private FS/writer and controlled original response shapes; no native/model/scan effect',
    count: checks.length, checks, codeHashesBefore: before, codeHashesAfter: hashes(), originalTimeoutMs: CODEX_SECURITY_SCAN_TOOL_TIMEOUT_MS,
    fullPluginUsable: false, realScannerExecuted: false };
  if (process.argv[2]) { assert.ok(path.resolve(process.argv[2]).startsWith('/private/tmp/')); fs.writeFileSync(process.argv[2], JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); }
  console.log(`PASS ${checks.length}/${checks.length} original scan journal boundaries`);
} catch (error) { console.error(error.stack); process.exitCode = 1; }
finally {
  for (const store of stores) { try { store.close(); } catch {} }
  if (passed) for (const root of roots) { assert.ok(/^\/private\/tmp\/sg-security-scan-journal-[A-Za-z0-9]+$/u.test(root)); fs.rmSync(root, { recursive: true }); }
  else console.error('Preserved owned failure roots: ' + JSON.stringify(roots));
}
