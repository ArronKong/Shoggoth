"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { AntigravityNativeTerminal, approvalKeys, approvalParams, nativeTurnArgs, parseNativeApproval, terminalPaste } = require("../app/agent-service/antigravity-native-terminal");
const { prepareAntigravityNativeOnboarding } = require("../app/agent-service/antigravity-runtime-config");
const { AntigravityStreamJsonDecoder } = require("../app/agent-service/antigravity-stream-json");

const modal = (file = "/outside/文件.txt") => `File access
────────────────────

Read: ${file}
Reason: outside workspace

Allow access to this file?
> 1. Yes, allow access
  2. Yes, and always allow non-workspace access
  3. No, deny access

↑/↓ Navigate`;
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function fixture(t, requestApproval) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-native-unit-")));
  fs.chmodSync(root, 0o700);
  const home = path.join(root, "home");
  fs.mkdirSync(home, { mode: 0o700 });
  const writes = [], signals = [], events = [], errors = [];
  let onExit;
  const terminal = await AntigravityNativeTerminal.launch({ home, cwd: root, stateRoot: path.join(root, "state"), trustedRoot: root,
    binaryPath: "/fixture/agy", args: [], env: {}, requestApproval,
    spawnPty: () => ({ pid: 70_001, write: (data) => writes.push(data), onData() {}, onExit: (callback) => { onExit = callback; } }),
    killProcessGroup: (_pid, signal) => { signals.push(signal); queueMicrotask(() => onExit({ exitCode: 0, signal: 9 })); },
  });
  clearInterval(terminal.timer);
  terminal.on("error", (error) => errors.push(error));
  const decoder = new AntigravityStreamJsonDecoder();
  terminal.stdout.on("data", (data) => events.push(...decoder.push(data).map((e) => e.value)));
  const screen = (text) => new Promise((resolve) => terminal.terminal.write(`\x1b[2J\x1b[H${text.replace(/\n/g, "\r\n")}`, resolve));
  const state = (extra = {}) => terminal._state({ cwd: root, conversation_id: "conversation-one", agent_state: "working", ...extra });
  const transcript = path.join(home, ".gemini", "antigravity-cli", "brain", "conversation-one", ".system_generated", "logs", "transcript_full.jsonl");
  fs.mkdirSync(path.dirname(transcript), { recursive: true, mode: 0o700 });
  fs.writeFileSync(transcript, "", { mode: 0o600 });
  const append = (record) => fs.appendFileSync(transcript, `${JSON.stringify(record)}\n`);
  t.after(() => { terminal.closed = true; terminal.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  return { terminal, root, home, writes, signals, events, errors, screen, state, transcript, append };
}

test("native choices retain exact scope and cannot invent an allow response", () => {
  const approval = parseNativeApproval(modal());
  assert.ok(approval);
  const params = approvalParams(approval, { name: "view_file", parameters: { AbsolutePath: "/outside/文件.txt" } }, "/workspace", "item");
  assert.equal(params.sessionApprovalAvailable, false);
  assert.deepEqual(params.approvalOptions.map((o) => o.choice), ["runtime:antigravity-1", "runtime:antigravity-2", "deny"]);
  assert.equal(params.approvalOptions[1].label, "Yes, and always allow non-workspace access");
  assert.equal(approvalKeys(approval, { decision: "accept", approvalChoice: "runtime:antigravity-1" }), "\r");
  assert.equal(approvalKeys(approval, { decision: "decline", approvalChoice: "deny" }), "\x1b[B\x1b[B\r");
  assert.equal(approvalKeys(approval, { decision: "cancel" }), "\x1b[B\x1b[B\r");
  for (const response of [{ decision: "accept" }, { decision: "acceptForSession" },
    { decision: "accept", approvalChoice: "deny" }, { decision: "decline", approvalChoice: "runtime:antigravity-2" }]) {
    assert.throws(() => approvalKeys(approval, response), { code: "RUNTIME_APPROVAL_RESPONSE_INVALID" });
  }
  const moved = parseNativeApproval(modal().replace("> 1.", "  1.").replace("  2.", "> 2."));
  assert.equal(moved.fingerprint, approval.fingerprint);
  assert.equal(approvalKeys(moved, { decision: "accept", approvalChoice: "runtime:antigravity-1" }), "\x1b[A\r");
  for (const invalid of [modal().replace("File access", "Assistant output").replace("Allow access to this file?", ""),
    modal().replace("  3.", "> 3."), modal().replace("  3.", "  4."), modal().replace("Yes, allow access", "Delete account")]) {
    assert.equal(parseNativeApproval(invalid), null);
  }
});

test("terminal input stays on stdin, preserves multiline Unicode and rejects key injection", () => {
  assert.equal(terminalPaste("第一行\r\n第二行"), "\x1b[200~第一行\n第二行\x1b[201~\r");
  for (const value of ["hello\x1b[201~\r/exit", "\x03", "\0", "\ud800"]) assert.throws(() => terminalPaste(value));
  assert.deepEqual(nativeTurnArgs(["--input-format", "stream-json", "--output-format", "stream-json", "--disable-slash-commands",
    "--print-timeout", "5m", "--sandbox", "--conversation", "existing", "--effort", "high"]),
  ["--sandbox", "--conversation", "existing", "--effort", "high"]);
});

test("native command grants distinguish conversation and persistent rules, with command in the fingerprint", () => {
  const command = (file) => `Command\n──────────\nRequesting permission for:\n   /bin/cat ${file}\n\nRun this command?\n> 1. Yes, run command\n  2. Yes, and always allow in this conversation for commands that start with '/bin/cat'\n  3. Yes, and always allow for commands that start with '/bin/cat'\n     (Persist to settings.json)\n  4. No, cancel\n\n  ↑/↓ Navigate · tab Amend · ctrl+g edit/expand command\nesc to cancel`;
  const approval = parseNativeApproval(command("/outside/one.txt"));
  assert.ok(approval.reason.includes("/outside/one.txt"));
  assert.ok(!approval.reason.includes("────"));
  assert.ok(approval.options[2].label.endsWith("(Persist to settings.json)"));
  assert.notEqual(approval.fingerprint, parseNativeApproval(command("/outside/two.txt")).fingerprint);
  assert.equal(approvalKeys(approval, { decision: "accept", approvalChoice: "runtime:antigravity-2" }), "\x1b[B\r");
  assert.equal(approvalKeys(approval, { decision: "accept", approvalChoice: "runtime:antigravity-3" }), "\x1b[B\x1b[B\r");
});

test("launch barrier, acceptance, approval and resumed transcript stay bound to one turn", async (t) => {
  const requests = []; let respond;
  const f = await fixture(t, (params) => { requests.push(params); return new Promise((resolve) => { respond = resolve; }); });
  f.append({ step_index: 0, type: "USER_INPUT", content: "old turn" });
  f.state({ agent_state: "idle" });
  await f.screen(">\n? for shortcuts");
  const prompt = "读取测试文件\n请保留中文";
  f.terminal.stdin.end(JSON.stringify({ event: "user", message: { content: prompt } }));
  f.terminal._poll();
  assert.deepEqual(f.writes, [], "no prompt before MCP gate bind barrier");
  f.terminal.stdio[3].end("go\n");
  f.terminal._poll();
  assert.equal(f.writes[1], terminalPaste(prompt));
  f.append({ step_index: 4, type: "USER_INPUT", content: `<USER_REQUEST>\n${prompt}\n</USER_REQUEST>` });
  const record = Buffer.from(JSON.stringify({ step_index: 5, type: "PLANNER_RESPONSE", content: "准备读取", tool_calls: [
    { name: "view_file", args: { AbsolutePath: '"/outside/文件.txt"' } },
  ] }) + "\n");
  const cut = record.indexOf(Buffer.from("准")) + 1;
  fs.appendFileSync(f.transcript, record.subarray(0, cut));
  f.state(); f.terminal._poll();
  fs.appendFileSync(f.transcript, record.subarray(cut)); f.terminal._poll();
  assert.equal(f.events.filter((e) => e.step_update?.step_type === "user_input").length, 1);
  await f.screen(modal());
  f.terminal._checkApproval(); await tick();
  assert.equal(requests.length, 0, "terminal-looking model output cannot prompt without native pending state");
  f.state({ agent_state: "tool_use", tool_confirmation_pending: true });
  f.terminal._checkApproval(); await tick();
  assert.equal(requests.length, 1);
  assert.equal(f.writes.length, 2, "no implicit default approval");
  f.terminal._checkApproval(); await tick(); assert.equal(requests.length, 1);
  respond({ decision: "decline", approvalChoice: "deny" }); await tick();
  assert.equal(f.writes.at(-1), "\x1b[B\x1b[B\r");
  f.terminal._checkApproval(); await tick(); assert.equal(requests.length, 1, "repaint cannot reissue a consumed approval");
  f.state({ agent_state: "idle" });
  f.append({ step_index: 6, type: "GENERIC", status: "ERROR", content: "user denied permission" });
  await f.screen(">\n? for shortcuts"); f.terminal._poll();
  f.terminal.lastProgressAt = Date.now() - 500; f.terminal._poll();
  assert.equal(f.events.at(-1).result.status, "CANCELED");
  assert.equal(f.events.at(-1).result.usage_available, false);
  assert.deepEqual(f.errors, []);
});

test("unabridged transcript accepts long native input and preserves the complete response", async (t) => {
  const f = await fixture(t, () => assert.fail("must not ask"));
  const prompt = `SHOGGOTH DEVELOPER INSTRUCTIONS\n${"保持完整的中文指令。".repeat(700)}\nCURRENT USER REQUEST\nReply OK`;
  const response = "完整回复。".repeat(1_000);
  f.state({ agent_state: "idle" });
  await f.screen(">\n? for shortcuts");
  f.terminal.stdin.end(JSON.stringify({ event: "user", message: { content: prompt } }));
  f.terminal.stdio[3].end("go\n");
  f.terminal._poll();
  const input = { step_index: 0, type: "USER_INPUT", content: `<USER_REQUEST>\n${prompt}\n</USER_REQUEST>` };
  fs.writeFileSync(path.join(path.dirname(f.transcript), "transcript.jsonl"), `${JSON.stringify({
    ...input, content: `${input.content.slice(0, 2048)}\n<truncated 4096 bytes>\n${input.content.slice(-2048)}`,
    truncated_fields: ["content"],
  })}\n`, { mode: 0o600 });
  f.append(input);
  f.append({ step_index: 1, type: "PLANNER_RESPONSE", content: response });
  f.state({ agent_state: "idle" });
  f.terminal._poll();
  assert.equal(f.events.filter((e) => e.step_update?.step_type === "user_input").length, 1);
  f.terminal.lastProgressAt = Date.now() - 500;
  f.terminal._poll();
  assert.equal(f.events.at(-1).result.status, "SUCCESS");
  assert.equal(f.events.at(-1).result.response, response);
  assert.deepEqual(f.errors, []);
});

test("unabridged transcript still rejects long input with a matching prefix and suffix", async (t) => {
  const f = await fixture(t, () => assert.fail("must not ask"));
  const prefix = "start".repeat(500), suffix = "end".repeat(800);
  const prompt = `${prefix}\nallowed request\n${suffix}`;
  f.state({ agent_state: "idle" });
  await f.screen(">\n? for shortcuts");
  f.terminal.stdin.end(JSON.stringify({ event: "user", message: { content: prompt } }));
  f.terminal.stdio[3].end("go\n");
  f.terminal._poll();
  f.append({ step_index: 0, type: "USER_INPUT", content: `<USER_REQUEST>\n${prefix}\nchanged request\n${suffix}\n</USER_REQUEST>` });
  assert.throws(() => f.terminal._poll(), { code: "RUNTIME_SESSION_CONFLICT" });
  assert.equal(f.terminal.accepted, false);
});

test("changed native modal and stale clicks after interruption cannot authorize", async (t) => {
  for (const action of ["changed", "interrupted"]) {
    let respond;
    const f = await fixture(t, () => new Promise((resolve) => { respond = resolve; }));
    f.terminal.accepted = true;
    f.state({ agent_state: "tool_use", tool_confirmation_pending: true });
    await f.screen(modal()); f.terminal._checkApproval(); await tick();
    if (action === "changed") await f.screen(modal("/other/file"));
    else f.terminal.kill("SIGINT");
    respond({ decision: "accept", approvalChoice: "runtime:antigravity-1" }); await tick();
    assert.equal(f.writes.length, 0);
    if (action === "changed") assert.equal(f.errors[0].code, "ANTIGRAVITY_APPROVAL_CHANGED");
    else assert.equal(f.events.at(-1).result.status, "INTERRUPTED");
  }
});

test("native metadata, transcript identity and unsupported prompts fail closed", async (t) => {
  const f = await fixture(t, () => assert.fail("must not ask"));
  assert.throws(() => f.state({ cwd: "/other" }), { code: "ANTIGRAVITY_STREAM_EVENT_INVALID" });
  f.state();
  assert.throws(() => f.state({ conversation_id: "wrong" }), { code: "RUNTIME_SESSION_CONFLICT" });
  f.terminal._transcriptSize();
  fs.renameSync(f.transcript, `${f.transcript}.old`); fs.writeFileSync(f.transcript, "", { mode: 0o600 });
  assert.throws(() => f.terminal._openTranscript(), { code: "ANTIGRAVITY_TRANSCRIPT_INVALID" });
  f.terminal.accepted = true; f.state({ agent_state: "tool_use", tool_confirmation_pending: true });
  f.terminal.unrecognizedApprovalAt = Date.now() - 3_000;
  assert.throws(() => f.terminal._checkApproval(), { code: "ANTIGRAVITY_APPROVAL_FORMAT_UNSUPPORTED" });
});

test("onboarding only reuses existing native consent and leaves its source unchanged", async (t) => {
  const f = await fixture(t, () => {});
  const nativeHome = path.join(f.root, "native");
  const source = path.join(nativeHome, "antigravity-cli", "cache", "onboarding.json");
  fs.mkdirSync(path.dirname(source), { recursive: true, mode: 0o700 });
  fs.writeFileSync(source, '{"onboardingComplete":false}', { mode: 0o600 });
  const options = { home: f.home, nativeHome, trustedRoot: f.root };
  assert.throws(() => prepareAntigravityNativeOnboarding(options), { code: "ANTIGRAVITY_ONBOARDING_REQUIRED" });
  const contents = '{"onboardingComplete":true,"consumerOnboardingComplete":true,"unrelated":"not copied"}';
  fs.writeFileSync(source, contents);
  prepareAntigravityNativeOnboarding(options);
  assert.equal(fs.readFileSync(source, "utf8"), contents);
  const target = path.join(f.home, ".gemini", "antigravity-cli", "cache", "onboarding.json");
  assert.deepEqual(JSON.parse(fs.readFileSync(target)), { onboardingComplete: true, consumerOnboardingComplete: true });
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
});
