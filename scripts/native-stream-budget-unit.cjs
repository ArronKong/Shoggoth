"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { EventEmitter } = require("node:events");
const { PassThrough, Writable } = require("node:stream");
const { PiRpcJsonlDecoder } = require("../app/agent-service/pi-rpc-jsonl");
const { DeepSeekHarnessJsonlDecoder } = require("../app/agent-service/deepseek-harness-jsonl");
const { PiRpcProcess } = require("../app/agent-service/pi-rpc-process");
const { DeepSeekHarnessProcess } = require("../app/agent-service/deepseek-harness-process");
const { ClaudeCodeRuntimeHost } = require("../app/agent-service/claude-code-runtime-host");
const { CodexJsonlRpcClient } = require("../app/agent-service/codex-jsonl-rpc");
const { AcpJsonlClient } = require("../app/agent-service/acp-jsonl-client");
const { OpenCodeHttpClient } = require("../app/agent-service/opencode-http-client");
const MiB = 1024 * 1024;
for (const [name, Decoder, prefix] of [["Pi", PiRpcJsonlDecoder, "PI_RPC"],
  ["DeepSeek", DeepSeekHarnessJsonlDecoder, "DEEPSEEK_HARNESS"]]) {
  test(`${name}: more than 256 MiB of consumed frames retains only an incomplete frame`, () => {
    const decoder = new Decoder();
    const frame = Buffer.from(JSON.stringify({ type: "event", text: "x".repeat(256 * 1024) }) + "\n");
    for (let i = 0; i < 1040; i++) {
      const messages = decoder.push(frame);
      assert.equal(messages.length, 1);
      assert.equal(decoder.buffer.length, 0);
    }
    assert(frame.length * 1040 > 256 * MiB);
    const tail = Buffer.from('{"type":"event","text":"汉字"}\n');
    const split = tail.indexOf(Buffer.from("汉")) + 1;
    assert.deepEqual(decoder.push(tail.subarray(0, split)), []);
    assert.equal(decoder.push(tail.subarray(split))[0].text, "汉字");
    assert.deepEqual(decoder.finish(), []);
  });
  test(`${name}: frame, truncation, malformed data and explicit finite budgets remain bounded`, () => {
    assert.throws(() => new Decoder({ maxFrameBytes: 1024 }).push("x".repeat(1025)), { code: `${prefix}_FRAME_TOO_LARGE` });
    assert.throws(() => new Decoder().push('{broken}\n'), { code: `${prefix}_FRAME_INVALID` });
    const partial = new Decoder(); partial.push('{"type":"event"}');
    assert.throws(() => partial.finish(), { code: `${prefix}_FRAME_TRUNCATED` });
    const capped = new Decoder({ maxFrameBytes: 1024, maxStreamBytes: 2048 });
    const line = JSON.stringify({ type: "event", text: "x".repeat(700) }) + "\n";
    capped.push(line); capped.push(line);
    assert.throws(() => capped.push(line), { code: `${prefix}_STREAM_TOO_LARGE` });
    for (const limits of [{ maxFrameBytes: 257 * MiB }, { maxStreamBytes: -1 }, { maxStreamBytes: NaN }])
      assert.throws(() => new Decoder(limits), { code: `${prefix}_DECODER_OPTIONS_INVALID` });
  });
}
function childFixture() {
  const child = new EventEmitter();
  child.pid = 72_002; // kill is mocked; no OS process is signaled.
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.writes = [];
  child.stdin = new Writable({ write(chunk, _encoding, done) { child.writes.push(JSON.parse(chunk.toString())); done(); } });
  child.kills = [];
  child.kill = signal => { child.kills.push(signal); return true; };
  return child;
}
for (const [name, Process] of [["Pi", PiRpcProcess], ["DeepSeek", DeepSeekHarnessProcess]]) {
  test(`${name}: real transport delivers progress beyond 32 MiB and still settles its original request`, async () => {
    const child = childFixture(), failures = []; let events = 0;
    const rpc = new Process({ child, onEvent: () => events++, onFatal: error => failures.push(error.code) });
    if (name === "DeepSeek") child.stdout.write(JSON.stringify({ type: "ready", protocol: "shoggoth-dsh-runtime", protocolVersion: 1 }) + "\n");
    const answer = rpc.request("get_state");
    const command = child.writes[0];
    const frame = Buffer.from(JSON.stringify(name === "Pi"
      ? { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x".repeat(256 * 1024) } }
      : { type: "event", event: { type: "text_delta", delta: "x".repeat(256 * 1024) } }) + "\n");
    for (let i = 0; i < 140; i++) child.stdout.write(frame);
    child.stdout.write(JSON.stringify({ type: "response", id: command.id, command: "get_state", success: true, data: { done: true } }) + "\n");
    assert.deepEqual(await answer, { done: true });
    assert.equal(events, 140); assert.equal(Boolean(rpc.failure), false);
    assert.deepEqual(failures, []); assert.deepEqual(child.kills, []);
    child.emit("close", 0, null); await rpc.closedPromise;
  });
}
test("Claude Code: consumed text and thinking do not exhaust a task budget, individual chunks stay bounded", () => {
  const host = Object.create(ClaudeCodeRuntimeHost.prototype); let count = 0;
  host._publish = () => count++;
  const active = { sessionId: "session", turnId: "turn" };
  for (let i = 0; i < 140; i++) {
    host._onStreamEvent(active, { type: "content_block_delta", delta: { type: "text_delta", text: "x".repeat(256 * 1024) } });
    host._onStreamEvent(active, { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "y".repeat(256 * 1024) } });
  }
  assert.equal(count, 280);
  assert.throws(() => host._onStreamEvent(active, { type: "content_block_delta", delta: { type: "text_delta", text: "x".repeat(8 * MiB + 1) } }),
    { code: "CLAUDE_CODE_TURN_OUTPUT_TOO_LARGE" });
});
for (const name of ["Codex", "Grok", "Antigravity"]) {
  test(`${name}: consumed JSON-RPC notifications have no lifetime byte cap`, () => {
    const child = childFixture();
    const rpc = name === "Codex" ? new CodexJsonlRpcClient(child) : new AcpJsonlClient(child);
    let count = 0; rpc.subscribe(() => count++);
    const frame = Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { text: "x".repeat(256 * 1024) } }) + "\n");
    for (let i = 0; i < 140; i++) child.stdout.write(frame);
    assert.equal(count, 140); assert.equal(rpc.stdoutBuffer.length, 0); assert.equal(rpc.ended, false);
    rpc.terminate(); child.emit("close", 0, null);
  });
}
test("Claude Code: accumulated retained command output still has a memory bound", async () => {
  const host = Object.create(ClaudeCodeRuntimeHost.prototype);
  host._acceptActive = () => {}; host._publish = () => {};
  const active = { sessionId: "session", turnId: "turn", seenInit: true,
    localCommandOutputs: [], localCommandOutputBytes: 0 };
  for (let i = 0; i < 8; i++) await host._onSdkMessage(active,
    { type: "system", subtype: "local_command_output", content: "x".repeat(MiB) });
  await assert.rejects(host._onSdkMessage(active,
    { type: "system", subtype: "local_command_output", content: "overflow" }),
    { code: "CLAUDE_CODE_TURN_OUTPUT_TOO_LARGE" });
  assert.equal(active.localCommandOutputs.length, 8);
  assert.equal(active.localCommandOutputBytes, 8 * MiB);
  await assert.rejects(host._onSdkMessage(active,
    { type: "system", subtype: "local_command_output", content: "x".repeat(8 * MiB + 1) }),
    { code: "CLAUDE_CODE_TURN_OUTPUT_TOO_LARGE" });
});
test("OpenCode: each HTTP response has its own budget across a long session", async () => {
  const body = JSON.stringify({ text: "x".repeat(MiB) });
  const client = new OpenCodeHttpClient({ url: "http://127.0.0.1:12345", password: "fixture".repeat(8),
    fetch: async () => new Response(body) });
  for (let i = 0; i < 40; i++) assert.equal((await client.request("GET", "/session" )).data.text.length, MiB);
});
