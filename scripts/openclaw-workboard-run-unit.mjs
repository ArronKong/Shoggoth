#!/usr/bin/env node
// KAN-009: autonomous 始终走带稳定 per-card sessionKey/idempotencyKey 的
// gateway agent RPC；manual 才创建或复用普通会话。
// 运行：node scripts/openclaw-workboard-run-unit.mjs

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { OpenClawBackend } = require("../app/core/openclaw-backend.js");

const results = [];
const check = (name, cond) => { results.push({ name, ok: !!cond }); if (!cond) process.exitCode = 1; };

function backendWith(card, opts = {}) {
  const be = new OpenClawBackend({ getConfig: () => ({}) });
  const rpc = [];
  let currentCard = structuredClone(card);
  be._connect = async () => {};
  be.request = async (method, params) => {
    rpc.push({ method, params });
    if (method === "workboard.cards.list") return { cards: [currentCard], statuses: undefined };
    if (method === "workboard.cards.update") {
      currentCard = { ...currentCard, ...params.patch, updatedAt: (currentCard.updatedAt || 1000) + 1 };
      return { card: currentCard };
    }
    if (method === "agent") {
      return { sessionKey: params.sessionKey, runId: "r-agent", runStarted: true };
    }
    if (method === "tasks.list") {
      return {
        tasks: [{
          id: "task-agent", taskId: "task-agent", status: "running",
          sessionKey: be._wbSessionKeyFor(currentCard), runId: "r-agent", updatedAt: 2000,
        }],
        nextCursor: null,
      };
    }
    if (method === "sessions.create") {
      if (opts.createConflicts) throw new Error("label already in use");
      return { key: "agent:main:new-sess", runId: "r-new", runStarted: true };
    }
    if (method === "sessions.list") {
      return { sessions: [{ key: "agent:main:old-sess", label: `${card.title} (${String(card.id).slice(0, 8)})` }] };
    }
    return {};
  };
  return { be, rpc };
}

const CARD_FRESH = { id: "card-12345678", title: "部署监控", status: "todo", labels: [] };
const CARD_WITH_SESSION = {
  ...CARD_FRESH,
  execution: { id: "card-12345678:claude", kind: "agent-session", engine: "claude", mode: "manual", status: "idle", sessionKey: "agent:main:old-sess" },
};

// 1. autonomous 首跑直接走 agent，并使用 deterministic per-card session。
{
  const { be, rpc } = backendWith(CARD_FRESH);
  const r = await be.runTaskCard("card-12345678", { engine: "claude", mode: "autonomous" });
  const call = rpc.find((c) => c.method === "agent");
  check("autonomous 首跑走 agent RPC", !!call && !rpc.some((c) => c.method === "sessions.create" || c.method === "chat.send"));
  check("autonomous 使用固定 per-card session", call?.params?.sessionKey === "subagent:workboard-default-card-12345678" && r.sessionKey === call.params.sessionKey);
  check("autonomous 带稳定 idempotencyKey", call?.params?.idempotencyKey === "workboard:default:card-12345678:1001");
  check("autonomous 返回并回写 runId", r.runId === "r-agent" && rpc.some((c) => c.method === "workboard.cards.update" && c.params?.patch?.runId === "r-agent"));
}

// 2. 卡片已有旧普通会话时 autonomous 仍使用 deterministic per-card session。
{
  const { be, rpc } = backendWith(CARD_WITH_SESSION);
  const r = await be.runTaskCard("card-12345678", { engine: "claude", mode: "autonomous" });
  const call = rpc.find((c) => c.method === "agent");
  check("autonomous 不走旧 create/send 路径", !!call && !rpc.some((c) => c.method === "sessions.create" || c.method === "chat.send"));
  check("autonomous 不复用不匹配的普通 session", call?.params?.sessionKey === "subagent:workboard-default-card-12345678" && r.sessionKey === call.params.sessionKey);
  check("autonomous 仍回写卡片 execution", rpc.some((c) => c.method === "workboard.cards.update" && c.params?.patch?.execution?.sessionKey === call?.params?.sessionKey));
}

// 3. manual 固定 label 冲突时查重复用，不启动 autonomous agent。
{
  const { be, rpc } = backendWith(CARD_WITH_SESSION, { createConflicts: true });
  await be.runTaskCard("card-12345678", { engine: "claude", mode: "manual" });
  check("manual 冲突后查重复用且不启动 agent", rpc.some((c) => c.method === "sessions.create") && rpc.some((c) => c.method === "sessions.list") && !rpc.some((c) => c.method === "agent"));
  check("manual 复用回写卡片", rpc.some((c) => c.method === "workboard.cards.update"));
}

// 4. manual create 撞 label（execution 丢失但会话还在）→ sessions.list 查重复用。
{
  const { be, rpc } = backendWith(CARD_FRESH, { createConflicts: true });
  const r = await be.runTaskCard("card-12345678", { engine: "claude", mode: "manual" });
  check("撞 label 后按 label 查重", rpc.some((c) => c.method === "sessions.list"));
  check("查重命中后仅复用会话", r.sessionKey === "agent:main:old-sess" && !rpc.some((c) => c.method === "chat.send" || c.method === "agent"));
}

for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`RESULT ${results.length - failed}/${results.length} pass`);
process.exit(failed ? 1 : 0);
