#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { InspirationStore } = require('../app/agent-service/inspiration-store');
const { openDatabase } = require('../app/agent-service/inspiration-database');

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'inspiration-sqlite-lifecycle-')));
  const paths = { trustedRoot: root, stateDir: path.join(root, 'state') };
  const stores = [];
  const make = options => { const store = new InspirationStore({ paths, ...options }); stores.push(store); return store; };
  t.after(() => { for (const store of stores) store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { make, root };
}

test('v1 SQLite migrates additively with auto growth off and preserves existing ideas', t => {
  const f = fixture(t), store = f.make().open();
  const idea = store.create({ operationId: 'migration-seed', body: 'Keep this seed' });
  const settings = store.growthSettings();
  assert.equal(settings.enabled, false);
  store.close();
  const db = openDatabase(store.filePath);
  db.exec('DROP TABLE inspiration_media_chunks; DROP TABLE inspiration_media; DROP TABLE growth_jobs; DROP INDEX ideas_growth_queue; PRAGMA user_version=1'); db.close();
  store.open();
  assert.deepEqual(store.get(idea.id), idea);
  assert.deepEqual(store.growthSettings(), settings);
  assert.deepEqual(store.growthJobs(['pending']), []);
});

test('stopped executions stay in roots and old seed projections are repaired without changing records', t => {
  const f = fixture(t), store = f.make().open();
  const idea = store.create({ operationId: 'stopped-seed', body: 'Keep this stopped idea' });
  const execution = store.prepareExternalExecution({ id: idea.id, operationId: 'stopped-run', expectedRevision: idea.revision,
    agentId: 'main', backendId: 'openclaw', instruction: '', workspace: null }, () => true);
  store.finishExternalBeforeStart(execution.id, { status: 'canceled' });
  const page = filter => store.listPage({ filter, query: '', cursor: null, limit: 20 });
  assert.equal(page('saved').total, 0);
  assert.equal(page('active').rows[0].id, idea.id);
  assert.equal(store.nextGrowthSeed(), null);
  assert.equal(store.growthFailures()[0].runId, execution.runId);
  const snapshot = store.exportSnapshot();
  store.close();
  const db = openDatabase(store.filePath);
  db.prepare("UPDATE ideas SET bucket='saved' WHERE id=?").run(idea.id);
  db.close();
  for (let index = 0; index < 2; index++) {
    store.open();
    assert.equal(page('saved').total, 0);
    assert.equal(page('active').rows[0].id, idea.id);
    assert.equal(store.nextGrowthSeed(), null);
    assert.deepEqual(store.exportSnapshot(), snapshot, 'Only the derived bucket changed');
    store.close();
  }
});

test('migration resumes after a committed database but interrupted legacy rename, without importing twice', t => {
  const f = fixture(t); const original = f.make().open();
  original.create({ operationId: 'legacy-create', body: 'Preserve this record and its operation receipt' });
  const snapshot = original.exportSnapshot(); original.close();
  fs.unlinkSync(original.filePath);
  fs.writeFileSync(original.legacyPath, JSON.stringify(snapshot), { mode: 0o600 });
  const interruptedFs = Object.create(fs);
  interruptedFs.renameSync = (from, to) => {
    if (from === original.legacyPath) throw Object.assign(new Error('Injected migration interruption'), { code: 'EIO' });
    return fs.renameSync(from, to);
  };
  const interrupted = f.make({ fs: interruptedFs });
  assert.throws(() => interrupted.open(), { code: 'EIO' });
  assert.ok(fs.existsSync(original.legacyPath));
  const recovered = f.make().open();
  assert.deepEqual(recovered.exportSnapshot(), snapshot);
  assert.equal(fs.existsSync(original.legacyPath), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(original.migratedPath)), snapshot);
  recovered.close(); recovered.open();
  assert.deepEqual(recovered.exportSnapshot(), snapshot);
});

test('migration marker cannot silently recreate a missing database or accept a changed legacy writer', t => {
  const f = fixture(t); const store = f.make().open();
  const snapshot = store.exportSnapshot(); store.close();
  fs.unlinkSync(store.filePath);
  fs.writeFileSync(store.legacyPath, JSON.stringify(snapshot), { mode: 0o600 });
  store.open(); store.close();
  fs.writeFileSync(store.legacyPath, JSON.stringify({ ...snapshot, revision: 1 }), { mode: 0o600 });
  assert.throws(() => store.open(), { code: 'INSPIRATION_STORE_CORRUPT' });
  fs.unlinkSync(store.legacyPath); fs.unlinkSync(store.filePath);
  assert.throws(() => store.open(), { code: 'INSPIRATION_STORE_CORRUPT' });
  assert.equal(fs.existsSync(store.filePath), false);
});

test('database privacy and the existing single writer lease remain enforced', t => {
  const f = fixture(t); const store = f.make().open();
  assert.equal(fs.statSync(store.filePath).mode & 0o777, 0o600);
  const contender = f.make();
  assert.throws(() => contender.open());
  store.close(); fs.chmodSync(store.filePath, 0o644);
  assert.throws(() => store.open(), { code: 'UNSAFE_PERMISSIONS' });
  fs.chmodSync(store.filePath, 0o600);
  const foreign = path.join(f.root, 'foreign'); fs.writeFileSync(foreign, 'unrelated', { mode: 0o600 });
  fs.symlinkSync(foreign, store.filePath + '-wal');
  assert.throws(() => store.open(), { code: 'UNSAFE_PATH' });
  assert.equal(fs.readFileSync(foreign, 'utf8'), 'unrelated');
});
