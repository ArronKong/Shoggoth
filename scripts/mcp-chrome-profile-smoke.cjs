#!/usr/bin/env node
"use strict";
// Real pinned MCP + installed Chrome, with a disposable profile and loopback-only
// synthetic login. Supply a local package entry; this test never installs one.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { NativeMcpClientManager } = require("../app/agent-service/native-mcp-client-manager");
const { McpPackageLauncher } = require("../app/agent-service/mcp-package-launcher");
const { resolveServicePaths } = require("../app/agent-service/paths");

async function main() {
  const entry = process.argv.find(arg => arg.startsWith("--mcp-entry="))?.slice(12);
  assert.ok(entry && path.isAbsolute(entry) && fs.statSync(entry).isFile(), "provide --mcp-entry=/absolute/path/to/chrome-devtools-mcp.js");
  const packageRoot = path.resolve(path.dirname(entry), "../../..");
  const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  assert.equal(pkg.name, "chrome-devtools-mcp"); assert.equal(pkg.version, "1.12.0");
  const baseline = process.argv.includes("--baseline");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sgh-chrome-login-")));
  // Exercise the production npx process tree without a network install, user npm
  // configuration or global cache. The supplied, version-checked package is local.
  fs.mkdirSync(path.join(root, "node_modules/.bin"), { recursive: true });
  const localPackage = path.join(root, "node_modules/chrome-devtools-mcp");
  fs.cpSync(packageRoot, localPackage, { recursive: true, mode: fs.constants.COPYFILE_FICLONE });
  const localEntry = path.join(localPackage, path.relative(packageRoot, entry));
  fs.chmodSync(localEntry, 0o700); // npm normally makes its bin entry executable.
  fs.symlinkSync(localEntry, path.join(root, "node_modules/.bin/chrome-devtools-mcp"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ private: true, dependencies: { "chrome-devtools-mcp": pkg.version } }));
  const npmEnv = { NPM_CONFIG_CACHE: path.join(root, "npm-cache"), NPM_CONFIG_USERCONFIG: path.join(root, "user.npmrc"), NPM_CONFIG_GLOBALCONFIG: path.join(root, "global.npmrc") };
  fs.writeFileSync(npmEnv.NPM_CONFIG_USERCONFIG, "", { mode: 0o600 });
  fs.writeFileSync(npmEnv.NPM_CONFIG_GLOBALCONFIG, "", { mode: 0o600 });
  let loginIssued = false, manager, stderr = "";
  const server = http.createServer((req, res) => {
    // Restoring a tab must never issue another login and hide a missing cookie.
    const login = req.url === "/login" && !loginIssued;
    if (login) {
      loginIssued = true;
      res.setHeader("Set-Cookie", ["durable=fixture; Max-Age=86400; Path=/; SameSite=Lax", "session=fixture; Path=/; SameSite=Lax"]);
    }
    if (req.url === "/logout") res.setHeader("Set-Cookie", ["durable=; Max-Age=0; Path=/", "session=; Max-Age=0; Path=/"]);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<title>Local login persistence fixture</title><p>Local fixture</p>${login ? '<script>localStorage.setItem("login", "fixture")</script>' : req.url === "/logout" ? '<script>localStorage.removeItem("login")</script>' : ""}`);
  });
  const paths = resolveServicePaths({ homeDir: root, userDataRoot: path.join(root, "app-data"), trustedRoot: root });
  const preset = require("../app/agent-service/data/mcp-featured-presets.json").find(row => row.id === "chrome-devtools");
  const record = { id: "chrome-fixture", enabled: true, secretRef: "fixture-npm-environment", transport: structuredClone(preset.transport) };
  if (baseline) record.transport.packageArgs.push(`--user-data-dir=${path.join(root, "legacy-cache")}`);
  const store = { get: () => record, paths };
  const launcher = new McpPackageLauncher();
  const packageLauncher = { prepare: async (transport, options) => {
    const launch = await launcher.prepare({ ...transport, packageArgs: [...transport.packageArgs, "--headless", "--no-page-id-routing"] }, { ...options, cwd: root });
    return { ...launch, args: ["--offline", ...launch.args] };
  } };
  const open = () => manager = new NativeMcpClientManager({ store, packageLauncher, secrets: { get: async () => ({ env: npmEnv }) },
    spawn(command, args, options) {
      const child = spawn(command, args, options);
      child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-8192); });
      return child;
    } });
  const call = async (name, args) => {
    const result = await manager.callTool(record.id, name, args);
    assert.ok(!result.isError, JSON.stringify(result)); return result;
  };
  const state = async () => {
    const result = await call("evaluate_script", { function: '() => ({durable:document.cookie.includes("durable=fixture"), session:document.cookie.includes("session=fixture"), local:localStorage.getItem("login")==="fixture"})' });
    const raw = result.content.filter(c => c.type === "text").map(c => c.text).join("\n");
    const match = raw.match(/```json\s*([\s\S]*?)\s*```/);
    assert.ok(match, raw); return JSON.parse(match[1]);
  };
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const signedIn = { durable: true, session: true, local: true };
    const signedOut = { durable: false, session: false, local: false };
    open();
    const tools = (await manager.listTools(record.id)).length;
    await call("new_page", { url: `${origin}/login` });
    assert.deepEqual(await state(), signedIn);
    // Leave no page that can create new login state during session restoration.
    await call("navigate_page", { url: `${origin}/inspect` });
    await manager.close(); open();
    await call("new_page", { url: `${origin}/inspect` });
    const afterRestart = await state();
    console.log(JSON.stringify({ baseline, launch: "npx-offline", tools, afterRestart, loginIssuedOnlyOnce: loginIssued }));
    assert.deepEqual(afterRestart, baseline ? { ...signedIn, session: false } : signedIn);
    if (!baseline) {
      const profile = path.join(paths.userDataRoot, "mcp-browser-profiles", record.id);
      assert.equal(fs.statSync(profile).mode & 0o777, 0o700);
      await call("new_page", { url: `${origin}/inspect`, isolatedContext: "explicit-private-context" });
      assert.deepEqual(await state(), signedOut, "an explicit private context stays isolated");
      await call("new_page", { url: `${origin}/logout` });
      assert.deepEqual(await state(), signedOut);
      await manager.close(); open();
      await call("new_page", { url: `${origin}/inspect` });
      assert.deepEqual(await state(), signedOut, "an explicit logout stays logged out after restart");
      console.log("PASS real Chrome restart: durable/session cookies and localStorage persist; private contexts stay isolated; logout persists");
    } else console.log("PASS reproduced: default browser restart drops a session cookie while durable cookies and localStorage survive");
  } catch (error) {
    console.error(stderr); throw error;
  } finally {
    await manager?.close();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
