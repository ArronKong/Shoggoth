#!/usr/bin/env node
"use strict";

// Opt-in real-provider acceptance. Credentials remain inside the existing
// Service. Only newly created image-test chats and workspaces are touched.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { pathToFileURL } = require("node:url");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const { resolveCanonicalServicePaths } = require("../app/agent-service/paths");
const { readClientToken, requestService } = require("../app/agent-service/client");
const { imageReferences } = require("../app/core/session-image-media");
const { PNG } = require("./fixtures/native-agent-images.cjs");

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const digest = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const safeCode = error => /^[A-Z][A-Z0-9_]{0,100}$/.test(error?.code || "") ? error.code : "ACCEPTANCE_FAILED";
const operationId = () => `image-acceptance-${crypto.randomUUID()}`;
const terminal = new Set(["completed", "failed", "canceled", "interrupted", "skipped"]);
const args = process.argv.slice(2);
const option = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : null; };
const progress = value => console.log(JSON.stringify(value));

async function run() {
  if (option("--mode") !== "live") {
    progress({ mode: "plan", providerCalls: 0, credentialFilesRead: false,
      scope: "One new isolated image-reply chat per enabled native Agent, sequentially, using its current model.",
      acceptance: "Real Service history, assistant-only image references, exact HTTP bytes and rendered ChatPage interaction.",
      requires: "--mode live --output <new absolute directory>" });
    return;
  }
  const output = option("--output");
  const resume = args.includes("--resume");
  if (!output || !path.isAbsolute(output) || (fs.existsSync(output) && !resume)) throw Object.assign(Error(), { code: "NEW_OUTPUT_DIRECTORY_REQUIRED" });
  const previousResults = resume ? JSON.parse(fs.readFileSync(path.join(output, "results.json"), "utf8")).results : [];
  if (resume && previousResults.some(result => result.operationId || result.runId)) throw Object.assign(Error(), { code: "PRE_SUBMISSION_RESUME_ONLY" });
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  const backend = new ShoggothBackend({ paths: resolveCanonicalServicePaths(), readToken: readClientToken, requestService });
  const before = await backend._page("profile.list", { backendId: "shoggoth", enabledOnly: false }, "profiles");
  const order = ["CodeX", "Shoggoth", "Pi", "Grok", "DeepSeek", "OpenCode", "Antigravity"];
  const profiles = before.filter(profile => profile.enabled && (!option("--agent") || profile.agentId === option("--agent")))
    .sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
  if (!profiles.length) throw Object.assign(Error(), { code: "NO_ENABLED_AGENT" });
  const evidence = { version: 1, date: "2026-10-07", mode: "real-provider", service: "existing-installed-app",
    imageSource: "current-workspace-source", installedAppReplaced: false, beforeProfileDigest: digest(before),
    results: [], skippedDisabled: before.filter(p => !p.enabled).map(p => ({ agentId: p.agentId, name: p.name })),
    startedAt: new Date().toISOString() };
  const write = () => fs.writeFileSync(path.join(output, "results.json"), JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 });
  let current;
  let interrupted = false;
  const interrupt = () => { interrupted = true; };
  process.on("SIGTERM", interrupt);
  process.on("SIGINT", interrupt);
  try {
    for (const profile of profiles) {
      if (interrupted) break;
      const workspace = path.join(output, "workspaces", profile.agentId);
      fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
      const png = path.join(workspace, "中文 图片(验收).png");
      const svg = path.join(workspace, "preview.svg");
      fs.writeFileSync(png, PNG);
      fs.writeFileSync(svg, `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="360"><rect width="800" height="360" rx="24" fill="#dae5ee"/><circle cx="160" cy="160" r="90" fill="#4e7597"/><path d="M310 300 460 70 650 300Z" fill="#d78850"/><text x="32" y="332" font-family="sans-serif" font-size="22" fill="#243b50">${profile.name} real model image reply</text></svg>`);
      const result = { name: profile.name, agentId: profile.agentId, profileId: profile.id, runtime: profile.runtime,
        runtimeAccountId: profile.runtimeAccountId, workspace, status: "preparing", startedAt: new Date().toISOString() };
      evidence.results.push(result); write(); current = result;
      backend._profilesByAgent.set(profile.agentId, profile);
      progress({ agent: profile.name, runtime: profile.runtime, stage: "create-isolated-chat" });
      try {
        const draft = previousResults.find(item => item.profileId === profile.id);
        if (draft) {
          const sessions = await backend._page("chat.session.list", { profileId: profile.id, includeArchived: false }, "sessions");
          const session = sessions.find(item => item.sessionKey === draft.sessionId && item.workspace === workspace && item.status === "draft");
          if (!session) throw Object.assign(Error(), { code: "OWNED_DRAFT_REQUIRED" });
          backend._upsertSession(profile, session);
          result.key = `agent:${profile.agentId}:${session.sessionKey}`;
        } else result.key = await backend.createSession(profile.agentId, { workspace });
        result.sessionId = result.key.split(":").at(-1);
        const reply = `![中文路径](<${png}>)\n\n![文件URL](${pathToFileURL(png).href})\n\n![宽图](./preview.svg)`;
        const prompt = `这是 Shoggoth App 图片显示验收。本会话工作区已有两张测试图片。请直接发送下面三张图片，保持 Markdown 图片语法和路径原样；不要加代码围栏。只回复这些图片和一句“图片验收”。不要执行工具、不要访问其他文件、不要更改设置或记忆。\n\n${reply}`;
        result.operationId = operationId(); result.stage = "chat.send"; write();
        let sent;
        try {
          sent = await backend._call("chat.send", { operationId: result.operationId, sessionKey: result.sessionId, prompt, createdAt: Date.now() });
        } catch (error) {
          if (!["REQUEST_TIMEOUT", "SERVICE_DISCONNECTED", "INCOMPLETE_RESPONSE"].includes(error?.code)) throw error;
          // Never replay a possibly accepted provider call.
          const recovery = await backend._call("chat.operation.get", { operationId: result.operationId, sessionKey: result.sessionId });
          if (!recovery?.run) throw error;
          sent = { run: recovery.run };
        }
        result.runId = sent.run.id; result.status = sent.run.status; write();
        const deadline = Date.now() + 180_000;
        let run = sent.run, previous = null;
        while (!terminal.has(run.status) && !interrupted && Date.now() < deadline) {
          if (run.status !== previous) { previous = run.status; progress({ agent: profile.name, stage: "provider-turn", status: run.status }); }
          if (["waiting_approval", "waiting_input"].includes(run.status)) break;
          await pause(1500);
          run = (await backend._call("run.get", { runId: result.runId })).run;
        }
        result.runStatus = run.status;
        result.errorCode = run.errorCode;
        result.runtimeSession = run.runtimeSessionRef;
        result.runtimeTurn = run.runtimeTurnRef;
        if (!terminal.has(run.status)) {
          result.status = interrupted ? "interrupted" : run.status.startsWith("waiting_") ? run.status : "timed_out";
          await backend._call("chat.abort", { operationId: operationId(), sessionKey: result.sessionId, runId: result.runId, createdAt: Date.now() });
        } else if (run.status !== "completed") {
          result.status = "provider_failed";
        } else {
          await backend.renameSession(result.key, `图片验收 2026-10-07 · ${profile.name}`);
          const history = await backend.getHistory(result.key);
          const delivered = history.messages.filter(message => message.role === "assistant").flatMap(message => {
            const text = typeof message.content === "string" ? message.content : (message.content || [])
              .filter(part => part.type === "text").map(part => part.text).join("\n");
            return imageReferences(text);
          });
          result.imageRefs = [...new Set(delivered)];
          result.assistantImages = result.imageRefs.length;
          result.reads = [];
          for (const ref of result.imageRefs) {
            const image = await backend.readSessionImage(result.key, ref);
            result.reads.push({ ref, loaded: !!image, mimeType: image?.mimeType, bytes: image?.bytes.length,
              sha256: image ? crypto.createHash("sha256").update(image.bytes).digest("hex") : null });
          }
          const owned = backend._sessionsByKey.get(result.sessionId);
          result.session = owned;
          fs.writeFileSync(path.join(workspace, "history.json"), JSON.stringify(history, null, 2) + "\n", { mode: 0o600 });
          result.status = result.assistantImages >= 3 && result.reads.every(read => read.loaded) ? "provider_and_bytes_passed" : "image_reply_failed";
          try { const state = await backend._call("chat.session.runtime.get", { profileId: profile.id, sessionKey: result.sessionId }); result.model = state.model; } catch { result.model = null; }
        }
      } catch (error) { result.status = "failed"; result.errorCode = safeCode(error); }
      result.finishedAt = new Date().toISOString(); write(); current = null;
      progress({ agent: result.name, runtime: result.runtime, status: result.status, model: result.model ?? null,
        runId: result.runId, images: result.assistantImages ?? 0, errorCode: result.errorCode ?? null });
    }
  } finally {
    if (current?.runId && !terminal.has(current.runStatus)) {
      try { await backend._call("chat.abort", { operationId: operationId(), sessionKey: current.sessionId, runId: current.runId, createdAt: Date.now() }); } catch {}
    }
    const after = await backend._page("profile.list", { backendId: "shoggoth", enabledOnly: false }, "profiles");
    evidence.profilesUnchanged = digest(after) === evidence.beforeProfileDigest;
    evidence.finishedAt = new Date().toISOString(); write();
    process.off("SIGTERM", interrupt); process.off("SIGINT", interrupt);
    progress({ complete: true, results: evidence.results.length, profilesUnchanged: evidence.profilesUnchanged, output });
  }
}
if (require.main === module) run().catch(error => { progress({ errorCode: safeCode(error) }); process.exitCode = 1; });
