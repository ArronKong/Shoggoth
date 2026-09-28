#!/usr/bin/env node
"use strict";

// Reproducible, read-only inventory for eight frozen Codex MCP declarations:
// two registered-client and three Desktop-client candidates, three blockers.
// Never print or import source OAuth client IDs, secrets, or host environment.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { BundledPluginCatalog, bundledRoot } = require("../app/core/bundled-plugin-catalog");
const { convertLegacyPluginContents } = require("../app/core/legacy-plugin-content-adapter");

const repo = path.resolve(__dirname, "..");
const reportPath = path.join(repo, "docs/architecture/bundled-mcp-auth-gaps-2026-09-27.md");
const sources = Object.freeze([
  { id: "airtable", endpoint: "https://mcp.airtable.com/mcp", oauthKeys: ["client_id"],
    scopes: 0, callbackPort: null, audience: null, identity: "placeholder" },
  { id: "gmail", endpoint: "https://gmailmcp.googleapis.com/mcp/v1",
    oauthKeys: ["callback_port", "client_id", "client_secret"],
    scopes: 5, callbackPort: 12798, audience: null, identity: "placeholder" },
  { id: "google-calendar", endpoint: "https://calendarmcp.googleapis.com/mcp/v1",
    oauthKeys: ["callback_port", "client_id", "client_secret"],
    scopes: 12, callbackPort: 12798, audience: null, identity: "placeholder" },
  { id: "google-drive", endpoint: "https://drivemcp.googleapis.com/mcp/v1",
    oauthKeys: ["callback_port", "client_id", "client_secret"],
    scopes: 3, callbackPort: 12798, audience: null, identity: "placeholder" },
  { id: "shopify", endpoint: "https://setup.shopify.com/mcp", oauthKeys: ["client_id"],
    scopes: 0, callbackPort: null, audience: "https://setup.shopify.com/mcp", identity: "placeholder" },
  { id: "slack", endpoint: "https://mcp.slack.com/mcp", oauthKeys: ["client_id"],
    scopes: 0, callbackPort: null, audience: null, identity: "third-party" },
  { id: "zoom", endpoint: "https://mcp.zoom.us/mcp/meeting/streamable",
    oauthKeys: ["client_id"], scopes: 0, callbackPort: null, audience: null,
    identity: "placeholder" },
  { id: "codex-security", endpoint: null, oauthKeys: [], scopes: 0, callbackPort: null,
    audience: null, identity: "host-cli" },
]);
const placeholder = /^<[A-Z0-9_]+>$/u;

function filesOf(root) {
  const files = [];
  const visit = (directory, prefix = "") => {
    for (const name of fs.readdirSync(directory).sort()) {
      const relative = prefix ? `${prefix}/${name}` : name;
      const target = path.join(directory, name);
      const stat = fs.lstatSync(target);
      assert.equal(stat.isSymbolicLink(), false);
      if (stat.isDirectory()) visit(target, relative);
      else {
        assert.equal(stat.isFile() && stat.nlink === 1, true);
        files.push({ path: relative, content: fs.readFileSync(target),
          executable: (stat.mode & 0o111) !== 0 });
      }
    }
  };
  visit(root);
  return files;
}

function inspect() {
  const catalog = new BundledPluginCatalog(bundledRoot());
  assert.equal(catalog.list().items.length, 62);
  const rows = [];
  for (const expected of sources) {
    const item = catalog.assertCurrent(expected.id); // compare every file with frozen sourceDigest
    const root = catalog.packagePath(expected.id);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, ".codex-plugin/plugin.json"), "utf8"));
    assert.equal(manifest.name, expected.id);
    const declaration = JSON.parse(fs.readFileSync(path.join(root, ".mcp.json"), "utf8"));
    assert.deepEqual(Object.keys(declaration), ["mcpServers"]);
    assert.deepEqual(Object.keys(declaration.mcpServers), [expected.id]);
    const server = declaration.mcpServers[expected.id];
    const converted = convertLegacyPluginContents({ format: "codex-plugin", bundledCodex: true,
      components: ["skills", "mcp-servers"], files: filesOf(root) });
    const adaptedRegisteredClient = ["airtable", "shopify"].includes(expected.id);
    const adaptedGoogleDesktop = ["gmail", "google-calendar", "google-drive"].includes(expected.id);
    const adapted = adaptedRegisteredClient || adaptedGoogleDesktop;
    assert.equal(converted.mcpServers.some(entry => entry.name === expected.id), adapted,
      `${expected.id} conversion state changed`);
    assert.deepEqual(item.unconvertedMcp, adapted ? [] : [{ name: expected.id,
      reasonCode: "LEGACY_MCP_FIELD_UNSUPPORTED" }]);
    assert.ok(converted.diagnostics.some(issue => issue.scope === "mcp-server"
      && issue.name === expected.id && issue.reasonCode === (adaptedRegisteredClient
        ? "CODEX_OAUTH_CLIENT_REGISTRATION_REQUIRED" : adaptedGoogleDesktop
          ? "CODEX_GOOGLE_DESKTOP_OAUTH_REQUIRED" : "LEGACY_MCP_FIELD_UNSUPPORTED")));
    if (expected.id === "codex-security") {
      assert.deepEqual(Object.keys(server).sort(), ["args", "command", "cwd", "env_vars",
        "startup_timeout_sec", "tool_timeout_sec"]);
      assert.equal(server.command, "./scripts/launch_codex_security_mcp");
      assert.deepEqual(server.args, ["--stdio"]);
      assert.equal(server.cwd, ".");
      assert.equal(server.env_vars.length, 43);
      assert.ok(server.env_vars.every(value => /^[A-Z][A-Z0-9_]*$/u.test(value)));
      assert.equal(server.startup_timeout_sec, 120);
      assert.equal(server.tool_timeout_sec, 349200);
      rows.push({ id: expected.id, endpoint: "本地 stdio", identity: "Codex CLI/Home/环境变量",
        scopes: "—", callback: "—", audience: "—", reason: "host-cli" });
      continue;
    }
    assert.equal(server.type, "http");
    assert.equal(server.url, expected.endpoint);
    assert.deepEqual(Object.keys(server.oauth).sort(), [...expected.oauthKeys].sort());
    assert.equal(placeholder.test(server.oauth.client_id), expected.identity === "placeholder");
    if (Object.hasOwn(server.oauth, "client_secret")) {
      assert.equal(placeholder.test(server.oauth.client_secret), true);
    }
    assert.equal(server.oauth.callback_port ?? null, expected.callbackPort);
    assert.equal(server.oauth_resource ?? null, expected.audience);
    assert.equal(server.scopes?.length ?? 0, expected.scopes);
    if (adapted) {
      assert.deepEqual(server.oauth, { client_id: expected.id === "shopify"
        ? "<SHOPIFY_PUBLIC_CLIENT_ID>" : expected.id === "airtable"
          ? "<AIRTABLE_PUBLIC_CLIENT_ID>" : `<${expected.id.toUpperCase().replaceAll("-", "_")}_PUBLIC_CLIENT_ID>`,
      ...(adaptedGoogleDesktop ? { client_secret:
        `<${expected.id.toUpperCase().replaceAll("-", "_")}_CLIENT_SECRET>`, callback_port: 12798 } : {}) });
      const manifestOutput = JSON.parse(converted.generatedFiles.find(file => file.path === "plugin.json").content);
      assert.equal(manifestOutput.extensions.shoggoth.mcpOAuthResources[expected.id], expected.endpoint);
      assert.equal(converted.generatedFiles.some(file => file.content.includes(server.oauth.client_id)), false);
      if (adaptedGoogleDesktop) {
        assert.equal(converted.generatedFiles.some(file => file.content.includes(server.oauth.client_secret)), false);
        assert.equal(converted.generatedFiles.some(file => file.content.includes("12798")), false);
        assert.equal(converted.generatedFiles.some(file => server.scopes.some(scope => file.content.includes(scope))), false);
      }
      continue;
    }
    if (server.scopes) {
      assert.equal(new Set(server.scopes).size, server.scopes.length);
      assert.ok(server.scopes.every(scope => typeof scope === "string" && scope.startsWith("https://")));
    }
    rows.push({ id: expected.id, endpoint: expected.endpoint,
      identity: expected.identity === "placeholder" ? "占位 client ID" : "第三方 client ID",
      scopes: expected.scopes ? `来源 ${expected.scopes} 项` : "未声明",
      callback: expected.callbackPort === null ? "未声明" : `固定 ${expected.callbackPort}`,
      audience: expected.audience || "未声明",
      reason: expected.id });
  }
  assert.equal(rows.length, 3);
  return { batchDigest: catalog.batchDigest, rows };
}

function render({ batchDigest, rows }) {
  const blockers = {
    slack: "来源 client ID 属于第三方应用，不能作为 Shoggoth 凭据；须自有应用注册、受信 scopes/受众/身份验证。",
    zoom: "来源 client ID 是占位符；须自有应用注册、受信 scopes/受众/身份验证。",
    "host-cli": "相对启动脚本、43 项 Codex 宿主环境变量及 120/349200 秒超时不能从用户进程继承；须隔离 Runtime 与逐项依赖/超时审查。",
  };
  const lines = [
    "# 冻结内置包未转换 MCP 的认证与宿主阻塞（2026-09-27）", "",
    "来源为固定批次 `resources/bundled-plugins/packages/*/.mcp.json`，批次摘要 `"
      + batchDigest + "`。运行 `node scripts/plugin-bundled-mcp-auth-gaps.cjs --check` 可复核全部 8 个来源包的文件摘要、字段形状、当前转换结果与本报告；`--write` 重建。以下不输出 OAuth client ID/secret 的原文。",
    "", "本表仅记录**剩余安全适配阻塞**。目前 28/31 个独立 MCP 可转为安装候选；表中 3 项仍未转换。Airtable 与 Shopify 的冻结声明已作为需要用户自有注册客户端的候选转换；Google 三项经逐文件字节固定校验后只将精确 MCP 端点转换为**另一条 Shoggoth Desktop public-client 路线**，不继承来源 client ID/secret、12798 回调或整组 scopes。五项候选均要求包外私有 provider 配置、受众、scope 与身份核验。隔离 fixture 不能证明真实供应商认证或业务调用。普通内置包文件在用户点击安装前不会注入 Agent 上下文。", "",
    "| 包 / MCP | 固定端点 | 来源 OAuth / 宿主约束 | 来源 scopes | 回调端口 | 来源受众 | 继续开发的阻塞 |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const row of rows) {
    const endpoint = row.endpoint.startsWith("https:") ? "`" + row.endpoint + "`" : row.endpoint;
    lines.push("| `" + row.id + "/" + row.id + "` | " + endpoint + " | " + row.identity
      + " | " + row.scopes + " | " + row.callback + " | " + row.audience
      + " | " + blockers[row.reason] + " |");
  }
  lines.push("", "## 本地实现边界", "",
    "- `legacy-plugin-content-adapter.js` 为精确匹配的冻结 Airtable/Shopify 占位声明及 Google 三项字节固定声明生成受众约束的候选；Slack、Zoom、Codex Security 因来源专属 `oauth`、`env_vars` 或 timeout 字段继续 fail closed。导入器、内置目录和安装预览不会把来源 client ID/secret、回调端口、整组 scopes 或宿主环境静默带入 Shoggoth。Google 预览及详情必须显示认证非等价和账号准备要求。",
    "- Service 的 `PluginOAuthProviderRegistry` 只接受在包外、用户私有配置中登记的精确 HTTPS endpoint、issuer、受众、授权/令牌端点、client ID、scope 与身份核验。未知 provider 必须拒绝；Airtable/Shopify 用户可把其注册的固定 `http://127.0.0.1:<port>/oauth/callback` 配在私有 provider 文件中。Google 三项必须使用自有 Desktop client、动态 loopback + PKCE、明确挑选的最小产品 scope，并另外明确申请 `openid profile`；不能默认授予来源全部权限。当前本地协议 fixture 只证明 Shoggoth 链路，不代表 Google MCP 接受此客户端类型或受众。",
    "- 下一次可验收增量是逐供应商取得用户自有的注册客户端和 redirect/scope/受众合同，先以隔离假 OAuth/MCP 服务验证登录、列举、读写、断开/撤权与三 Agent 公共连接，再用真实账号核验。Codex Security 需先拆解 CLI、环境变量、权限、超时和工具执行合同，不能从 App 进程环境复制 43 项变量。本轮未打包；真实供应商账号尚未验收。", "");
  return lines.join("\n");
}

function main() {
  const mode = process.argv[2];
  assert.ok(["--check", "--write", "--json"].includes(mode),
    "Usage: node scripts/plugin-bundled-mcp-auth-gaps.cjs --check|--write|--json");
  const audit = inspect();
  if (mode === "--json") {
    process.stdout.write(`${JSON.stringify(audit, null, 2)}\n`);
    return;
  }
  const report = render(audit);
  if (mode === "--check") {
    assert.equal(fs.readFileSync(reportPath, "utf8"), report, "Bundled MCP auth report is stale");
    process.stdout.write("Verified 8 frozen MCP declarations and 3 remaining blockers\n");
  } else {
    fs.writeFileSync(reportPath, report);
    process.stdout.write("Wrote bundled MCP authentication/host blocker report\n");
  }
}

if (require.main === module) main();
module.exports = { inspect, render };
