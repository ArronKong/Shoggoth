#!/usr/bin/env node
"use strict";

// Explicit, opt-in live smoke against the official Antigravity ACP server, driven
// through the production Pool, resolver and host in an isolated state directory.
// It reuses the Google sign-in already in the macOS keychain (run Settings sign-in
// first) and never opens a browser. Each run makes a handful of real model calls.
//
//   node scripts/antigravity-acp-live-smoke.cjs --live [--tool-results-only] [--server-dir <dir with the two 1.2.1 files>] [--keep]
//
// Without --server-dir the pinned archive (about 107 MB) is downloaded and verified.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  ANTIGRAVITY_ACP_SERVER_VERSION,
  installAntigravityAcpServer,
} = require("../app/agent-service/antigravity-acp-distribution");
const { AntigravityRuntimePool } = require("../app/agent-service/antigravity-runtime-pool");
const { NATIVE_ANTIGRAVITY_RUNTIME_ACCOUNT_ID } = require("../app/agent-service/runtime-account");

const MCP_HELPER = path.join(__dirname, "fixtures", "antigravity-live-mcp.cjs");
const BINDING = Object.freeze({ runtime: "antigravity", runtimeProfileId: "acp-live-smoke",
  runtimeAccountId: NATIVE_ANTIGRAVITY_RUNTIME_ACCOUNT_ID });
const POLICY = Object.freeze({ approvalPolicy: "on-request", sandbox: "workspace-write" });

async function until(predicate, label, timeout = 180_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${label}`);
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function installServer(paths) {
  const source = argument("--server-dir");
  if (!source) {
    console.log(`downloading the pinned ACP server ${ANTIGRAVITY_ACP_SERVER_VERSION}…`);
    await installAntigravityAcpServer({ paths });
    return;
  }
  const target = path.join(paths.stateDir, "runtime-bin", "antigravity-acp", ANTIGRAVITY_ACP_SERVER_VERSION);
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const name of ["agy_acp_server.par", "localharness_external"]) {
    // Request a copy-on-write clone where supported; verify its hash and signature.
    fs.copyFileSync(path.join(source, name), path.join(target, name), fs.constants.COPYFILE_FICLONE);
    fs.chmodSync(path.join(target, name), 0o755);
  }
}

function createPool(paths, gate) {
  return new AntigravityRuntimePool({
    paths, homedir: os.homedir(), parentEnv: process.env,
    acceptanceTimeoutMs: 90_000, promptTimeoutMs: 5 * 60_000, requestTimeoutMs: 90_000,
    mcpGateIssuer: gate,
  });
}

async function main() {
  if (!process.argv.includes("--live")) throw new Error("Pass --live to run the authenticated ACP smoke");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-agy-acp-live-")));
  fs.chmodSync(root, 0o700);
  const paths = { stateDir: path.join(root, "state"), trustedRoot: root };
  const workspace = path.join(root, "workspace");
  for (const directory of [paths.stateDir, workspace]) fs.mkdirSync(directory, { mode: 0o700 });
  await installServer(paths);
  // Select the existing Google sign-in for this isolated integration Home; the
  // credentials themselves stay in the keychain.
  const acpHome = path.join(paths.stateDir, "runtime-integration", "antigravity",
    NATIVE_ANTIGRAVITY_RUNTIME_ACCOUNT_ID, "home", ".gemini", "antigravity-acp");
  fs.mkdirSync(acpHome, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(acpHome, "settings.json"), JSON.stringify({ auth: { type: "oauth-personal" } }), { mode: 0o600 });

  const nonce = crypto.randomBytes(4).toString("hex");
  const toolResultsOnly = process.argv.includes("--tool-results-only");
  const word = `ZEBRA-${nonce}`;
  const mcpOut = path.join(root, "mcp.jsonl");
  const gateCalls = [];
  const gate = { createMcpServer: async (input) => {
    gateCalls.push(input);
    return { name: "shoggoth", command: process.execPath, args: [MCP_HELPER],
      env: [{ name: "SMOKE_MCP_OUT", value: mcpOut }, { name: "SMOKE_MCP_NONCE", value: nonce },
        ...(toolResultsOnly ? [{ name: "SMOKE_MCP_TOOL_RESULTS", value: "1" }] : [])] };
  } };
  const results = [];
  const record = (step, value) => { results.push({ step, ...value }); console.log(`${step}: ${JSON.stringify(value)}`); };
  let pool = createPool(paths, gate);
  try {
    const control = await pool.get(BINDING, { permissionPolicy: POLICY });
    assert.deepEqual(await control.authenticationState(), { authenticated: true, credentialPresent: true },
      "sign in from Settings first: the keychain has no usable Google sign-in");
    const models = (await control.modelsList()).data.map((model) => model.model);
    assert.ok(models.length > 0 && models.every((model) => typeof model === "string"));
    record("models", { models });

    const host = await pool.get(BINDING, { workspace, permissionPolicy: POLICY });
    const events = [];
    host.subscribe((event) => events.push(event));
    if (toolResultsOnly) {
      host.subscribe((event) => fs.appendFileSync(path.join(root, "normalized.jsonl"), `${JSON.stringify(event)}\n`, { mode: 0o600 }));
      host.rpc.subscribe((message) => {
        if (message.method === "session/update") fs.appendFileSync(path.join(root, "acp.jsonl"), `${JSON.stringify(message)}\n`, { mode: 0o600 });
      });
    }
    let decide = null;
    const asked = [];
    host.registerServerRequestHandler("item/commandExecution/requestApproval", async (params) => {
      asked.push(params);
      return decide(params);
    });
    const session = (await host.sessionStart({ source: `acp-live-${nonce}`, cwd: workspace,
      permissionMode: "accept-edits" })).session;
    const turn = async (step, prompt, { choose = () => ({ decision: "cancel" }), interruptAfterMs = null } = {}) => {
      decide = choose;
      const before = asked.length;
      const started = Date.now();
      const accepted = (await host.turnStart({ sessionId: session.id, cwd: workspace, operationId: `live-${step}`,
        permissionMode: "accept-edits", prompt })).turn;
      if (interruptAfterMs !== null) {
        // The turn is controllable as soon as the server has the prompt, while the model still thinks.
        await new Promise((resolve) => setTimeout(resolve, interruptAfterMs));
        await host.turnInterrupt({ sessionId: session.id, turnId: accepted.id });
      }
      const complete = await until(() => events.find((event) => event.turnId === accepted.id && event.type === "complete"), step);
      const text = events.filter((event) => event.turnId === accepted.id && event.type === "text").map((event) => event.text).join("");
      const approvals = asked.slice(before).map((params) => params.approvalOptions.map((option) => `${option.choice}:${option.kind}`));
      record(step, { status: complete.status, errorCode: complete.errorCode ?? null, ms: Date.now() - started,
        text: text.slice(0, 160), approvals });
      return { complete, text, approvals, turnId: accepted.id };
    };

    if (toolResultsOnly) {
      const marker = path.join(workspace, "marker.txt");
      const token = `ACP_NATIVE_READ-${nonce}`;
      fs.writeFileSync(marker, `${token}\n`, { mode: 0o600 });
      const probe = await turn("native-tool-results", `This is an isolated tool transport test. First use view_file to read ${marker}. Then call the shoggoth MCP tool ping once, then probe_error once. Finally report the marker, ping output and simulated failure. Use no desktop, terminal, network or other tools.`,
        { choose: () => ({ decision: "accept", approvalChoice: "once" }) });
      assert.equal(probe.complete.status, "completed");
      const turnEvents = events.filter((event) => event.turnId === probe.turnId);
      const resultFor = (name, input) => {
        const starts = turnEvents.filter((event) => event.type === "tool_start" && event.tool.name === name
          && (!input || input(event.tool.input)));
        assert.equal(starts.length, 1, `expected exactly one ${name} call`);
        const finished = turnEvents.filter((event) => event.type === "tool_result" && event.toolCallId === starts[0].toolCallId);
        assert.equal(finished.length, 1, `expected one terminal result for ${name}`);
        return finished[0];
      };
      const read = resultFor("view_file", (input) => input?.path === marker || input?.absolute_path === marker);
      assert.equal(read.tool.success, true);
      assert.match(read.contextTool.output.result, new RegExp(token, "u"));
      const ping = resultFor("mcp__shoggoth__ping");
      assert.equal(ping.tool.success, true);
      assert.match(JSON.stringify(ping.contextTool.output), new RegExp(`PONG-${nonce}`, "u"));
      const failed = resultFor("mcp__shoggoth__probe_error");
      assert.equal(failed.tool.success, false);
      assert.match(JSON.stringify(failed.tool.output), /SYNTHETIC_TOOL_FAILURE/u);
      record("native-results-verified", { readSuccess: true, mcpSuccess: true, failurePreserved: true });
      fs.writeFileSync(path.join(root, "result.json"), JSON.stringify({ passed: true, sessionId: session.id, results }, null, 2), { mode: 0o600 });
      console.log(`PASS: native read, MCP success and native error. Evidence: ${root}`);
      return;
    }

    const plain = await turn("plain", `Remember the code word ${word}. Reply with exactly: ACP_LIVE_OK`);
    assert.equal(plain.complete.status, "completed");
    assert.match(plain.text, /ACP_LIVE_OK/u);

    const allow = await turn("url-allow", "Use your URL reading tool to fetch https://example.com and reply with only the page title.",
      { choose: () => ({ decision: "accept", approvalChoice: "once" }) });
    assert.equal(allow.complete.status, "completed");
    assert.ok(allow.approvals.length > 0, "fetching a URL asks for native approval");
    assert.ok(allow.approvals[0].includes("once:allow_once") && allow.approvals[0].includes("deny:reject_once"));
    assert.match(allow.text, /Example Domain/iu);

    const deny = await turn("url-deny", "Use your URL reading tool to fetch https://example.org and reply with only the page title.",
      { choose: () => ({ decision: "decline", approvalChoice: "deny" }) });
    assert.ok(deny.approvals.length > 0);
    assert.ok(["completed", "failed"].includes(deny.complete.status));

    const tool = await turn("shoggoth-mcp", "Call the MCP tool named ping and reply with its exact output only.");
    assert.equal(tool.complete.status, "completed");
    assert.equal(tool.approvals.length, 0, "Shoggoth product tools do not ask a second time");
    assert.match(tool.text, new RegExp(`PONG-${nonce}`, "u"));
    const spawned = fs.readFileSync(mcpOut, "utf8").trim().split("\n").map((line) => JSON.parse(line)).at(-1);
    assert.equal(spawned.parent.executable, gateCalls.at(-1).parentExecutable, "the MCP server's parent is the pinned harness");
    assert.equal(spawned.grandparent.pid, gateCalls.at(-1).ancestorPid, "the harness's parent is the bound ACP server");
    record("mcp-parent-chain", { parent: spawned.parent.executable, ancestorPid: spawned.grandparent.pid });

    const cancel = await turn("cancel", "Write a detailed essay of about 1500 words on the history of the number zero.",
      { interruptAfterMs: 1_000 });
    assert.equal(cancel.complete.status, "canceled");
    assert.doesNotMatch(cancel.text, /cancelled by the client/u);

    await pool.stopAll();
    pool = createPool(paths, gate);
    const resumed = await pool.get(BINDING, { workspace, permissionPolicy: POLICY });
    resumed.subscribe((event) => events.push(event));
    await resumed.sessionResume({ sessionId: session.id, cwd: workspace, permissionMode: "accept-edits" });
    const recall = (await resumed.turnStart({ sessionId: session.id, cwd: workspace, operationId: "live-recall",
      permissionMode: "accept-edits", prompt: "What code word did I ask you to remember? Reply with just the word." })).turn;
    const recalled = await until(() => events.find((event) => event.turnId === recall.id && event.type === "complete"), "recall");
    const recallText = events.filter((event) => event.turnId === recall.id && event.type === "text").map((event) => event.text).join("");
    record("resume-recall", { status: recalled.status, text: recallText.slice(0, 160) });
    assert.equal(recalled.status, "completed");
    assert.match(recallText, new RegExp(word, "u"), "the resumed native session keeps the conversation");
    assert.equal(events.filter((event) => event.type === "usage").length, 0, "unmeasured usage is not fabricated");
    fs.writeFileSync(path.join(root, "result.json"), JSON.stringify({ passed: true, results }, null, 2), { mode: 0o600 });
    console.log(`PASS: models, plain, URL allow/deny, Shoggoth MCP, cancel and restart-resume. Evidence: ${root}`);
  } finally {
    await pool.stopAll().catch(() => {});
    if (!process.argv.includes("--keep")) fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
