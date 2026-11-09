"use strict";

// 2026-11-06 OpenClaw parity, real Runtime acceptance (suite "parity" of the
// repair live worker). Runs inside the worker's disposable HOME with only
// synthetic facts. Checks the whole automatic loop on one native CLI:
// a stated preference and project fact -> a new conversation captures the
// previous one as an excerpt that the next conversation answers from -> the
// Agent keeps a working note in today's daily note -> the nightly pass reviews
// the day with the Agent's own model -> the CLI's own memory stays unused.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const SCENARIOS = ["parity-chat", "parity-excerpt", "parity-daily-note", "parity-nightly", "parity-native-off"];

function filesUnder(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile())
    .map(entry => path.relative(directory, path.join(entry.parentPath ?? entry.path, entry.name))).sort();
}

async function waitFor(predicate, ms = 20000) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() > deadline) return false;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

async function runParity({ service, profile, root, runtime, result, send, scenario, productCall, check, redact }) {
  result.scenarios = Object.fromEntries(SCENARIOS.map(name => [name, { status: "not_run" }]));
  // Conversations opened through chat.session.create start in the product's
  // default "auto-review" mode, which needs a workspace-write slot. The
  // repair profile has none; give the disposable workspace one so the real
  // creation path (and its excerpt hook) is what runs. Background memory work
  // uses the Agent's default model, as for every configured Agent.
  const { AGENT_PROFILE_FIELDS } = require("../app/agent-service/product-store");
  const current = service.productStore.getAgentProfile(profile.id);
  service.productStore.putAgentProfile({ ...Object.fromEntries(AGENT_PROFILE_FIELDS.map(field => [field, current[field]])),
    defaultModel: result.model, concurrency: { ...current.concurrency, maxWorkspaceWrites: 1 } });
  const marker = `QINGNIAO${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
  const workspace = service.memoryStore.workspace(profile.id);
  const read = relative => { try { return fs.readFileSync(path.join(workspace, relative), "utf8"); } catch { return ""; } };
  const dailyText = () => filesUnder(path.join(workspace, "memory")).filter(name => /^\d{4}-\d{2}-\d{2}\.md$/u.test(name))
    .map(name => read(path.join("memory", name))).join("\n");
  const nativeMemory = { "grok-build": path.join(root, ".grok", "memory-v2"), codex: path.join(root, ".codex", "memories") }[runtime] || null;
  const nativeBefore = nativeMemory ? filesUnder(nativeMemory) : [];
  const newSession = async () => {
    const created = await productCall("chat.session.create", { profileId: profile.id, operationId: crypto.randomUUID(),
      workspace: profile.defaultCwd, createdAt: Date.now() });
    return service.chatSessionStore.setModelOverride(created.session.sessionKey, result.model);
  };

  let first, second;
  await scenario("parity-chat", async () => {
    first = await newSession();
    const turn = await send(first, `以后给我的回答都先给一句话结论，再展开细节。另外我们今天定了：发布代号叫 ${marker}，周四上午冻结代码。先简单确认一下就好。`, "parity-chat");
    return { tools: turn.tools, answer: redact(turn.answer).slice(0, 2000) };
  });

  await scenario("parity-excerpt", async () => {
    second = await newSession();
    const captured = await waitFor(() => service.memoryStore.list(profile.id, { status: "active" })
      .some(item => item.id.startsWith("session-excerpt-") && item.content.includes(marker)));
    check(captured, "EXCERPT_NOT_CAPTURED");
    check(dailyText().includes(marker), "EXCERPT_NOT_IN_DAILY_NOTE");
    const turn = await send(second, "我们在上一个对话里定的发布代号是什么？哪天冻结代码？只回答这两项。", "parity-excerpt");
    // The excerpt itself reached the new conversation's injected memory.
    const memoryBlock = turn.material.flatMap(value => value.blocks || []).filter(block => block.id === "memory")
      .map(block => block.content || "").join("\n");
    check(memoryBlock.includes("Session excerpt") && memoryBlock.includes(marker), "EXCERPT_NOT_IN_CONTEXT");
    check(turn.answer.includes(marker), "EXCERPT_NOT_RECALLED");
    return { tools: turn.tools, excerptInContext: true, answer: redact(turn.answer).slice(0, 2000) };
  });

  await scenario("parity-daily-note", async () => {
    const note = `${marker}-SMOKE`;
    const turn = await send(second, `把这条记到你今天的工作笔记里（只是今天的进行中事项，不是长期记忆）：发布前要先跑 ${note} 冒烟测试。`, "parity-daily-note");
    const saved = result.toolCalls.some(call => call.runId === turn.run.id && call.name === "memory_save" && call.status === "completed");
    const inDaily = dailyText().split("\n").some(line => line.includes(note) && !/^- (?:User|Assistant): /u.test(line.trim()));
    const inMemory = read("MEMORY.md").includes(note);
    check(saved && (inDaily || inMemory), "WORKING_NOTE_NOT_SAVED");
    return { tools: turn.tools, placement: inDaily ? "daily" : "long-term" };
  });

  await scenario("parity-nightly", async () => {
    const before = { user: read("USER.md"), memory: read("MEMORY.md") };
    const attempts = [];
    const nightly = async () => {
      await service.memoryEngine.maintenance.beforeDream(profile.id, new AbortController().signal);
      const last = service.memoryEngine.host(profile.id).database.db
        .prepare("SELECT value FROM memory_state WHERE namespace='active-memory-diagnostics' AND value IS NOT NULL").all()
        .map(row => JSON.parse(row.value)).filter(row => row.stage === "memory-review").sort((a, b) => a.at - b.at).at(-1) || null;
      attempts.push({ outcome: last?.outcome ?? null, code: last?.code ?? null, liveRuntimes: true });
      return last;
    };
    let last = await nightly();
    // A night normally finds chat Runtimes idle. When the model-only worker
    // cannot start beside a live chat worker, record it and retry once with
    // the chat workers stopped, so both conditions are reported.
    if (last?.outcome === "error" && /STARTUP_TIMEOUT|BUSY|LOCK/u.test(last.code || "")) {
      await service.runtimeManager.stopAll();
      last = await nightly(); attempts.at(-1).liveRuntimes = false;
    }
    const outcome = last?.outcome ?? null;
    check(["saved", "nothing-saved"].includes(outcome), `NIGHTLY_REVIEW_${String(outcome || "missing").toUpperCase().replaceAll("-", "_")}_${last?.code || "NONE"}`);
    const after = { user: read("USER.md"), memory: read("MEMORY.md") };
    return { outcome, attempts, userChanged: after.user !== before.user, memoryChanged: after.memory !== before.memory,
      user: redact(after.user).slice(0, 4000), memory: redact(after.memory).slice(0, 4000) };
  });

  await scenario("parity-native-off", async () => {
    const added = nativeMemory ? filesUnder(nativeMemory).filter(name => !nativeBefore.includes(name)) : [];
    check(added.length === 0, "NATIVE_MEMORY_WRITTEN");
    return { checkedPath: nativeMemory ? path.relative(root, nativeMemory) : null, addedFiles: added.length };
  });
}

module.exports = { runParity, PARITY_SCENARIOS: SCENARIOS };
