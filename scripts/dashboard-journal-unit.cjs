"use strict";

// 切片3：DashboardJournal 单测（TDD 先行）。
// journal = 健康事件（断连/恢复，抗抖动、重启检测、7d/1000 裁剪、损坏降级、
// 原子写 0600、写失败退内存态、敏感串清洗）+ Hermes kanban per-profile cursor。
// 路径由入口注入（Electron userData / manage-serve dev 路径），core 不碰 electron。
// 运行：node scripts/dashboard-journal-unit.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createDashboardJournal } = require("../app/core/dashboard-journal");

const T0 = 1783900800000;

function tmpFile(name = "journal.json") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-dj-"));
  return path.join(dir, name);
}

const TGT = (state, over = {}) => Object.assign(
  { targetType: "gateway", targetId: "openclaw", backendId: "openclaw", state },
  over,
);

function testFirstHealthySilent() {
  const j = createDashboardJournal(tmpFile());
  const e1 = j.recordHealthSample([TGT("connected")], { atMs: T0 });
  const e2 = j.recordHealthSample([TGT("connected")], { atMs: T0 + 45000 });
  assert.deepEqual([e1, e2], [[], []], "首次正常不生成事件");
  assert.deepEqual(j.getHealthEvents(), []);
}

function testFirstFailureRecordedAfterTwoSamples() {
  const j = createDashboardJournal(tmpFile());
  const e1 = j.recordHealthSample([TGT("disconnected", { reason: "exit 1" })], { atMs: T0 });
  assert.deepEqual(e1, [], "抗抖动：单次采样不落事件");
  const e2 = j.recordHealthSample([TGT("disconnected", { reason: "exit 1" })], { atMs: T0 + 45000 });
  assert.equal(e2.length, 1, "连续 2 次一致才确认");
  assert.equal(e2[0].state, "disconnected");
  assert.equal(e2[0].at, T0 + 45000);
  assert.equal(e2[0].reason, "exit 1");
}

function testDisconnectThenRecover() {
  const j = createDashboardJournal(tmpFile());
  j.recordHealthSample([TGT("connected")], { atMs: T0 });
  j.recordHealthSample([TGT("connected")], { atMs: T0 + 1 });
  j.recordHealthSample([TGT("disconnected")], { atMs: T0 + 2 });
  const down = j.recordHealthSample([TGT("disconnected")], { atMs: T0 + 3 });
  assert.equal(down.length, 1);
  j.recordHealthSample([TGT("connected")], { atMs: T0 + 4 });
  const up = j.recordHealthSample([TGT("connected")], { atMs: T0 + 5 });
  assert.equal(up.length, 1);
  assert.equal(up[0].state, "connected");
  assert.equal(j.getHealthEvents().length, 2);
}

function testFlapDoesNotRecord() {
  const j = createDashboardJournal(tmpFile());
  j.recordHealthSample([TGT("connected")], { atMs: T0 });
  j.recordHealthSample([TGT("connected")], { atMs: T0 + 1 });
  j.recordHealthSample([TGT("disconnected")], { atMs: T0 + 2 }); // 单次抖动
  const back = j.recordHealthSample([TGT("connected")], { atMs: T0 + 3 });
  assert.deepEqual(back, []);
  assert.deepEqual(j.getHealthEvents(), [], "重启窗抖动不刷屏");
}

function testRepeatedFailureRecordedOnce() {
  const j = createDashboardJournal(tmpFile());
  for (let i = 0; i < 5; i++) j.recordHealthSample([TGT("disconnected")], { atMs: T0 + i });
  assert.equal(j.getHealthEvents().length, 1);
}

function testUnknownStateIgnored() {
  const j = createDashboardJournal(tmpFile());
  j.recordHealthSample([TGT("connected")], { atMs: T0 });
  j.recordHealthSample([TGT("connected")], { atMs: T0 + 1 });
  j.recordHealthSample([TGT("unknown")], { atMs: T0 + 2 }); // starting 窗（R130）→ 不参与
  j.recordHealthSample([TGT("disconnected")], { atMs: T0 + 3 });
  const ev = j.recordHealthSample([TGT("disconnected")], { atMs: T0 + 4 });
  assert.equal(ev.length, 1, "unknown 不打断连续计数也不落事件");
}

function testRestartDetection() {
  const file = tmpFile();
  const j1 = createDashboardJournal(file);
  j1.recordHealthSample([TGT("connected")], { atMs: T0 });
  j1.recordHealthSample([TGT("connected")], { atMs: T0 + 1 });
  // 模拟关闭期间后端挂了 → 新实例首次确认到 disconnected
  const j2 = createDashboardJournal(file);
  j2.recordHealthSample([TGT("disconnected")], { atMs: T0 + 100000 });
  const ev = j2.recordHealthSample([TGT("disconnected")], { atMs: T0 + 145000 });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].detectedAfterRestart, true, "关闭期间的变化标「检测到」");
  assert.equal(ev[0].at, T0 + 145000, "不伪造实际发生时间");
}

function testPersistenceRoundtrip() {
  const file = tmpFile();
  const j1 = createDashboardJournal(file);
  j1.recordHealthSample([TGT("disconnected", { reason: "boom" })], { atMs: T0 });
  j1.recordHealthSample([TGT("disconnected", { reason: "boom" })], { atMs: T0 + 1 });
  j1.setKanbanCursor("hermes:default", 2010);
  const j2 = createDashboardJournal(file);
  assert.equal(j2.getHealthEvents().length, 1, "事件跨实例恢复");
  assert.equal(j2.getKanbanCursor("hermes:default"), 2010, "cursor 跨实例恢复");
  assert.equal(j2.getKanbanCursor("hermes:bull"), undefined);
}

function testPruneCountAndAge() {
  const file = tmpFile();
  const j = createDashboardJournal(file, { now: () => T0 + 8 * 24 * 3600 * 1000 });
  // 1005 条交替事件（同一目标反复断连/恢复），其中最早 3 条已超 7 天
  for (let i = 0; i < 1005; i++) {
    const state = i % 2 === 0 ? "disconnected" : "connected";
    const at = i < 3 ? T0 + i : T0 + 24 * 3600 * 1000 + i; // 前 3 条落在 8 天前
    j.recordHealthSample([TGT(state)], { atMs: at });
    j.recordHealthSample([TGT(state)], { atMs: at });
  }
  const events = j.getHealthEvents();
  assert.ok(events.length <= 1000, `上限 1000，实际 ${events.length}`);
  assert.ok(events.every((e) => e.at >= T0 + 24 * 3600 * 1000 - 7 * 24 * 3600 * 1000 + 1), "7 天外裁剪");
  const j2 = createDashboardJournal(file, { now: () => T0 + 8 * 24 * 3600 * 1000 });
  assert.ok(j2.getHealthEvents().length <= 1000);
}

function testCorruptFileRecovers() {
  const file = tmpFile();
  fs.writeFileSync(file, "{ not json !!!", "utf8");
  const j = createDashboardJournal(file);
  assert.deepEqual(j.getHealthEvents(), [], "损坏文件不阻断启动");
  const backups = fs.readdirSync(path.dirname(file)).filter((f) => f.includes("corrupt"));
  assert.equal(backups.length, 1, "损坏文件先备份再置空");
  // 还能继续正常写
  j.recordHealthSample([TGT("disconnected")], { atMs: T0 });
  j.recordHealthSample([TGT("disconnected")], { atMs: T0 + 1 });
  assert.equal(j.getHealthEvents().length, 1);
}

function testAtomicWriteAndMode() {
  const file = tmpFile();
  const j = createDashboardJournal(file);
  j.recordHealthSample([TGT("disconnected")], { atMs: T0 });
  j.recordHealthSample([TGT("disconnected")], { atMs: T0 + 1 });
  const st = fs.statSync(file);
  assert.equal(st.mode & 0o777, 0o600, "权限 0600");
  assert.ok(!fs.readdirSync(path.dirname(file)).some((f) => f.endsWith(".tmp")), "无 tmp 残留");
  JSON.parse(fs.readFileSync(file, "utf8")); // 可解析
}

function testWriteFailureDegradesToMemory() {
  const blocker = tmpFile("iamafile");
  fs.writeFileSync(blocker, "x", "utf8");
  const j = createDashboardJournal(path.join(blocker, "journal.json")); // 父路径是文件 → 写必败
  j.recordHealthSample([TGT("disconnected")], { atMs: T0 });
  const ev = j.recordHealthSample([TGT("disconnected")], { atMs: T0 + 1 });
  assert.equal(ev.length, 1, "写失败不影响内存态记录（磁盘满病史）");
  assert.equal(j.getHealthEvents().length, 1);
  j.setKanbanCursor("hermes:default", 5); // 也不抛
  assert.equal(j.getKanbanCursor("hermes:default"), 5);
}

function testReasonSanitized() {
  const j = createDashboardJournal(tmpFile());
  const dirty = "✗ no web dist found at https://internal.example.com/secret?token=abc\nBearer sk-XYZ\n第三行";
  j.recordHealthSample([TGT("disconnected", { reason: dirty })], { atMs: T0 });
  const ev = j.recordHealthSample([TGT("disconnected", { reason: dirty })], { atMs: T0 + 1 });
  const reason = ev[0].reason;
  assert.ok(!reason.includes("\n"), "只留首行");
  assert.ok(!reason.includes("https://"), "URL 清洗");
  assert.ok(!reason.includes("sk-XYZ"), "后续行的疑似凭证不落盘");
  assert.ok(reason.length <= 200);
}

function testMultiTargetIndependent() {
  const j = createDashboardJournal(tmpFile());
  const bull = TGT("disconnected", { targetType: "profile-dashboard", targetId: "hermes:bull", backendId: "hermes" });
  const horse = TGT("connected", { targetType: "profile-dashboard", targetId: "hermes:horse", backendId: "hermes" });
  j.recordHealthSample([bull, horse], { atMs: T0 });
  const ev = j.recordHealthSample([bull, horse], { atMs: T0 + 1 });
  assert.equal(ev.length, 1, "bull 断连记录、horse 首次正常静默");
  assert.equal(ev[0].targetId, "hermes:bull");
}

// ---- kanban 事件留存（cursor 前进后当天事件不丢：重启后动态仍完整） ----

const ROW = (id, created_at, kind = "created") => ({ id, task_id: `t${id}`, run_id: null, kind, created_at });

function testKanbanEventsAppendAndReload() {
  const file = tmpFile();
  const j1 = createDashboardJournal(file);
  j1.appendKanbanEvents("hermes:default", [ROW(1, 1783900801), ROW(2, 1783900802)], { dayStartMs: T0 });
  j1.setKanbanCursor("hermes:default", 2);
  const j2 = createDashboardJournal(file);
  assert.equal(j2.getKanbanEvents("hermes:default").length, 2, "重启后当天事件留存");
  assert.equal(j2.getKanbanCursor("hermes:default"), 2);
  assert.deepEqual(j2.getKanbanEvents("hermes:bull"), []);
}

function testKanbanEventsPrunedToDayAndDeduped() {
  const j = createDashboardJournal(tmpFile());
  j.appendKanbanEvents("hermes:default", [ROW(1, 1783900800 - 3600)], { dayStartMs: T0 }); // 昨天
  j.appendKanbanEvents("hermes:default", [ROW(2, 1783900802), ROW(2, 1783900802), ROW(3, 1783900803)], { dayStartMs: T0 });
  const rows = j.getKanbanEvents("hermes:default");
  assert.deepEqual(rows.map((r) => r.id), [2, 3], "跨天裁剪 + 按事件 id 去重");
}

function testKanbanEventsCapped() {
  const j = createDashboardJournal(tmpFile());
  const many = Array.from({ length: 2100 }, (_, i) => ROW(i + 1, 1783900801 + i));
  j.appendKanbanEvents("hermes:default", many, { dayStartMs: T0 });
  const rows = j.getKanbanEvents("hermes:default");
  assert.equal(rows.length, 2000, "每 profile 上限 2000（保最新）");
  assert.equal(rows[rows.length - 1].id, 2100);
}

const tests = [
  testFirstHealthySilent, testFirstFailureRecordedAfterTwoSamples, testDisconnectThenRecover,
  testFlapDoesNotRecord, testRepeatedFailureRecordedOnce, testUnknownStateIgnored,
  testRestartDetection, testPersistenceRoundtrip, testPruneCountAndAge,
  testCorruptFileRecovers, testAtomicWriteAndMode, testWriteFailureDegradesToMemory,
  testReasonSanitized, testMultiTargetIndependent,
  testKanbanEventsAppendAndReload, testKanbanEventsPrunedToDayAndDeduped, testKanbanEventsCapped,
];

let failed = 0;
for (const t of tests) {
  try {
    t();
    console.log(`  ✅ ${t.name}`);
  } catch (e) {
    failed++;
    console.log(`  ❌ ${t.name}: ${e.message}`);
  }
}
console.log(failed ? `FAILED ${failed}/${tests.length}` : `PASS ${tests.length}/${tests.length}`);
process.exit(failed ? 1 : 0);
