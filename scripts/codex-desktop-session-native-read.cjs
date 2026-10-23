"use strict";
// Read acceptance using the real installed native Codex CLI. Copies one local
// desktop rollout to a disposable Home; no auth/config or model turn is used.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { DatabaseSync } = require("node:sqlite");
const { execFileSync } = require("node:child_process");
const { CodexDesktopSessionStore } = require("../app/agent-service/codex-desktop-session-store");
const { RuntimeAccountResolver } = require("../app/agent-service/runtime-account-resolver");
const { CodexRuntimeHost } = require("../app/agent-service/codex-runtime-host");
const { CodexSchemaContract } = require("../app/agent-service/codex-schema-contract");
const { createCodexChatHistoryMapper } = require("../app/agent-service/codex-chat-history");
const { CodexDesktopSessionController } = require("../app/agent-service/codex-desktop-session-controller");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { DEFAULT_RUNTIME_ACCOUNTS } = require("../app/agent-service/runtime-account");
const { OWNER, ACCOUNT_ID } = require("../app/agent-service/codex-automation-store");
async function run() {
  const original = new CodexDesktopSessionStore({ home: process.env.CODEX_HOME || path.join(os.homedir(), ".codex") });
  const row = process.env.CODEX_DESKTOP_TEST_THREAD ? original.get(process.env.CODEX_DESKTOP_TEST_THREAD) : original.readRows({ limit: 100 }).find(r => {
    try {
      const file = original.get(r.id).rollout_path;
      return fs.statSync(file).size < 500 * 1024 && /"role"\s*:\s*"assistant"/u.test(fs.readFileSync(file, "utf8"));
    } catch { return false; }
  });
  assert.ok(row, "one bounded desktop rollout is required");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shg-desktop-native-read-")));
  const home = path.join(root, "native"), target = path.join(home, path.relative(original.home, row.rollout_path));
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 }); fs.copyFileSync(row.rollout_path, target); fs.chmodSync(target, 0o600);
  const sourceDatabase = fs.readdirSync(original.home).filter(name => /^state_\d+\.sqlite$/u.test(name)).sort((a, b) => Number(b.match(/\d+/u)[0]) - Number(a.match(/\d+/u)[0]))[0];
  const copiedDatabase = path.join(home, sourceDatabase);
  execFileSync("/usr/bin/sqlite3", ["-readonly", path.join(original.home, sourceDatabase), `.backup '${copiedDatabase.replaceAll("'", "''")}'`], { stdio: "pipe" });
  fs.chmodSync(copiedDatabase, 0o600);
  const copy = new DatabaseSync(copiedDatabase);
  copy.prepare("DELETE FROM threads WHERE id<>?").run(row.id);
  copy.prepare("UPDATE threads SET rollout_path=? WHERE id=?").run(target, row.id); copy.close();
  const sourceHistory = new DatabaseSync(path.join(original.home, "thread_history_1.sqlite"), { readOnly: true });
  const copiedHistory = new DatabaseSync(path.join(home, "thread_history_1.sqlite"));
  try {
    sourceHistory.exec("BEGIN"); copiedHistory.exec("BEGIN");
    for (const table of ["_sqlx_migrations", "thread_turns", "thread_items", "thread_history_projection_state", "thread_realtime_items"]) {
      const sql = sourceHistory.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table).sql;
      copiedHistory.exec(sql);
      const rows = sourceHistory.prepare(`SELECT * FROM ${table}${table === "_sqlx_migrations" ? "" : " WHERE thread_id=?"} LIMIT 10000`)
        .all(...(table === "_sqlx_migrations" ? [] : [row.id]));
      let bytes = 0;
      for (const entry of rows) {
        bytes += Buffer.byteLength(JSON.stringify(entry)); assert.ok(bytes < 64 * 1024 * 1024);
        const columns = Object.keys(entry);
        copiedHistory.prepare(`INSERT INTO ${table} (${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`).run(...Object.values(entry));
      }
    }
    copiedHistory.exec("COMMIT"); sourceHistory.exec("COMMIT");
  } finally { copiedHistory.close(); sourceHistory.close(); }
  fs.chmodSync(path.join(home, "thread_history_1.sqlite"), 0o600);
  const paths = resolveServicePaths({ trustedRoot: root, userDataRoot: path.join(root, "product"), cacheRoot: path.join(root, "cache") });
  const binding = { runtime: "codex", runtimeProfileId: OWNER.runtimeProfileId, runtimeAccountId: ACCOUNT_ID };
  const runtimeEnvironment = new RuntimeAccountResolver({ paths, parentEnv: { ...process.env, CODEX_HOME: home }, repoRoot: path.resolve(__dirname, "..") })
    .resolve(binding, DEFAULT_RUNTIME_ACCOUNTS.find(a => a.id === ACCOUNT_ID));
  const schemaContract = new CodexSchemaContract({ repoRoot: path.resolve(__dirname, "..") });
  const host = new CodexRuntimeHost({ paths, repoRoot: path.resolve(__dirname, ".."), runtimeBinding: binding, runtimeEnvironment,
    schemaContract, packageVersion: "desktop-read-test", requestTimeoutMs: 15000 });
  try {
    await host.initialize();
    const started = Date.now();
    const raw = await host.threadRead({ threadId: row.id, includeTurns: false });
    assert.equal(raw.thread.id, row.id); assert.equal(raw.thread.cwd, row.cwd);
    const mapper = createCodexChatHistoryMapper({ schemaContract, cursorSecret: Buffer.alloc(32, 7) });
    const controller = new CodexDesktopSessionController({ schemaContract, now: Date.now });
    controller.mapper = mapper;
    controller.owner = () => ({ bindingId: "fixture-native-binding" });
    const snapshot = await controller.snapshot({ row, sessionKey: "fixture-desktop", profile: { id: "fixture" },
      store: { homeIdentity: "fixture" }, bindingId: "fixture-native-binding" }, { host, response: raw });
    let sequence = 0, messages = 0, pages = 0, more = true, firstPageMs;
    do {
      const adapted = await controller.page(snapshot, { limit: 100 }, [], sequence++);
      firstPageMs ??= Date.now() - started;
      assert.ok(Buffer.byteLength(JSON.stringify(adapted)) < 64 * 1024);
      messages += adapted.messages.length; pages++; more = adapted.hasMore;
    } while (more && pages < 5000);
    assert.equal(more, false);
    assert.ok(messages > 0, "real desktop history must contain messages");
    const hydrated = await host.threadRead({ threadId: row.id, includeTurns: true });
    assert.ok(hydrated.thread.turns.length > 0);
    const resumed = await host.threadResume({ threadId: row.id, excludeTurns: true, cwd: row.cwd, approvalPolicy: "on-request", sandbox: "read-only" });
    assert.equal(resumed.thread.id, row.id); assert.equal(resumed.thread.cwd, row.cwd);
    const { CodexRuntimeAdapter } = require("../app/agent-service/codex-runtime-adapter");
    const { runtimeHandleV1 } = require("../app/agent-service/runtime-handle-v1");
    const adapter = new CodexRuntimeAdapter({ runtimePool: { get: async () => host } });
    const handle = runtimeHandleV1(await adapter.acquire(binding), binding);
    const proof = await handle.sessionRead({ sessionId: row.id, includeTurns: true, operationId: "desktop-read-acceptance-absent" });
    assert.deepEqual(proof.session.historyScope, { operationId: "desktop-read-acceptance-absent", complete: true, turnId: null });
    assert.equal(proof.session.turns.reduce((count, turn) => count + turn.items.length, 0), 0);
    const busyMetadata = await handle.sessionRead({ sessionId: row.id, includeTurns: true, includeItems: false });
    assert.ok(busyMetadata.session.turns.every(turn => turn.itemsView === "notLoaded" && turn.items.length === 0));
    const metadata = new CodexDesktopSessionStore({ home }).get(row.id);
    assert.equal(metadata.id, row.id, "continuing preserves the desktop source classification");
    console.log(JSON.stringify({ verified: true, actualNativeCli: host.runtimeVersion, modelTurnsSent: 0,
      originalHomeWrites: 0, originalThreadAndWorkspacePreserved: true, nativeResumeVerified: true,
      genericHandleValidated: true, operationProofBytes: Buffer.byteLength(JSON.stringify(proof)),
      historyItems: messages, pages, mappedBytes: snapshot.bytes, firstPageMs, elapsedMs: Date.now() - started }));
  } finally { await host.stop(); fs.rmSync(root, { recursive: true, force: true }); }
}
run().catch(error => { console.error({ code: error.code || "NATIVE_READ_FAILED", message: error.message }); process.exitCode = 1; });
