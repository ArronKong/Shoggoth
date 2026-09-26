#!/usr/bin/env node
// Unit: AcpClient 错误细节透传 + session-setup 超时（R139）。
// Hermes ACP 把真实原因放 error.data.details（error.message 只有 "Internal
// error"）——吞掉它用户就只能看到无意义红字（2026-07-14 horse 事故）。
// 另外 session/new 无响应必须超时报错，不能让 UI 永远 Thinking。
// 运行：node scripts/acp-client-unit.mjs

import { createRequire } from "node:module";
import { Writable } from "node:stream";
const require = createRequire(import.meta.url);
const { AcpClient } = require("../app/core/acp-client.js");

const results = [];
const check = (name, cond) => { results.push({ name, ok: !!cond }); if (!cond) process.exitCode = 1; };

// 假 ACP agent：initialize 正常应答；session/new 回带 data.details 的 error；
// session/load 永不应答（测超时）。
const FAKE_AGENT = `
const rl = require("node:readline").createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } }) + "\\n");
  } else if (m.method === "session/new") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32603, message: "Internal error", data: { details: "Provider 'xai' is set in config.yaml but no API key was found." } } }) + "\\n");
  } // session/load: never answer
});
`;

// ---- 1. error.data.details 透传 ----
{
  const client = new AcpClient({ bin: process.execPath, args: ["-e", FAKE_AGENT] });
  let msg = "";
  try { await client.newSession("/tmp"); } catch (e) { msg = e.message; }
  check("error.message 保留", /Internal error/.test(msg));
  check("data.details 透传", /Provider 'xai'.*no API key/.test(msg));
  client.stop();
}

// ---- 2. session-setup 超时（用 _request 的注入超时短路验证机制）----
{
  const client = new AcpClient({ bin: process.execPath, args: ["-e", FAKE_AGENT] });
  await client.start();
  let msg = "";
  const t0 = Date.now();
  try { await client._request("session/load", { sessionId: "x" }, 800); } catch (e) { msg = e.message; }
  check("无响应请求按时超时", /timed out/.test(msg) && Date.now() - t0 < 5000);
  check("超时后 pending 清空", client.pending.size === 0);
  client.stop();
}

// ---- 3. initialize 失败后可重试（不缓存 rejected initPromise）----
{
  const client = new AcpClient({ bin: "/nonexistent-hermes-bin-xyz", args: ["acp"] });
  let first = "";
  try { await client.start(); } catch (e) { first = e.message || String(e); }
  check("initialize 失败会抛", first.length > 0);
  check("失败后 initPromise 已复位（下次 send 重新 spawn）", client.initPromise === null);
}

// Exercise the real parser at every byte boundary, including the middle of a
// UTF-8 code point. A valid JSON frame can parse while its text is corrupted.
{
  const expected = "你好，世界 🌍";
  const frame = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { text: expected } }) + "\n");
  let intact = true;
  for (let split = 1; split < frame.length; split += 1) {
    const client = new AcpClient();
    const result = new Promise((resolve, reject) => client.pending.set(1, { resolve, reject }));
    client._onStdout(frame.subarray(0, split));
    client._onStdout(frame.subarray(split));
    if ((await result).text !== expected) intact = false;
    client.stop();
  }
  check("真实 ACP 解析器在每个 UTF-8 拆包点保留正文", intact);
}

// Writable errors arrive after write() returns. The request must settle and
// the child must be terminated once even if callback and error both fire.
{
  let exits = 0;
  const stdin = new Writable({ write(_data, _encoding, callback) {
    setImmediate(() => callback(Object.assign(new Error("broken pipe"), { code: "EPIPE" })));
  } });
  const proc = { stdin, kill() {} };
  const client = new AcpClient({ onExit: () => { exits += 1; } });
  client.proc = proc;
  stdin.on("error", (error) => client._terminateProcess(proc, error, null));
  let error = null;
  try { await client._request("session/prompt", { sessionId: "x", prompt: [] }); }
  catch (cause) { error = cause; }
  check("异步 EPIPE 结算 pending 且只终止一次", error?.code === "EPIPE"
    && client.pending.size === 0 && client.proc === null && exits === 1);
}

{
  const client = new AcpClient();
  const proc = { kill() {} };
  client.proc = proc;
  const pending = new Promise((resolve, reject) => client.pending.set(1, { resolve, reject }));
  client._onStdout(Buffer.from('{"jsonrpc":"2.0","method":"session/update","params":{}}\n'));
  client._onStdout(Buffer.from('{"jsonrpc":"2.0","id":1,broken}\n'));
  let error = null;
  try { await pending; } catch (cause) { error = cause; }
  check("已建立协议后损坏响应会有界失败", error?.code === "ACP_PROTOCOL_ERROR"
    && client.pending.size === 0 && client.proc === null);
}

{
  const client = new AcpClient();
  client.proc = { kill() {} };
  const pending = new Promise((resolve, reject) => client.pending.set(1, { resolve, reject }));
  client._onStdout(Buffer.from("x".repeat(16 * 1024 * 1024 + 1)));
  let error = null;
  try { await pending; } catch (cause) { error = cause; }
  check("ACP 无换行超大帧有界终止", error?.code === "ACP_PROTOCOL_ERROR"
    && client.proc === null && client.partialFrameTimer === null);
}

{
  const client = new AcpClient();
  client.proc = { kill() {} };
  const pending = new Promise((resolve, reject) => client.pending.set(1, { resolve, reject }));
  client._onStdout(Buffer.from("startup banner\n".repeat(9)));
  let error = null;
  try { await pending; } catch (cause) { error = cause; }
  check("ACP 启动 banner 数量有限", error?.code === "ACP_PROTOCOL_ERROR"
    && client.startupBannerLines === 0);
  client._recordStderr("s".repeat(10_000));
  check("ACP stderr 单行保留有界", client.stderrTail[0].length <= 2_048);
}

{
  let writes = 0;
  const stdin = new Writable({ highWaterMark: 1, write(_data, _encoding, callback) {
    writes += 1;
    setImmediate(callback);
  } });
  const client = new AcpClient();
  client.proc = { stdin, kill() {} };
  const accepted = client._write({ jsonrpc: "2.0", id: 1, method: "initialize" });
  await new Promise((resolve) => setImmediate(resolve));
  check("stdin 背压不会重写同一帧", accepted && writes === 1);
  client.stop();
}

for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
