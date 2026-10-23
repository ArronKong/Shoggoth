"use strict";

// Regression for the 0.8.237 Antigravity failure ANTIGRAVITY_MCP_UNAVAILABLE.
// The official ACP server takes the Shoggoth MCP descriptor at session/new, but
// its harness launches the helper only when the first prompt runs. Under load a
// session recovery and setup took 61 s, so the prompt went out after
// the 45 s harness-child ticket was issued, so the helper was refused. The
// server recorded "failed to construct executor: MCP load failed for shoggoth:
// [bootstrap] startup failure: BOOTSTRAP_ROLE_REJECTED". The refusal reason was
// lost because the bootstrap fell through to the Codex parent checks.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { test } = require("node:test");
const { main } = require("../app/bootstrap-role");
const { summarizeBootstrapError } = require("../app/bootstrap-diagnostics");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { RuntimeMcpGateIssuer } = require("../app/agent-service/runtime-mcp-gate");
const { AntigravityAcpRuntimeHost } = require("../app/agent-service/antigravity-acp-runtime-host");

const FAKE_SERVER = path.join(__dirname, "fixtures", "antigravity-acp-server.cjs");
const ACCOUNT = "native-antigravity-default-v1";
const HARNESS_PID = 424_242;
// 2026-10-21: starting at 09:45:24.615, prompt accepted at 09:46:25.698.
const INCIDENT_GAP_MS = 61_000;

function fakeClock(start) {
  let now = start;
  const timers = [];
  return {
    now: () => now,
    setTimeout(callback, ms) {
      const timer = { due: now + ms, callback, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) { if (timer) timer.cleared = true; },
    advance(ms) {
      now += ms;
      for (;;) {
        const due = timers.filter((timer) => !timer.cleared && timer.due <= now)
          .sort((left, right) => left.due - right.due)[0];
        if (!due) return;
        due.cleared = true;
        due.callback();
      }
    },
  };
}

function fixture(t, env = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-agy-lazy-")));
  fs.chmodSync(root, 0o700);
  const paths = resolveServicePaths({ homeDir: root });
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  const bin = path.join(root, "bin");
  for (const directory of [paths.stateDir, home, workspace, bin]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  const serverPath = path.join(bin, "agy_acp_server.par");
  const harnessPath = path.join(bin, "localharness_external");
  const helper = path.join(bin, "Shoggoth");
  for (const file of [serverPath, harnessPath, helper]) fs.writeFileSync(file, "#!/bin/sh\n", { mode: 0o755 });
  const bootstrap = path.join(root, "app.asar", "app", "bootstrap.js");
  fs.mkdirSync(path.dirname(bootstrap), { recursive: true });
  fs.writeFileSync(bootstrap, "bootstrap\n", { mode: 0o600 });
  fs.mkdirSync(path.join(home, ".gemini", "antigravity-acp"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home, ".gemini", "antigravity-acp", "settings.json"),
    JSON.stringify({ auth: { type: "oauth-personal" } }), { mode: 0o600 });
  const log = path.join(root, "server.jsonl");
  const clock = fakeClock(10_000);
  const ctx = { root, paths, workspace, serverPath, harnessPath, clock, host: null };
  ctx.issuer = new RuntimeMcpGateIssuer({
    paths,
    mcpHelperLaunch: { command: helper, argsPrefix: [] },
    bootstrapPath: bootstrap,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    getProcessIdentity: (pid) => (pid === ctx.host?.child?.pid ? "fake-acp-server-start" : ""),
    getProcessLink: (pid) => (pid === HARNESS_PID
      ? { ppid: ctx.host.child.pid, executable: fs.realpathSync(harnessPath) }
      : { ppid: 0, executable: "" }),
  }).open();
  ctx.host = new AntigravityAcpRuntimeHost({
    paths,
    runtimeProfileId: "shoggoth-antigravity-cli-v1",
    runtimeAccountId: ACCOUNT,
    runtimeEnvironment: Object.freeze({
      runtime: "antigravity", runtimeAccountId: ACCOUNT, kind: "native-user", installationKind: "system",
      homeKind: "integration", strategy: "account-integration", home, nativeHome: path.join(root, "native", ".gemini"),
      configSourceHome: null, integrationRoot: root, binaryPath: serverPath, launchArgs: Object.freeze([]),
      spawnEnv: Object.freeze({ HOME: home }), configurationMode: "integration",
    }),
    permissionPolicy: { approvalPolicy: "on-request", sandbox: "workspace-write" },
    workspace,
    platform: "linux",
    parentEnv: { PATH: process.env.PATH },
    verifyServer: async () => ({ version: "1.2.1", serverPath, harnessPath }),
    spawnProcess: (command, args, options) => spawn(process.execPath, [FAKE_SERVER, ...args],
      { ...options, env: { ...options.env, ...env, FAKE_ACP_LOG: log } }),
    mcpGateIssuer: ctx.issuer,
    requestTimeoutMs: 3_000,
    acceptanceTimeoutMs: 3_000,
    shutdownGraceMs: 500,
    killGraceMs: 200,
    profileState: {},
  });
  ctx.records = () => fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  ctx.descriptor = () => {
    const created = ctx.records().filter((entry) => ["session/new", "session/resume"].includes(entry.method)).at(-1);
    return created.params.mcpServers[0];
  };
  t.after(async () => {
    try { await ctx.host.stop(); } catch {}
    ctx.issuer.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return ctx;
}

// What the signed harness does when the server runs the first prompt: start the
// configured helper, which validates its ticket and asks the Service to consume it.
async function launchHelperFromHarness(ctx, descriptor = ctx.descriptor()) {
  const env = Object.fromEntries(descriptor.env.map(({ name, value }) => [name, value]));
  let consumed = null;
  await main(descriptor.args, env, {
    defaultApp: true,
    ppid: HARNESS_PID,
    now: ctx.clock.now,
    userInfo: () => ({ homedir: ctx.root }),
    parent: { executable: fs.realpathSync(ctx.harnessPath), command: ctx.harnessPath, ppid: ctx.host.child.pid },
    ancestor: { executable: fs.realpathSync(ctx.serverPath) },
    openRuntimeMcpBridge: async (context) => {
      consumed = ctx.issuer.consume({
        runtimeProfileId: context.runtimeProfileId,
        runtimeAccountId: context.runtimeAccountId,
        gatePath: context.gatePath,
        nonce: context.nonce,
        parentPid: context.parentPid,
      });
      return Object.freeze({ tag: "bridge" });
    },
  }, { runtimeMcpRelay: () => "relay-started" });
  return consumed;
}

async function startSession(ctx) {
  await ctx.host.initialize();
  return (await ctx.host.sessionStart({ source: "chat:lazy-mcp", cwd: ctx.workspace,
    permissionMode: "accept-edits" })).session;
}

function sendPrompt(ctx, session, operationId) {
  return ctx.host.turnStart({ sessionId: session.id, operationId, prompt: "hello", cwd: ctx.workspace });
}

async function until(predicate) {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "fixture event did not arrive");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function reservation(ctx) {
  const env = Object.fromEntries(ctx.descriptor().env.map(({ name, value }) => [name, value]));
  return { reservationId: env.SHOGGOTH_RUNTIME_MCP_GATE_NONCE, gatePath: env.SHOGGOTH_RUNTIME_MCP_GATE_FILE };
}

function rejectedWith(reason) {
  return (error) => error?.code === "BOOTSTRAP_ROLE_REJECTED" && error.cause?.code === reason;
}

test("a session/new slower than the ticket TTL still lets the first prompt start the Shoggoth MCP helper", async (t) => {
  const ctx = fixture(t);
  const session = await startSession(ctx);
  ctx.clock.advance(INCIDENT_GAP_MS);
  await sendPrompt(ctx, session, "op-incident-gap");
  assert.deepEqual(await launchHelperFromHarness(ctx), { consumed: true },
    "the harness starts the helper at the first prompt; its ticket must be valid then");
  await assert.rejects(launchHelperFromHarness(ctx), rejectedWith("RUNTIME_MCP_GATE_MISSING"),
    "the renewed ticket remains one-shot");
});

test("an unprompted ticket lapses and the helper refusal keeps its reason", async (t) => {
  const ctx = fixture(t);
  await startSession(ctx);
  const descriptor = ctx.descriptor();
  const gatePath = descriptor.env.find((entry) => entry.name === "SHOGGOTH_RUNTIME_MCP_GATE_FILE").value;
  ctx.clock.advance(44_000);
  assert.equal(fs.existsSync(gatePath), true);
  ctx.clock.advance(1_500);
  // The file is still on disk until the expiry timer runs; the deadline decides.
  const expired = await launchHelperFromHarness(ctx, descriptor).catch((error) => error);
  assert.ok(rejectedWith("RUNTIME_MCP_GATE_EXPIRED")(expired), `expired ticket: ${expired?.cause?.code}`);
  assert.equal(summarizeBootstrapError(expired).some((entry) => entry.code === "RUNTIME_MCP_GATE_EXPIRED"), true,
    "the persisted bootstrap diagnostics name the gate reason, not only BOOTSTRAP_ROLE_REJECTED");
  ctx.clock.advance(1_000);
  assert.equal(fs.existsSync(gatePath), false, "a lapsed ticket leaves no usable file behind");
  await assert.rejects(launchHelperFromHarness(ctx, descriptor), rejectedWith("RUNTIME_MCP_GATE_MISSING"));
});

test("a helper started from another process tree is still refused after renewal", async (t) => {
  const ctx = fixture(t);
  const session = await startSession(ctx);
  ctx.clock.advance(INCIDENT_GAP_MS);
  await sendPrompt(ctx, session, "op-foreign-parent");
  const descriptor = ctx.descriptor();
  const env = Object.fromEntries(descriptor.env.map(({ name, value }) => [name, value]));
  // main() refuses a role synchronously; wrap it so the refusal is observed.
  await assert.rejects(async () => main(descriptor.args, env, {
    defaultApp: true,
    ppid: HARNESS_PID,
    now: ctx.clock.now,
    userInfo: () => ({ homedir: ctx.root }),
    parent: { executable: fs.realpathSync(ctx.harnessPath), command: ctx.harnessPath, ppid: ctx.host.child.pid + 1 },
    ancestor: { executable: fs.realpathSync(ctx.serverPath) },
    openRuntimeMcpBridge: async () => { throw new Error("must not reach the Service"); },
  }, { runtimeMcpRelay: () => "relay-started" }), rejectedWith("RUNTIME_MCP_GATE_PARENT_MISMATCH"));
});

test("MCP renewal happens after queued ACP writes, at the prompt write boundary", async (t) => {
  const ctx = fixture(t), session = await startSession(ctx);
  let release;
  ctx.host.rpc.writeTail = new Promise(resolve => { release = resolve; });
  const accepted = sendPrompt(ctx, session, "op-blocked-write");
  await until(() => ctx.host.activeTurns.size === 1);
  ctx.clock.advance(INCIDENT_GAP_MS);
  assert.equal(fs.existsSync(reservation(ctx).gatePath), false);
  release();
  await accepted;
  assert.deepEqual(await launchHelperFromHarness(ctx), { consumed: true });
});

test("cancel, process restart and delayed resume use a fresh one-shot ticket for the same session", async (t) => {
  const ctx = fixture(t), session = await startSession(ctx);
  const old = reservation(ctx);
  const accepted = await ctx.host.turnStart({ sessionId: session.id, operationId: "op-cancel",
    prompt: "DIRECTIVE:SILENT", cwd: ctx.workspace });
  await launchHelperFromHarness(ctx);
  await ctx.host.turnInterrupt({ sessionId: session.id, turnId: accepted.turn.id });
  assert.equal(ctx.host.ledger.snapshot().sessions[0].turns[0].status, "canceled");
  await ctx.host.stop();
  assert.throws(() => ctx.issuer.renewMcpServer(old), { code: "RUNTIME_MCP_GATE_INVALID" });
  ctx.host = new AntigravityAcpRuntimeHost({ ...ctx.host.options, ledgerSlot: { promise: null } });
  await ctx.host.initialize();
  await ctx.host.sessionResume({ sessionId: session.id, cwd: ctx.workspace, permissionMode: "accept-edits" });
  assert.notEqual(reservation(ctx).reservationId, old.reservationId);
  ctx.clock.advance(INCIDENT_GAP_MS);
  await sendPrompt(ctx, session, "op-resumed");
  assert.deepEqual(await launchHelperFromHarness(ctx), { consumed: true });
  assert.equal(ctx.host.ledger.snapshot().sessions.length, 1, "no replacement conversation or replay");
});

test("revoked, expired, replaced and PID-reused reservations fail before any prompt bytes are sent", async (t) => {
  for (const kind of ["revoked", "window-expired", "replaced", "pid-reused"]) {
    await t.test(kind, async t => {
      const ctx = fixture(t), session = await startSession(ctx), ticket = reservation(ctx);
      if (kind === "revoked") ctx.issuer.revokeMcpServer(ticket);
      if (kind === "window-expired") ctx.clock.advance(10 * 60_000);
      if (kind === "replaced") {
        fs.renameSync(ticket.gatePath, ticket.gatePath + ".original");
        fs.writeFileSync(ticket.gatePath, "foreign file", { mode: 0o600 });
      }
      if (kind === "pid-reused") ctx.issuer.getProcessIdentity = () => "different-acp-process";
      await assert.rejects(sendPrompt(ctx, session, "op-refused"), { code: "ANTIGRAVITY_MCP_UNAVAILABLE" });
      assert.equal(ctx.records().some(entry => entry.method === "session/prompt"), false);
      const turn = ctx.host.ledger.snapshot().sessions[0].turns[0];
      assert.deepEqual([turn.dispatchState, turn.acceptance, turn.status], ["not_sent", "failed", "failed"]);
      assert.equal(ctx.host.activeTurns.size, 0);
      await assert.rejects(sendPrompt(ctx, session, "op-refused-retry"), { code: "ANTIGRAVITY_MCP_UNAVAILABLE" },
        "a new operation on the same broken MCP session must remain unsent");
      assert.equal(ctx.records().some(entry => entry.method === "session/prompt"), false);
      if (kind === "replaced") assert.equal(fs.readFileSync(ticket.gatePath, "utf8"), "foreign file");
    });
  }
});

test("an eager consumption is recognized without reviving its ticket, and stop revokes its receipt", async (t) => {
  const ctx = fixture(t), session = await startSession(ctx), ticket = reservation(ctx);
  await launchHelperFromHarness(ctx);
  ctx.clock.advance(INCIDENT_GAP_MS);
  await sendPrompt(ctx, session, "op-eager-helper");
  assert.equal(fs.existsSync(ticket.gatePath), false);
  await assert.rejects(launchHelperFromHarness(ctx), rejectedWith("RUNTIME_MCP_GATE_MISSING"));
  await ctx.host.stop();
  assert.throws(() => ctx.issuer.renewMcpServer(ticket), { code: "RUNTIME_MCP_GATE_INVALID" });
});

test("a failed receipt write after renewal keeps the unused ticket renewable for a delayed retry", async (t) => {
  const ctx = fixture(t), session = await startSession(ctx);
  const update = ctx.host.ledger.update.bind(ctx.host.ledger);
  let failOnce = true;
  ctx.host.ledger.update = mutate => update(data => {
    mutate(data);
    if (failOnce && data.sessions[0].turns.at(-1)?.dispatchState === "write_attempted") {
      failOnce = false;
      throw Object.assign(new Error("injected receipt write failure"), { code: "EIO" });
    }
  });
  await assert.rejects(sendPrompt(ctx, session, "op-receipt-failure"), { code: "EIO" });
  assert.equal(ctx.records().some(entry => entry.method === "session/prompt"), false);
  ctx.clock.advance(INCIDENT_GAP_MS);
  await sendPrompt(ctx, session, "op-receipt-retry");
  assert.deepEqual(await launchHelperFromHarness(ctx), { consumed: true });
});

test("session setup failures and a stopped unprompted host revoke their unused reservations", async (t) => {
  const failed = fixture(t, { FAKE_ACP_NEW_ERROR: "network" });
  await assert.rejects(startSession(failed), { code: "ANTIGRAVITY_NETWORK_UNAVAILABLE" });
  const failedTicket = reservation(failed);
  assert.equal(fs.existsSync(failedTicket.gatePath), false);
  assert.throws(() => failed.issuer.renewMcpServer(failedTicket), { code: "RUNTIME_MCP_GATE_INVALID" });
  const stopped = fixture(t);
  await startSession(stopped);
  const stoppedTicket = reservation(stopped);
  await stopped.host.stop();
  assert.equal(fs.existsSync(stoppedTicket.gatePath), false);
  assert.throws(() => stopped.issuer.renewMcpServer(stoppedTicket), { code: "RUNTIME_MCP_GATE_INVALID" });
});
