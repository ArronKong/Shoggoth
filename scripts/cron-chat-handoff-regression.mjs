#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const uiRoot = path.join(root, "app/manage-ui");
const requireFromUi = createRequire(path.join(uiRoot, "package.json"));
const esbuild = requireFromUi("esbuild");
const failures = [];

function check(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function installSessionStorage(initialValue = null, failures = {}) {
  let value = initialValue;
  const calls = { get: 0, remove: 0, set: 0 };
  globalThis.sessionStorage = {
    getItem() {
      calls.get += 1;
      if (failures.get) throw new Error("get failed");
      return value;
    },
    removeItem() {
      calls.remove += 1;
      if (failures.remove) throw new Error("remove failed");
      value = null;
    },
    setItem(_key, next) {
      calls.set += 1;
      if (failures.set) throw new Error("set failed");
      value = next;
    },
  };
  return { calls, value: () => value };
}

async function compileTarget(relativePath, name) {
  const dir = fs.mkdtempSync(path.join(uiRoot, ".cron-chat-handoff-"));
  const outfile = path.join(dir, `${name}.cjs`);
  await esbuild.build({
    entryPoints: [path.join(root, relativePath)],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    logLevel: "silent",
  });
  return {
    mod: createRequire(outfile)(outfile),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

const helperPath = path.join(uiRoot, "src/lib/cronChatHandoff.ts");
assert.ok(fs.existsSync(helperPath), "必须提供 Cron 报告聊天 handoff 共享工具");

const compiled = await compileTarget(
  "app/manage-ui/src/lib/cronChatHandoff.ts",
  "cron-chat-handoff",
);
try {
  const {
    canonicalCronSessionKey,
    consumeCronChatHandoff,
    firstNonBlankText,
    selectCronRunHandoffSource,
    writeCronChatHandoff,
  } = compiled.mod;

  check("OpenClaw 完整 key trim 后保持 canonical", () => {
    assert.equal(canonicalCronSessionKey(" ada ", "  agent:ada:cron:run-42  "), "agent:ada:cron:run-42");
  });
  check("Hermes 裸 ID 与 agentId trim 后归一化", () => {
    assert.equal(canonicalCronSessionKey(" hermes-worker ", " run-session-42 "), "agent:hermes-worker:run-session-42");
  });
  check("空值和空白值不回退 main", () => {
    assert.equal(canonicalCronSessionKey("ada", undefined), null);
    assert.equal(canonicalCronSessionKey("ada", "   "), null);
    assert.equal(canonicalCronSessionKey("   ", "raw-session"), null);
  });
  check("畸形完整 key 被拒绝", () => {
    assert.equal(canonicalCronSessionKey("ada", "agent:"), null);
    assert.equal(canonicalCronSessionKey("ada", "agent::x"), null);
    assert.equal(canonicalCronSessionKey("ada", "agent:ada:   "), null);
  });
  check("共享正文选择跳过空白并保留原文", () => {
    assert.equal(firstNonBlankText(undefined, "   ", "  summary body  "), "  summary body  ");
    assert.equal(firstNonBlankText(null, "", " \n "), null);
  });

  check("write 先清旧 handoff 再写实际正文", () => {
    const storage = installSessionStorage(JSON.stringify({ sessionKey: "agent:ada:x", report: "old" }));
    writeCronChatHandoff("agent:ada:x", "  report body  ");
    assert.equal(storage.calls.remove, 1);
    assert.deepEqual(JSON.parse(storage.value()), { sessionKey: "agent:ada:x", report: "  report body  " });
  });
  check("write 失败不会遗留旧同 session 正文", () => {
    const storage = installSessionStorage(JSON.stringify({ sessionKey: "agent:ada:x", report: "old" }), { set: true });
    writeCronChatHandoff("agent:ada:x", "new");
    assert.equal(storage.value(), null);
  });
  check("write 清旧值失败时不覆盖", () => {
    const storage = installSessionStorage("old", { remove: true });
    writeCronChatHandoff("agent:ada:x", "new");
    assert.equal(storage.calls.set, 0);
  });
  check("write 清旧失败后恢复也不消费旧同 session payload", () => {
    const storageFailures = { remove: true };
    const storage = installSessionStorage(
      JSON.stringify({ sessionKey: "agent:ada:x", report: "old" }),
      storageFailures,
    );
    writeCronChatHandoff("agent:ada:x", "new");
    storageFailures.remove = false;
    assert.equal(consumeCronChatHandoff("agent:ada:x"), null);
    assert.equal(storage.value(), null);
  });

  check("consume 返回精确匹配的非空 payload 并消费", () => {
    const storage = installSessionStorage(JSON.stringify({ sessionKey: "agent:ada:x", report: " report " }));
    assert.deepEqual(consumeCronChatHandoff("agent:ada:x"), { sessionKey: "agent:ada:x", report: " report " });
    assert.equal(storage.value(), null);
  });
  check("consume 对不匹配 key 只消费不应用", () => {
    const storage = installSessionStorage(JSON.stringify({ sessionKey: "agent:ada:y", report: "report" }));
    assert.equal(consumeCronChatHandoff("agent:ada:x"), null);
    assert.equal(storage.value(), null);
  });
  check("consume 拒绝 malformed 和运行时类型错误", () => {
    let storage = installSessionStorage("{bad json");
    assert.equal(consumeCronChatHandoff("agent:ada:x"), null);
    assert.equal(storage.value(), null);
    storage = installSessionStorage(JSON.stringify({ sessionKey: "agent:ada:x", report: "   " }));
    assert.equal(consumeCronChatHandoff("agent:ada:x"), null);
    assert.equal(storage.value(), null);
    storage = installSessionStorage(JSON.stringify(["agent:ada:x", "report"]));
    assert.equal(consumeCronChatHandoff("agent:ada:x"), null);
    assert.equal(storage.value(), null);
  });
  check("consume remove 失败时不应用 payload", () => {
    const storage = installSessionStorage(JSON.stringify({ sessionKey: "agent:ada:x", report: "report" }), { remove: true });
    assert.equal(consumeCronChatHandoff("agent:ada:x"), null);
    assert.notEqual(storage.value(), null);
  });
  check("consume get 失败时安全降级", () => {
    installSessionStorage(null, { get: true });
    assert.equal(consumeCronChatHandoff("agent:ada:x"), null);
  });

  const openRun = {
    agentId: "hermes-worker",
    startedAt: 1000,
    sessionKey: "historical-session",
    summary: "historical summary",
  };
  check("Dashboard 精确同运行时优先 delivery", () => {
    assert.deepEqual(
      selectCronRunHandoffSource(openRun, {
        startedAt: 1000,
        sessionKey: "delivery-session",
        summary: "delivery summary",
        fullText: "delivery full text",
      }),
      { sessionKey: "agent:hermes-worker:delivery-session", report: "delivery full text", isFullText: true },
    );
  });
  check("Dashboard 空白 fullText 回退 delivery summary", () => {
    assert.deepEqual(
      selectCronRunHandoffSource(openRun, {
        startedAt: 1000,
        sessionKey: "delivery-session",
        summary: "  delivery summary  ",
        fullText: "   ",
      }),
      { sessionKey: "agent:hermes-worker:delivery-session", report: "  delivery summary  ", isFullText: false },
    );
  });
  check("Dashboard 空白 delivery summary 回退 openRun summary", () => {
    assert.deepEqual(
      selectCronRunHandoffSource(openRun, {
        startedAt: 1000,
        sessionKey: "delivery-session",
        summary: " \n ",
        fullText: null,
      }),
      { sessionKey: "agent:hermes-worker:delivery-session", report: "historical summary", isFullText: false },
    );
  });
  check("Dashboard delivery 时间不匹配时保持历史 run", () => {
    assert.deepEqual(
      selectCronRunHandoffSource(openRun, {
        startedAt: 2000,
        sessionKey: "latest-session",
        fullText: "latest report",
      }),
      { sessionKey: "agent:hermes-worker:historical-session", report: "historical summary", isFullText: false },
    );
  });
  check("Dashboard delivery 时间无法确认时保持历史 run", () => {
    assert.deepEqual(
      selectCronRunHandoffSource(openRun, {
        sessionKey: "unknown-session",
        fullText: "unknown report",
      }),
      { sessionKey: "agent:hermes-worker:historical-session", report: "historical summary", isFullText: false },
    );
  });
} finally {
  compiled.cleanup();
  delete globalThis.sessionStorage;
}

const cron = fs.readFileSync(path.join(uiRoot, "src/pages/CronPage.tsx"), "utf8");
const dashboard = fs.readFileSync(path.join(uiRoot, "src/pages/DashboardPage.tsx"), "utf8");
const chat = fs.readFileSync(path.join(uiRoot, "src/pages/ChatPage.tsx"), "utf8");

check("Cron 使用共享正文选择器与 canonical key", () => {
  assert.match(cron, /canonicalCronSessionKey\(deliveryJob\?\.agentId, delivery\?\.sessionKey\)/);
  assert.match(cron, /firstNonBlankText\(delivery\?\.fullText, delivery\?\.summary\)/);
  assert.match(cron, /writeCronChatHandoff\(backendId, sessionKey, report\)/);
  assert.match(cron, /backend=\$\{encodeURIComponent\(backendId\)\}&session=\$\{encodeURIComponent\(sessionKey\)\}/);
  assert.match(cron, /deliverySessionKey && deliveryReport/);
});

check("Dashboard 正文与 session 共用同运行 handoff selector", () => {
  assert.match(dashboard, /selectCronRunHandoffSource\(openRun, delivery\)/);
  assert.match(dashboard, /const visibleRunText = runHandoff\.report;/);
  assert.match(dashboard, /runHandoff\.isFullText \? t\("dashboard\.fullTextTitle"\) : t\("dashboard\.summaryTitle"\)/);
  assert.match(dashboard, /writeCronChatHandoff\(backendId, sessionKey, report\)/);
  assert.match(dashboard, /backend=\$\{encodeURIComponent\(backendId\)\}&session=\$\{encodeURIComponent\(sessionKey\)\}/);
  assert.match(dashboard, /runSessionKey && visibleRunText && visibleRunText\.trim\(\)/);
  assert.match(dashboard, /t\("cron\.askInChat"\)/);
  assert.match(dashboard, /t\("dashboard\.openInCron"\)/);
});

const deepLinkEffect = chat.match(
  /useEffect\(\(\) => \{\s*if \(routerLocation\.pathname !== "\/chat"\)([\s\S]*?)\n  \}, \[routerLocation, routerNavigate\]\);/,
)?.[1] || "";
check("Chat 深链同步 location guard 且复用 consume helper", () => {
  assert.ok(deepLinkEffect, "必须找到 Chat session 深链 effect");
  assert.match(
    deepLinkEffect,
    /const locationIdentity = `\$\{routerLocation\.key\}:\$\{routerLocation\.search\}`;/,
  );
  assert.match(deepLinkEffect, /locationIdentity[\s\S]*?handledSessionLocationRef\.current === locationIdentity/);
  assert.match(deepLinkEffect, /handledSessionLocationRef\.current = locationIdentity/);
  assert.match(deepLinkEffect, /consumeCronChatHandoff\(deepLinkBackend \|\| backendOfSession\(key\), key\)/);
  assert.doesNotMatch(deepLinkEffect, /sessionStorage\.(?:getItem|removeItem)/);
  assert.match(deepLinkEffect, /setQuote\(\{ key, text: handoff\.report \}\)/);
  assert.match(deepLinkEffect, /openChatSessionLink\(key, \{/);
  assert.match(deepLinkEffect, /ensureSession: \(\) => ensure\(key, undefined, deepLinkBackend \? \{ backendId: deepLinkBackend \} : undefined\)/);
  assert.match(deepLinkEffect, /openSession: \(targetKey\) => openSessionDeepRef\.current\(targetKey\)/);
  assert.match(deepLinkEffect, /refreshSessions: refreshList/);
  assert.match(deepLinkEffect, /onOpened: \(\) => \{/);
  assert.doesNotMatch(deepLinkEffect, /chat\.send/);
  assert.doesNotMatch(chat, /agent:\$\{parsed\.agentId\}:main/);
});

check("Chat 自动落位以 activeKeyRef 同步值为准", () => {
  const autoLandEffect = chat.match(
    /useEffect\(\(\) => \{\s*if \(activeKeyRef\.current \|\| agents\.length === 0\) return;([\s\S]*?)\n  \}, \[agents, activeKey, chatHistoryController\]\);/,
  )?.[1] || "";
  assert.ok(autoLandEffect, "自动落位 effect 必须检查 activeKeyRef.current");
  assert.match(autoLandEffect, /chatHistoryController\.bootstrap\(/);
});

if (failures.length > 0) {
  console.error(`cron chat handoff regression: FAIL (${failures.length})`);
  process.exitCode = 1;
} else {
  console.log("cron chat handoff regression: PASS");
}
