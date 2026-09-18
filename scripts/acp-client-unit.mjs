#!/usr/bin/env node
// Unit: AcpClient 错误细节透传 + session-setup 超时（R139）。
// Hermes ACP 把真实原因放 error.data.details（error.message 只有 "Internal
// error"）——吞掉它用户就只能看到无意义红字（2026-07-14 horse 事故）。
// 另外 session/new 无响应必须超时报错，不能让 UI 永远 Thinking。
// 运行：node scripts/acp-client-unit.mjs

import { createRequire } from "node:module";
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

for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
