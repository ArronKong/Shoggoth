#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createContext, repoRoot, removeFixtureRoot } = require('./fixtures/codex-security-native-factory-context.cjs');
const { CodexSecurityNativeJobStore } = require('../app/agent-service/codex-security-native-job-store');
const { CODEX_SECURITY_NATIVE_ENV_NAMES, CODEX_SECURITY_NATIVE_ENV_INVENTORY } = require('../app/agent-service/codex-security-native-host-plan');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const SOURCES = ['app/agent-service/codex-security-native-host-plan.js', 'app/agent-service/codex-security-native-job-store.js',
  'scripts/codex-security-native-host-plan-unit.cjs', 'scripts/fixtures/codex-security-native-factory-context.cjs'];
const hashes = () => Object.fromEntries(SOURCES.map(file => [file, hash(fs.readFileSync(path.join(repoRoot, file)))]));
async function main() {
  const before = hashes(); const checks = [], contexts = [];
  const c = createContext(); contexts.push(c);
  const input = { operationId: 'native-metadata-one', installationId: c.installation.installationId };
  try {
    assert.equal(CODEX_SECURITY_NATIVE_ENV_NAMES.length, 43);
    assert.deepEqual(CODEX_SECURITY_NATIVE_ENV_NAMES, CODEX_SECURITY_NATIVE_ENV_INVENTORY.map(item => item.name));
    const source = JSON.parse(fs.readFileSync(path.join(repoRoot, 'resources/bundled-plugins/packages/codex-security/.mcp.json'))).mcpServers['codex-security'];
    assert.deepEqual(CODEX_SECURITY_NATIVE_ENV_NAMES, source.env_vars);
    checks.push('all43 source names retained and individually classified; no ambient secret values');
    for (const extra of ['env', '_meta', 'threadId', 'authenticated', 'modelReady', 'scope', 'grant', 'credentialRef'])
      assert.throws(() => c.factory.prepare({ ...input, [extra]: {} }, c.lease), { code: 'CODEX_SECURITY_NATIVE_INVALID' });
    let getters = 0;
    assert.throws(() => c.factory.prepare({ installationId: input.installationId, get operationId() { getters++; return input.operationId; } }, c.lease), { code: 'CODEX_SECURITY_NATIVE_INVALID' });
    assert.equal(getters, 0);
    assert.throws(() => c.factory.prepare(Object.assign(Object.create({ ready: true }), input), c.lease), { code: 'CODEX_SECURITY_NATIVE_INVALID' });
    checks.push('exact constructor-independent operation fields; getters/prototypes/renderer readiness rejected');
    assert.throws(() => c.factory.prepare(input, { version: 1, signal: new AbortController().signal }), { code: 'HOST_CAPABILITY_REVOKED' });
    const noMcp = c.issuer.issue({ identity: c.identity, grants: ['artifact'], validate: () => true });
    assert.throws(() => c.factory.prepare(input, noMcp), { code: 'HOST_CAPABILITY_REVOKED' });
    checks.push('copied/forged lease and wrong actual grant cannot prepare');
    const wrong = c.issuer.issue({ identity: { ...c.identity, bindingId: 'foreign-binding' }, grants: ['mcp'], validate: () => true });
    assert.throws(() => c.factory.prepare(input, wrong));
    const noGeneration = c.issuer.issue({ identity: { ...c.identity, accountGeneration: 0 }, grants: ['mcp'], validate: () => true });
    assert.throws(() => c.factory.prepare(input, noGeneration), { code: 'CODEX_SECURITY_NATIVE_OWNER_INVALID' });
    checks.push('actual profile binding and admitted account generation required');
    const plan = c.factory.prepare(input, c.lease);
    assert.equal(c.factory.prepare(input, c.lease), plan);
    const info = c.factory.describe(plan, c.lease);
    assert.equal(info.originalFieldCount, 6); assert.equal(info.environmentNameCount, 43);
    assert.equal(info.startupTimeoutSec, 120); assert.equal(info.toolTimeoutSec, 349200);
    assert.equal(info.fullPluginUsable, false); assert.equal(info.originalToolsUnlocked, false);
    assert.equal('threadId' in info, false); assert.equal('env' in info, false);
    assert.throws(() => c.factory.describe(structuredClone(plan), c.lease), { code: 'CODEX_SECURITY_NATIVE_PLAN_INVALID' });
    assert.throws(() => c.factory.describe(plan, noMcp), { code: 'CODEX_SECURITY_NATIVE_PLAN_INVALID' });
    checks.push('opaque exact plan; repeated same operation is same handle; safe status preserves6fields/timeouts');
    const candidate = c.factory.originalComponentCandidate(plan, c.lease);
    assert.equal(candidate.registered, true); assert.equal(candidate.intendedToolCount, 45);
    assert.equal(Object.keys(candidate.spec).length, 6); assert.deepEqual(candidate.spec.env_vars, source.env_vars);
    assert.deepEqual(candidate.sourceSpec, source); assert.equal(candidate.descriptorDigest, hash(JSON.stringify(source)));
    assert.ok(path.isAbsolute(candidate.spec.command)); assert.ok(path.isAbsolute(candidate.spec.cwd));
    assert.equal(Object.keys(candidate.sourceFiles).length, 4);
    assert.throws(() => c.factory.assertFullToolEgress(plan, c.lease), { code: 'CODEX_SECURITY_NATIVE_NATIVE_TURN_AND_DISPATCH_TICKET_REQUIRED' });
    checks.push('real installed original component registered; missing owning turn and dispatcher ticket still rejects egress');
    const status = c.factory.observe(plan, c.lease); assert.equal(status.state, 'prepared');
    assert.equal(status.hasNativeThread, false); assert.equal(status.needsVerification, false);
    const file = fs.readdirSync(c.jobs.directory).find(name => /^[a-f0-9]{64}\.json$/.test(name));
    const body = JSON.parse(fs.readFileSync(path.join(c.jobs.directory, file)));
    assert.equal(body.record.nativeThreadId, null); assert.equal(body.record.scanId, null);
    assert.equal(fs.statSync(path.join(c.jobs.directory, file)).mode & 0o777, 0o600);
    assert.equal(fs.statSync(c.jobs.directory).mode & 0o777, 0o700);
    assert.ok(!/apiKey|credentialRef|"env"|toolArguments/.test(JSON.stringify(body)));
    assert.throws(() => new CodexSecurityNativeJobStore({ paths: c.paths }).open(), { code: 'WRITER_LEASE_HELD' });
    checks.push('durable originalID/release/owner before native effect;0600/0700 and real crosswriter exclusion');
    const capture = { operationId: body.record.operationId, requestDigest: body.record.requestDigest, owner: body.record.owner,
      installation: body.record.installation, planDigest: body.record.planDigest };
    const handle = c.jobs.prepare(capture);
    assert.throws(() => c.jobs.markStarting(structuredClone(handle)), { code: 'CODEX_SECURITY_JOB_HANDLE_INVALID' });
    c.jobs.markStarting(handle);
    assert.throws(() => c.jobs.prepare(capture), { code: 'CODEX_SECURITY_JOB_OBSERVE_ONLY' });
    c.jobs.bindNativeThread(handle, 'actual-native-id-fixture-storage-only');
    assert.throws(() => c.jobs.markStarting(handle), { code: 'CODEX_SECURITY_JOB_STATE_INVALID' });
    checks.push('branded durable handle; a started original operation cannot prepare/restart');
    c.jobs.markUncertain(handle);
    assert.throws(() => c.jobs.prepare({ ...capture, operationId: 'fresh-key-would-repeat-unknown' }), { code: 'CODEX_SECURITY_JOB_OWNER_BUSY' });
    assert.throws(() => c.jobs.observe({ operationId: capture.operationId, requestDigest: hash('bad'), owner: capture.owner }), { code: 'CODEX_SECURITY_JOB_SCOPE_MISMATCH' });
    assert.throws(() => c.jobs.observe({ operationId: capture.operationId, requestDigest: capture.requestDigest,
      owner: { ...capture.owner, profileId: 'other-agent' } }), { code: 'CODEX_SECURITY_JOB_SCOPE_MISMATCH' });
    assert.equal(c.jobs.observe({ operationId: 'missing-original', requestDigest: capture.requestDigest, owner: capture.owner }).state, 'not_found');
    checks.push('unknown requires exact original observation; newkey/foreignAgent/digest mismatch cannot replay');
    c.jobs.close();
    const reopened = new CodexSecurityNativeJobStore({ paths: c.paths }).open();
    assert.equal(reopened.observe({ operationId: capture.operationId, requestDigest: capture.requestDigest, owner: capture.owner }).state, 'needs_verification');
    assert.throws(() => reopened.prepare(capture), { code: 'CODEX_SECURITY_JOB_OBSERVE_ONLY' });
    assert.throws(() => reopened.markStarting(handle), { code: 'CODEX_SECURITY_JOB_HANDLE_INVALID' });
    reopened.close();
    checks.push('private file reopen retains original unknown; no handle authority survives restart');
    // Retire factory before cleanup; this fake-storage-only thread was never a native process.
    await c.factory.close().catch(() => {});
    c.issuer.close(); c.store.close(); c.productStore.close(); removeFixtureRoot(c.root); contexts.shift();

    const d = createContext({ maxPending: 1 }); contexts.push(d);
    const p = d.factory.prepare({ operationId: 'unsent-metadata', installationId: d.installation.installationId }, d.lease);
    await d.factory.closeMetadata(p, d.lease);
    assert.throws(() => d.factory.describe(p, d.lease), { code: 'CODEX_SECURITY_NATIVE_PLAN_INVALID' });
    const originalFile = fs.readdirSync(d.jobs.directory).find(name => /^[a-f0-9]{64}\.json$/.test(name));
    const original = JSON.parse(fs.readFileSync(path.join(d.jobs.directory, originalFile))).record;
    const another = { operationId: 'normal-next-id', requestDigest: hash('next'), owner: d.owner,
      installation: original.installation, planDigest: original.planDigest };
    const next = d.jobs.prepare(another); d.jobs.failUnsent(next);
    // Pending cap does not count terminal tombstones. They remain non-reusable.
    for (let i = 0; i < 4; i++) { const h = d.jobs.prepare({ ...another, operationId: `terminal-${i}` }); d.jobs.failUnsent(h); }
    assert.throws(() => d.jobs.prepare(another), { code: 'CODEX_SECURITY_JOB_OBSERVE_ONLY' });
    assert.equal(d.jobs.observe({ operationId: another.operationId, requestDigest: another.requestDigest, owner: another.owner }).state, 'failed_unsent');
    checks.push('known-unsent terminal allows new operation; pending bound does not erase durable terminal IDs');
    d.jobs.close();
    const payload = JSON.parse(fs.readFileSync(path.join(d.jobs.directory, originalFile)));
    payload.record.state = 'prepared'; // no checksum rewrite
    fs.writeFileSync(path.join(d.jobs.directory, originalFile), JSON.stringify(payload), { mode: 0o600 });
    assert.throws(() => new CodexSecurityNativeJobStore({ paths: d.paths }).open(), { code: 'CODEX_SECURITY_JOB_CORRUPT' });
    checks.push('corrupt file/checksum is failclosed, never grants recovery');
    await d.factory.close().catch(() => {}); d.issuer.close(); d.store.close(); d.productStore.close(); removeFixtureRoot(d.root); contexts.shift();

    const e = createContext(); contexts.push(e);
    const ep = e.factory.prepare({ operationId: 'retired-plan', installationId: e.installation.installationId }, e.lease);
    e.admission.release({ runtimeAccountId: e.profile.runtimeAccountId, runId: e.run.id });
    assert.throws(() => e.factory.describe(ep, e.lease), { code: 'RUNTIME_ACCOUNT_RUN_NOT_ADMITTED' });
    await e.factory.closeMetadata(ep, e.lease);
    checks.push('actual RuntimeAccount active-run release revokes metadata authority');
    await e.close(); contexts.shift();
    let effectCount = 0;
    const f = createContext({ onNativeHost() { effectCount++; } }); contexts.push(f);
    const fp = f.factory.prepare({ operationId: 'source-changed-before-start', installationId: f.installation.installationId }, f.lease);
    const staged = f.factory.originalComponentCandidate(fp, f.lease).spec.cwd;
    const stagedServer = path.join(staged, 'mcp/server.mjs');
    fs.chmodSync(stagedServer, 0o600); fs.appendFileSync(stagedServer, '\n// isolated source mutation negative\n');
    await assert.rejects(f.factory.startMetadata(fp, f.lease), { code: 'CODEX_SECURITY_NATIVE_SOURCE_CHANGED' });
    assert.equal(effectCount, 0); await f.factory.closeMetadata(fp, f.lease); await f.close(); contexts.shift();
    checks.push('staged original byte mutation rejects before any native process effect');
    const g = createContext({ onNativeHost() { effectCount++; } }); contexts.push(g);
    const gp = g.factory.prepare({ operationId: 'disabled-before-start', installationId: g.installation.installationId }, g.lease);
    g.store.setInstallationDesiredState({ installationId: g.installation.installationId, desiredState: 'disabled', expectedRevision: g.installation.revision });
    await assert.rejects(g.factory.startMetadata(gp, g.lease), { code: 'CODEX_SECURITY_NATIVE_INSTALLATION_INVALID' });
    assert.equal(effectCount, 0); await g.factory.closeMetadata(gp, g.lease); await g.close(); contexts.shift();
    checks.push('actual installed revision disable revokes staged metadata before process effect');
    const h = createContext({ onNativeHost() { effectCount++; } }); contexts.push(h);
    const hp = h.factory.prepare({ operationId: 'unexpected-auth-before-start', installationId: h.installation.installationId }, h.lease);
    const environment = h.runtimeResolver.resolve({ runtime: 'codex', runtimeProfileId: h.profile.runtimeProfileId,
      runtimeAccountId: h.profile.runtimeAccountId }, h.productStore.getRuntimeAccount(h.profile.runtimeAccountId));
    fs.writeFileSync(path.join(environment.home, 'auth.json'), '{}', { mode: 0o600, flag: 'wx' });
    await assert.rejects(h.factory.startMetadata(hp, h.lease), { code: 'CODEX_SECURITY_NATIVE_CREDENTIALLESS_HOME_REQUIRED' });
    assert.equal(effectCount, 0); await h.factory.closeMetadata(hp, h.lease); await h.close(); contexts.shift();
    checks.push('unexpected synthetic managed auth file cannot be borrowed by metadata-only plan');
    const i = createContext(); contexts.push(i);
    i.factory.prepare({ operationId: 'prepared-before-crash', installationId: i.installation.installationId }, i.lease);
    const iRecord = JSON.parse(fs.readFileSync(path.join(i.jobs.directory, fs.readdirSync(i.jobs.directory).find(name => /^[a-f0-9]{64}\.json$/.test(name))))).record;
    i.jobs.close();
    const iReopen = new CodexSecurityNativeJobStore({ paths: i.paths }).open();
    const iScope = { operationId: iRecord.operationId, requestDigest: iRecord.requestDigest, owner: iRecord.owner };
    assert.equal(iReopen.observe(iScope).state, 'needs_verification');
    assert.throws(() => iReopen.prepare({ ...iScope, installation: iRecord.installation, planDigest: iRecord.planDigest }), { code: 'CODEX_SECURITY_JOB_OBSERVE_ONLY' });
    iReopen.close(); await i.factory.close().catch(() => {}); i.issuer.close(); i.store.close(); i.productStore.close(); removeFixtureRoot(i.root); contexts.shift();
    checks.push('even prepared crash identity is conservatively original-observation-only, never a reconstructed handle');
    const j = createContext(); contexts.push(j);
    const pin = { installationId: j.installation.installationId, revision: j.installation.revision,
      releaseDigest: j.installation.releaseDigest, sourceDigest: j.catalog.assertCurrent('codex-security').sourceDigest, sourceIdentity: 'bundled:codex-security' };
    const uncertain = { operationId: 'lost-durable-write-ack', requestDigest: hash('lost-ack'), owner: j.owner,
      installation: pin, planDigest: hash('lost-ack-plan') };
    const realRename = fs.renameSync; let renamed = 0;
    fs.renameSync = (from, to) => {
      realRename(from, to);
      if (path.dirname(to) === j.jobs.directory && to.endsWith('.json') && !renamed++) {
        const error = new Error('controlled lost ACK after actual private rename'); error.code = 'EIO'; throw error;
      }
    };
    try { assert.throws(() => j.jobs.prepare(uncertain), { code: 'EIO' }); } finally { fs.renameSync = realRename; }
    assert.equal(renamed, 1);
    assert.throws(() => j.jobs.observe({ operationId: uncertain.operationId, requestDigest: uncertain.requestDigest, owner: uncertain.owner }), { code: 'CODEX_SECURITY_JOB_WRITE_UNCERTAIN' });
    j.jobs.close(); const jReopen = new CodexSecurityNativeJobStore({ paths: j.paths }).open();
    assert.equal(jReopen.observe({ operationId: uncertain.operationId, requestDigest: uncertain.requestDigest, owner: uncertain.owner }).state, 'needs_verification');
    assert.throws(() => jReopen.prepare(uncertain), { code: 'CODEX_SECURITY_JOB_OBSERVE_ONLY' }); jReopen.close();
    await j.close(); contexts.shift();
    checks.push('actual private rename with controlled lost ACK freezes current writer; restart keeps original unknown and forbids new handle');
    const after = hashes(); assert.deepEqual(after, before);
    const result = { version: 1, verified: true, scope: 'Service-only plan/durable local boundaries; no native process/model/scan',
      checks: checks.map(name => ({ name, passed: true })), count: checks.length, codeHashesBefore: before, codeHashesAfter: after,
      fullPluginUsable: false, originalToolsUnlocked: false };
    if (process.argv[2]) { assert.ok(path.dirname(process.argv[2]) === '/private/tmp' && !fs.existsSync(process.argv[2])); fs.writeFileSync(process.argv[2], `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600, flag: 'wx' }); }
    console.log(`PASS ${checks.length}/${checks.length} Service-native host plan/job boundaries`);
  } finally { for (const context of contexts) await context.close(); }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
