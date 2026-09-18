import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { startStaticServer } = require("../app/static-server.js");

function requestJson(baseUrl, pathname, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(pathname, baseUrl), { method, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* status is enough */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-cli-security-"));
const scanDir = path.join(tempRoot, "scan-bin");
const rogueDir = path.join(tempRoot, "rogue-bin");
const execLog = path.join(tempRoot, "exec.log");
fs.mkdirSync(scanDir);
fs.mkdirSync(rogueDir);
const safePath = path.join(scanDir, "qa-safe-cli");
const roguePath = path.join(rogueDir, "qa-rogue-cli");
const executable = "#!/bin/sh\nprintf 'x' >> \"$CLI_EXEC_LOG\"\n/bin/sleep 0.3\nprintf 'qa-cli 1.0\\n'\n";
fs.writeFileSync(safePath, executable, { mode: 0o755 });
fs.writeFileSync(roguePath, executable, { mode: 0o755 });

const originalPath = process.env.PATH;
const originalLog = process.env.CLI_EXEC_LOG;
process.env.PATH = scanDir;
process.env.CLI_EXEC_LOG = execLog;

const server = await startStaticServer(0, { registry: { backends: new Map() } });
try {
  const versionPath = "/__api/cli/version";
  const post = (pathname, body, headers = {}) => requestJson(server.url, pathname, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
  const legacyGet = await requestJson(server.url, `${versionPath}?path=${encodeURIComponent(roguePath)}`);
  assert.equal(legacyGet.status, 405, "执行型 CLI 接口不得保留可由资源标签触发的 GET");
  const crossSite = await post(versionPath, { path: roguePath }, { "sec-fetch-site": "cross-site" });
  assert.equal(crossSite.status, 403, "无 Origin 的 cross-site Fetch Metadata 请求必须被拒绝");
  assert.equal(fs.existsSync(execLog), false, "跨站请求不得执行任何文件");

  const unscanned = await post(versionPath, { path: roguePath });
  assert.equal(unscanned.status, 403, "native 请求也只能执行服务端扫描白名单中的路径");
  const unscannedInfo = await post("/__api/cli/info", { path: roguePath });
  assert.equal(unscannedInfo.status, 403, "CLI info 同样只能执行扫描白名单中的路径");
  assert.equal(fs.existsSync(execLog), false, "非扫描路径不得执行");

  const scan = await requestJson(server.url, "/__api/cli");
  assert.equal(scan.status, 200);
  assert.ok(scan.json?.tools?.some((tool) => tool.path === safePath), "扫描应返回 PATH 中的合法 CLI");

  const native = await post(versionPath, { path: safePath });
  assert.equal(native.status, 200, "同时缺 Origin/Fetch Metadata 的 native 调用保持兼容");
  assert.equal(native.json?.version, "qa-cli 1.0");
  assert.equal(fs.readFileSync(execLog, "utf8"), "x");

  const safeInfo = await post("/__api/cli/info", { path: safePath });
  assert.equal(safeInfo.status, 200, "CLI info 应复用最近扫描记录的 canonical path/name");

  const concurrent = await Promise.all([
    post(versionPath, { path: safePath }),
    post(versionPath, { path: safePath }),
    post(versionPath, { path: safePath }),
  ]);
  assert.deepEqual(concurrent.map((item) => item.status).sort(), [200, 200, 429],
    "CLI 执行型读取应有界并发，超限快速返回 429");
} finally {
  await server.close();
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  if (originalLog === undefined) delete process.env.CLI_EXEC_LOG;
  else process.env.CLI_EXEC_LOG = originalLog;
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log("PASS loopback CLI origin + allowlist + concurrency regression");
