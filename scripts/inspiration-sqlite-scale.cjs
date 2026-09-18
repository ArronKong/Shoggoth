#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { performance } = require("node:perf_hooks");
const { InspirationStore } = require("../app/agent-service/inspiration-store");
const { InspirationService } = require("../app/agent-service/inspiration-service");
const { transaction } = require("../app/agent-service/inspiration-database");
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "inspiration-scale-")));
const paths = { trustedRoot: root, stateDir: path.join(root, "state") };
const count = 100000, at = 2000000000000;
const uuid = i => `00000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`;
const store = new InspirationStore({ paths });
const measure = action => { const start = performance.now(); const result = action(); return { ms: performance.now() - start, result }; };
try {
  fs.mkdirSync(paths.stateDir, { mode: 0o700 });
  const legacy = { version: 3, revision: 170000, ideas: {}, executions: {}, operations: {} };
  for (let i = 0; i < count; i += 1) {
    const id = uuid(i);
    legacy.ideas[id] = { id, body: `灵感 ${i} · ${i === 99990 ? '唯一检索目标' : '长期保存的记录'}`,
      title: null, revision: 1, favorite: i % 9 === 0, archivedAt: null, acceptedAt: null,
      createdAt: at - 100, updatedAt: at - (i % 3), deletedAt: null };
    if (i < 70000) legacy.operations[`legacy-${i}`] = { fingerprint: 'a'.repeat(64), type: 'ideas', id };
  }
  fs.writeFileSync(store.legacyPath, JSON.stringify(legacy), { mode: 0o600 });
  const migration = measure(() => store.open());
  assert.equal(store.listPage({ filter: 'all', query: '', cursor: null, limit: 20 }).total, count);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM operations').get().n, 70000);
  assert.equal(fs.existsSync(store.legacyPath), false);
  assert.equal(JSON.parse(fs.readFileSync(store.migratedPath)).revision, 170000);
  assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  const first = store.listPage({ filter: 'all', query: '', cursor: null, limit: 20 });
  const cursor = `${first.rows.at(-1).updatedAt}:${first.rows.at(-1).id}`;
  store.delete({ id: first.rows.at(-1).id, expectedRevision: 1, operationId: 'delete-cursor' }, () => true);
  const second = store.listPage({ filter: 'all', query: '', cursor, limit: 20 });
  assert.equal(new Set([...first.rows, ...second.rows].map(idea => idea.id)).size, 40, 'Deleting a cursor must not repeat or lose the next page');
  const search = measure(() => store.listPage({ filter: 'all', query: '唯一检索', cursor: null, limit: 20 }));
  assert.equal(search.result.rows[0].id, uuid(99990));
  assert.equal(store.listPage({ filter: 'all', query: '灵感', cursor: null, limit: 20 }).total, count - 1);
  assert.equal(store.listPage({ filter: 'all', query: '" OR "', cursor: null, limit: 20 }).total, 0);
  // Grow the new database beyond the legacy JSON limit with real execution
  // records, including 35,000 rounds belonging to one idea. Fixture insertion
  // is transactional; all queried rows still pass the production validators.
  const executionCount = 70000;
  const historyIdea = uuid(99998);
  transaction(store.db, () => {
    const insert = store.db.prepare(`INSERT INTO executions(id,idea_id,run_id,operation_id,session_key,
      backend_id,agent_id,created_at,external,status,data) VALUES (?,?,?,?,?,'shoggoth','main',?,0,'completed',?)`);
    const receipt = store.db.prepare("INSERT INTO operations VALUES (?,?,'executions',?)");
    for (let i = 0; i < executionCount; i++) {
      const ideaId = i < 35000 ? uuid(i) : historyIdea;
      const execution = { id: uuid(200000 + i), ideaId, operationId: `scale-execution-${i}`, ideaRevision: 1,
        body: legacy.ideas[ideaId].body, title: null, instruction: '', agentId: 'main', backendId: 'shoggoth',
        profileId: 'profile-1', workspace: root, sessionKey: uuid(400000 + (i < 35000 ? i : 99998)),
        runId: uuid(600000 + i), retryOf: null, createdAt: at - 100 + i, attention: null,
        preparationFailure: null, external: null };
      insert.run(execution.id, ideaId, execution.runId, execution.operationId, execution.sessionKey,
        execution.createdAt, JSON.stringify(execution));
      receipt.run(execution.operationId, 'b'.repeat(64), execution.id);
    }
    store.db.exec(`UPDATE ideas SET latest_id=(SELECT id FROM executions WHERE idea_id=ideas.id
      ORDER BY created_at DESC,id DESC LIMIT 1),bucket='result' WHERE id IN (SELECT idea_id FROM executions)`);
  });
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM executions').get().n, executionCount);
  const history = measure(() => store.executionsPage({ id: historyIdea, limit: 20, cursor: null }));
  assert.equal(history.result.total, 35000); assert.equal(history.result.rows.length, 20);
  const historyLast = history.result.rows.at(-1);
  const older = store.executionsPage({ id: historyIdea, limit: 20, cursor: `${historyLast.createdAt}:${historyLast.id}` });
  assert.equal(new Set([...history.result.rows, ...older.rows].map(row => row.id)).size, 40);
  assert.equal(store.executionForSession(uuid(499998)).id, history.result.rows[0].id);
  const native = store.prepareExecution({ id: uuid(99999), expectedRevision: 1, operationId: 'native-reserve', instruction: '',
    agentId: 'main', backendId: 'shoggoth', profileId: 'profile-1', workspace: root }, () => true);
  store.projectNativeStatuses([{ runId: native.runId, status: 'completed' }]);
  assert.equal(store.listPage({ filter: 'result', query: '灵感 99999', cursor: null, limit: 20 }).rows[0].id, native.ideaId);
  const before = store.exportSnapshot();
  store.commitTransaction = (db, action) => transaction(db, () => { action(); throw Object.assign(new Error('full after writes'), { code: 'ENOSPC' }); });
  const edit = { id: uuid(99990), operationId: 'rollback-edit', expectedRevision: 1, patch: { body: 'must roll back' } };
  assert.throws(() => store.update(edit), { code: 'ENOSPC' });
  assert.equal(store.get(edit.id).body, legacy.ideas[edit.id].body);
  assert.equal(store.revision, before.revision);
  assert.equal(store.db.prepare('SELECT id FROM operations WHERE id=?').get(edit.operationId), undefined);
  store.commitTransaction = transaction;
  store.update(edit);
  assert.equal(store.update(edit).revision, 2, 'Replaying the rolled-back then committed operation is idempotent');
  const writes = [], pages = [];
  for (let i = 0; i < 40; i += 1) {
    const idea = store.get(uuid(90000 + i));
    writes.push(measure(() => store.update({ id: idea.id, expectedRevision: idea.revision,
      operationId: crypto.randomUUID(), patch: { favorite: !idea.favorite } })).ms);
    pages.push(measure(() => store.listPage({ filter: 'all', query: '', cursor: `${at - 2}:${uuid(98000)}`, limit: 20 })).ms);
  }
  const queryPlan = store.db.prepare('EXPLAIN QUERY PLAN SELECT data FROM ideas WHERE deleted=0 AND archived=0 AND (sort_at,id)>(?,?) ORDER BY sort_at,id LIMIT 20')
    .all(-(at - 2), uuid(98000)).map(row => row.detail);
  assert.ok(queryPlan.some(detail => detail.includes('ideas_page')));
  // The service must use SQL pages, never the former full-store API.
  store.list = () => assert.fail('full list on hot path');
  store.executions = () => assert.fail('full execution history on hot path');
  const service = new InspirationService({ store, dispatcher: { getRun() { return null; } } });
  service.open();
  service.handle('inspiration.list', { filter: 'all', query: '', cursor: null, limit: 20 }).then(result => {
    assert.equal(result.items.length, 20);
  }).catch(error => { throw error; });
  service.close();
  store.close();
  const reopen = measure(() => store.open());
  assert.equal(store.get(edit.id).body, 'must roll back');
  const p95 = values => [...values].sort((a, b) => a - b)[Math.floor(values.length * 0.95)];
  const report = { ideas: count, migratedOperationReceipts: 70000, operationReceipts: 140000, migrationMs: +migration.ms.toFixed(2),
    executions: executionCount, largestExecutionHistory: 35000, historyPageMs: +history.ms.toFixed(2),
    reopenMs: +reopen.ms.toFixed(2), editP95Ms: +p95(writes).toFixed(2), deepPageP95Ms: +p95(pages).toFixed(2),
    indexedSearchMs: +search.ms.toFixed(2), databaseBytes: fs.statSync(store.filePath).size, queryPlan };
  console.log(JSON.stringify(report, null, 2));
  assert.ok(report.editP95Ms < 1000 && report.deepPageP95Ms < 1000, 'Hot operations must remain bounded at 100k records');
} finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
