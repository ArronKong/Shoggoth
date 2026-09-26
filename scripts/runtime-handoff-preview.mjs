#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const repo = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(repo, "package.json"));
const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 2 && args[0] === "--output" && path.isAbsolute(args[1])), "usage: --output /absolute/new-directory");
const output = args[1] || path.join(repo, ".artifacts/runtime-v2-s6-preview/handoff-continuous");
assert.ok(!fs.existsSync(output), "output directory must be new; retain any earlier attempt");
fs.mkdirSync(output, { recursive: true, mode: 0o700 });
const root = fs.mkdtempSync("/tmp/sghui-");
// No inherited credentials, proxy, installed paths or Electron AS_NODE mode.
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, { HOME: root, TMPDIR: root, TMP: root, TEMP: root,
  PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, LANG: "en_US.UTF-8",
  CODEX_HOME: path.join(root, ".codex"), PI_CODING_AGENT_DIR: path.join(root, ".pi", "agent"),
  ELECTRON_DISABLE_SECURITY_WARNINGS: "true" });
const { openHandoffFixture } = require("./scripts/fixtures/runtime-handoff-service.cjs");
const { descendantIdentities, stillOwned, killOwnedProcesses } = require("./scripts/runtime-v2-live-acceptance.cjs");
const { build } = createRequire(path.join(repo, "app/manage-ui/package.json"))("esbuild");
let fixture, server, child, interval, timeout, killTimeout;
let childExited = false, outcome, failure, origin;
const owned = new Map(), requests = [], rounds = [];
const cleanup = {};
try {
  fixture = await openHandoffFixture({ root });
  for (const value of Object.values(fixture.paths)) {
    if (typeof value === "string" && path.isAbsolute(value)) assert.ok(value === root || value.startsWith(`${root}/`), "Service paths remain isolated");
  }
  const session = fixture.createSession();
  fixture.service.chatSessionStore.setModelOverride(session.sessionKey, "fixture-needs-explicit-clear");
  const gatewayKey = `agent:${fixture.profile.agentId}:${session.sessionKey}`;
  const state = () => {
    const current = fixture.service.chatSessionStore.getSession(session.sessionKey);
    assert.equal(current.id, session.id); assert.equal(current.profileId, session.profileId);
    const binding = fixture.service.productStore.getAgentRuntimeBinding(session.profileId, current.runtimeBindingId);
    return { agentId: fixture.profile.agentId, profileId: current.profileId, sessionId: current.id, gatewayKey,
      revision: current.revision, runtime: binding.runtime, nativeSessionId: current.runtimeSessionId,
      retiredCount: current.retiredRuntimeSessions.length,
      messages: fixture.service.transcriptStore.listEvents(current.profileId, current.id)
        .filter(event => event.kind === "user" || event.kind === "assistant")
        .map(event => ({ id: event.id, kind: event.kind, text: event.content.text })) };
  };
  await build({ entryPoints: [path.join(repo, "scripts/fixtures/runtime-handoff-preview.tsx")], bundle: true,
    format: "esm", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' },
    loader: { ".woff2": "dataurl", ".svg": "dataurl" }, outfile: path.join(root, "fixture.js"),
    nodePaths: [path.join(repo, "app/manage-ui/node_modules")], logLevel: "silent" });
  fs.writeFileSync(path.join(root, "index.html"), '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script type="module" src="fixture.js"></script>');
  const json = (res, body, status = 200) => { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(body)); };
  server = http.createServer(async (req, res) => {
    try {
      assert.equal(req.headers.host, new URL(origin).host, "fixture Host");
      if (req.method !== "GET") assert.equal(req.headers.origin, origin, "fixture writes require same Origin");
      const url = new URL(req.url, origin), base = `/__api/agents/${encodeURIComponent(fixture.profile.agentId)}`;
      requests.push({ method: req.method, path: url.pathname });
      if (req.method === "GET" && ["/", "/fixture.js", "/fixture.css"].includes(url.pathname)) {
        const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
        res.setHeader("Content-Type", name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : "text/html");
        res.end(fs.readFileSync(path.join(root, name))); return;
      }
      if (req.method === "GET" && url.pathname === "/__fixture/state") { json(res, state()); return; }
      if (req.method === "POST" && url.pathname === "/__fixture/send") {
        const index = rounds.length;
        assert.ok(index < 4, "only four local turns permitted");
        const run = await fixture.send(session.sessionKey, `ui-chain-${index}`, `UI HISTORY MARKER ${index}`);
        assert.equal(run.status, "running", run.errorCode);
        await fixture.complete(run, `UI FIXTURE ANSWER ${index}`);
        rounds.push({ runtime: run.runtimeSessionRef.runtime, nativeSessionId: run.runtimeSessionRef.sessionId });
        json(res, state()); return;
      }
      assert.equal(url.searchParams.get("backend"), "fixture");
      if (req.method === "GET" && url.pathname === `${base}/runtime-bindings`) {
        json(res, { ...fixture.service.productStore.getAgentRuntimeBindings(session.profileId), canAdd: false }); return;
      }
      if (["GET", "PUT"].includes(req.method) && url.pathname === `${base}/session-runtime`) {
        assert.equal(url.searchParams.get("sessionKey"), gatewayKey);
        let body = "";
        for await (const chunk of req) { body += chunk; assert.ok(body.length < 32768); }
        const params = { profileId: session.profileId, sessionKey: session.sessionKey,
          ...(req.method === "PUT" ? JSON.parse(body) : {}) };
        const acquired = fixture.transport.acquisitions.length;
        const snapshot = await fixture.controller.handle(req.method === "PUT" ? "chat.session.runtime.switch" : "chat.session.runtime.get", params);
        assert.equal(fixture.transport.acquisitions.length, acquired, "menu action never dispatches native work");
        json(res, snapshot); return;
      }
      json(res, { error: "fixture route unavailable" }, 404);
    } catch (error) { json(res, { error: error.message, code: error.code || "PREVIEW_FIXTURE_FAILED" }, 409); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  assert.ok(![18790, 18792, 18799, 18801].includes(server.address().port), "never uses an installed/default port");
  console.log(JSON.stringify({ evidence: "preview-with-local-Service-fixture", authority: root, origin, realProvider: false }));
  child = spawn(require("electron"), [path.join(repo, "scripts/fixtures/runtime-handoff-preview-electron.cjs"), origin, root, output],
    { env: process.env, cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { if (log.length < 128000) log += chunk.toString(); });
  const track = () => { for (const record of descendantIdentities(child.pid)) owned.set(record.pid, record); };
  track(); interval = setInterval(track, 300);
  timeout = setTimeout(() => { child.kill("SIGTERM"); killTimeout = setTimeout(() => child.kill("SIGKILL"), 3000); }, 55_000);
  const exit = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => { childExited = true; resolve({ code, signal }); }); });
  clearInterval(interval); clearTimeout(timeout); clearTimeout(killTimeout);
  fs.writeFileSync(path.join(output, "electron.log"), log, { flag: "wx" });
  assert.deepEqual(exit, { code: 0, signal: null }, `Electron DOM preview failed; see ${path.join(output, "electron.log")}`);
  const renderer = JSON.parse(fs.readFileSync(path.join(output, "renderer.json"), "utf8"));
  assert.deepEqual(rounds.map(round => round.runtime), ["codex", "pi", "deepseek-harness", "codex"]);
  assert.notEqual(rounds[0].nativeSessionId, rounds[3].nativeSessionId);
  const codex = fixture.transport.hosts.get("codex");
  assert.equal(codex.threadStartCalls, 2); assert.equal(codex.resumeCalls, 0);
  const events = fixture.service.transcriptStore.listEvents(session.profileId, session.id);
  const auditCount = events.filter(event => event.content.transcriptType === "runtime.switched").length;
  assert.equal(auditCount, 3); assert.equal(state().messages.length, 8);
  assert.equal(requests.filter(request => request.method === "PUT").length, 3);
  assert.equal(fixture.service.workRunCoordinator.getMemoryStats().runHostAssignments, 0);
  outcome = { status: "passed", evidence: "source-preview-real-React-and-Service-local-fixture", createdAt: new Date().toISOString(),
    naturalExit: exit, origin, renderer, rounds, auditCount, codexThreadStarts: codex.threadStartCalls,
    codexResumes: codex.resumeCalls, sameAgentAndConversation: true, originalTranscriptMessagesPreserved: true,
    finalMessageCount: 8, requestCounts: { switches: 3, fixtureTurns: 4 },
    boundary: "Production SessionRuntimeControl/client/Controller/Coordinator/Product12/Chat7/Transcript; fixture HTTP route, native Host, encryption and transcript frame. No Provider, installed App or production REST/IPC verification.",
    realProvider: false, installedAppAccess: false };
} catch (error) { failure = error; }
finally {
  clearInterval(interval); clearTimeout(timeout); clearTimeout(killTimeout);
  if (child?.pid && !childExited) { try { for (const record of descendantIdentities(child.pid)) owned.set(record.pid, record); } catch {} }
  cleanup.remainingOwnedBeforeCleanup = [...owned.values()].filter(stillOwned).length;
  cleanup.remainingOwnedAfterCleanup = await killOwnedProcesses([...owned.values()]);
  if (child?.pid && !childExited) { child.kill("SIGKILL"); await new Promise(resolve => child.once("close", resolve)); }
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  cleanup.previewServerClosed = !server?.listening;
  if (fixture) { await fixture.close(); cleanup.serviceStopped = true; }
  fs.rmSync(root, { recursive: true, force: true }); cleanup.temporaryAuthorityRemoved = !fs.existsSync(root);
}
assert.equal(cleanup.remainingOwnedAfterCleanup, 0, "owned Electron process cleanup");
fs.writeFileSync(path.join(output, "result.json"), JSON.stringify({ ...(outcome || { status: "failed", error: failure?.message }), cleanup }, null, 2) + "\n", { flag: "wx" });
if (failure) throw failure;
console.log(JSON.stringify({ status: outcome.status, naturalExit: outcome.naturalExit, cleanup, output }));
