"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { fixture } = require("./codex-desktop-session-service-fixture.cjs");

(async () => {
  const f = await fixture();
  try {
    const row = f.backend.getSessionRows().find(r => r.label === "桌面对话：保留原上下文");
    let resumes = 0, failure;
    f.host.threadResume = async () => {
      resumes++;
      throw Object.assign(new Error("fixture-private-context"), {
        code: "RPC_REMOTE_ERROR", rpcCode: -32600, remoteClassification: "SESSION_WRITER_BUSY",
      });
    };
    await f.backend.sendMessage(row.key, "写锁失败的本地测试", crypto.randomUUID(), { error: e => { failure = e; } });
    const run = f.service.productStore.listWorkRuns({ source: "chat", sourceId: row.sessionId }).at(-1);
    assert.equal(run.status, "failed");
    assert.equal(run.errorCode, "RUNTIME_SESSION_WRITER_BUSY");
    assert.equal(resumes, 1, "native writer contention must not be retried");
    assert.equal(f.host.turnStarts, 0); assert.equal(f.host.threadStarts, 0);
    assert.equal(run.runtimeSessionRef, null); assert.equal(run.runtimeTurnRef, null);
    assert.match(String(failure), /Codex Desktop/u);
    assert.equal(String(failure).includes("fixture-private-context"), false);
    const history = await f.backend.getHistory(row.key);
    assert.equal(history.messages.filter(m => m.role === "user" && m.content[0]?.text === "写锁失败的本地测试").length, 1);
    assert.ok(history.messages.some(m => m.role === "system" && /RUNTIME_SESSION_WRITER_BUSY|Codex Desktop/u.test(m.content[0]?.text || "")));
    console.log(JSON.stringify({ verified: true, durableErrorCode: run.errorCode, clearFailureMessage: true,
      nativeResumeAttempts: resumes, modelTurnsSent: 0, originalHomeWrites: 0, failedMessageRetained: true }));
  } finally { await f.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
