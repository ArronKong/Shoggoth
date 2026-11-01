#!/usr/bin/env node
"use strict";
// Production controllers and execution bridge; a local website and a desktop
// driver fixture are the targets. No user browser profile or account is used.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const crypto = require("node:crypto"), http = require("node:http");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { TemporarySecretStore } = require("../app/agent-service/temporary-secret-store");
const { SecretExecutionBroker } = require("../app/agent-service/secret-execution-broker");
const { BrowserUseController } = require("../app/agent-service/browser-use-controller");
const { ComputerUseController } = require("../app/agent-service/computer-use-controller");
const { WorkspaceExecutionService } = require("../app/agent-service/workspace-execution");
const { browserArguments, secretEnvironment } = require("../app/agent-service/secret-tool-arguments");
const root = fs.realpathSync(fs.mkdtempSync("/private/tmp/sg-sec-exec-"));
const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state"),
  profileRoot: path.join(root, "profile"), cacheRoot: path.join(root, "cache") });
const workspace = path.join(root, "workspace"); fs.mkdirSync(workspace, { mode: 0o700 });
const key = crypto.randomBytes(32);
const cryptoBroker = {
  async encrypt(bytes) {
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
  },
  async decrypt(bytes) {
    const cipher = crypto.createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
    cipher.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]);
  },
};
const scope = { profileId: "fixture-profile", sessionId: "fixture-session" }, current = () => {};
const secrets = new TemporarySecretStore({ paths, cryptoBroker });
const execution = new SecretExecutionBroker({ paths, cryptoBroker, secrets });
let browser, desktop, commands, expected, reference;
const received = [], modelBodies = [], driverCalls = [];
const website = http.createServer(async (req, res) => {
  if (req.method === "POST") {
    let body = ""; for await (const part of req) body += part;
    if (req.url === "/model") { assert(!body.includes(expected)); modelBodies.push(JSON.parse(body)); }
    else received.push(body);
    res.end("ok"); return;
  }
  res.setHeader("Content-Type", "text/html");
  res.end('<!doctype html><label>Arbitrary fixture field<input id="input" type="text"></label><p id="echo"></p><script>input.addEventListener("input",()=>{echo.textContent=input.value;console.log(input.value);fetch("/received",{method:"POST",body:input.value})})</script>');
});
const model = async value => fetch(`http://127.0.0.1:${website.address().port}/model`, { method: "POST", body: JSON.stringify(value) });
const invoke = async (tool, args, call, resolve = false) => {
  const result = await execution.execute({ scope, callId: crypto.randomUUID(), tool, args, assertCurrent: current, resolve,
    invoke: async value => { try { return await call(value); } catch (error) { console.error(JSON.stringify({ fixtureTool: tool, code: error.code, name: error.name })); throw error; } } });
  await model(result.result); return result;
};
function noPlaintext(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) noPlaintext(file);
    else if (entry.isFile()) assert(!fs.readFileSync(file).includes(Buffer.from(expected)), `plaintext persisted in ${path.relative(root, file)}`);
  }
}
async function main() {
  await secrets.open(); await execution.open();
  // A random value avoids accidental overlap with snapshot IDs and telemetry.
  expected = "fixture-" + crypto.randomBytes(16).toString("hex");
  reference = (await secrets.prepare({ scope, operationId: "input", text: `密码是 "${expected}"` })).references[0].reference;
  await new Promise(resolve => website.listen(0, "127.0.0.1", resolve));
  browser = new BrowserUseController({ paths, getSettings: () => ({ enabled: true, browser: "chrome", headless: true, isolated: true }), isAuthorized: () => true });
  browser.open();
  const session = await browser.create({ profileId: scope.profileId, workRunId: "browser-run", workspace });
  const binding = { sessionId: session.id, profileId: scope.profileId, workRunId: "browser-run" };
  const bindings = secrets.list(scope).map(item => ({ ...item, value: secrets.resolve(scope, item.reference) }));
  const secretContext = { scope, bindings, isCurrent: () => secrets.list(scope).some(item => item.reference === reference) };
  const browserCall = async (name, args) => invoke(`browser:${name}`, args, () => browser.callTool({ ...binding, toolName: name, arguments: args },
    { secretContext, resolveArguments: (tool, values) => browserArguments(tool, values, text => secrets.resolve(scope, text, current)) }));
  const page = await browserCall("browser_navigate", { url: `http://127.0.0.1:${website.address().port}` });
  const text = JSON.stringify(page.result), ref = /textbox[^\n]*?\[ref=([^\]]+)\]/u.exec(text.replaceAll("\\n", "\n"))?.[1];
  assert(ref, "actual page snapshot must expose the new textbox: " + text);
  const fill = await browserCall("browser_type", { element: "Arbitrary fixture field", target: ref, text: reference });
  assert.equal(received.at(-1), expected, "the previously unknown page/field receives the original value");
  assert(!JSON.stringify(fill.result).includes(expected));
  const snapshot = await browserCall("browser_snapshot", {});
  assert(JSON.stringify(snapshot.result).includes(reference), "ordinary text-box echo is projected");
  assert(JSON.stringify((await execution.display(scope, snapshot.receiptId)).result).includes(reference), "engine output keeps references even for the local result viewer");
  assert.throws(() => browserArguments("browser_evaluate", { function: `()=>${JSON.stringify(reference)}` }, value => secrets.resolve(scope, value)), { code: "SECRET_TOOL_NOT_SUPPORTED" });
  noPlaintext(workspace);
  await browser.close(); browser = null;

  const driver = { async metadata() { return { driverVersion: "0.22.0", contractVersion: "0.7.0", embedded: true, pid: 987 }; },
    async startSession() { return { active: true }; }, async endSession() { return { active: false }; }, async shutdown() {},
    async callTool(name, json) {
      const args = JSON.parse(json); driverCalls.push({ name, args });
      let value = {};
      if (name === "list_apps") value = { apps: [{ name: "Fixture", bundle_id: "com.example.fixture", pid: 42, running: true, active: false }] };
      if (name === "list_windows") value = { windows: [{ app_name: "Fixture", pid: 42, window_id: 7, title: "Fixture", bounds: { x: 0, y: 0, width: 100, height: 100 }, is_on_screen: true }] };
      if (name === "get_window_state") {
        assert.equal(args.include_screenshot, false);
        value = { snapshot_id: "snapshot-fixture", tree_markdown: `echo ${expected}`, elements: [
          { element_index: 1, element_token: "fixture-target", role: "secure text field", label: "Password", value: expected, frame: { x: 1, y: 1, w: 40, h: 10 } },
        ] };
      }
      return { isError: false, degraded: false, images: [], structuredJson: JSON.stringify(value), action: { effect: 0, route: 0 } };
    } };
  const factory = { new: value => value };
  desktop = new ComputerUseController({ paths, binaryPath: path.join(root, "fixture-driver"),
    binaryManifest: { version: "0.22.0", contractVersion: "0.7.0" }, verifyBinary: false,
    sdkLoader: async () => ({ CuaDriver: { createPrivateWorker: () => driver }, RuntimeAuthorizationOptions: factory,
      ConfiguredDriverOptions: factory, PrivateWorkerOptions: factory, EmbeddedEnvironmentVariable: factory,
      StartSessionInput: factory, EndSessionInput: factory, SessionPermissionMode: { Bounded: 1 },
      currentMacOsPermissionStatus: () => ({ accessibility: true, screenRecording: true }) }),
    isAuthorized: () => true, permissionStatus: () => ({ accessibility: true, screenRecording: true }),
    getSystemIdleTime: () => 100, isScreenLocked: () => false });
  desktop.open();
  const desktopSession = await desktop.create({ profileId: scope.profileId, workRunId: "desktop-run", allowedApplications: ["com.example.fixture"] });
  const desktopBinding = { sessionId: desktopSession.id, profileId: scope.profileId, workRunId: "desktop-run", pid: 42, windowId: 7 };
  const original = await desktop.snapshot(desktopBinding, { textOnly: true });
  assert.equal(original.image, null);
  const projected = await secrets.project(scope, original, { model: true }); await model(projected);
  assert(projected.tree.includes(reference)); assert.equal(projected.elements[0].value, "");
  const input = { ...desktopBinding, action: "type", ref: "c1", snapshotRevision: original.snapshotRevision, text: reference };
  await assert.rejects(desktop.action(input), { code: "COMPUTER_SECURE_INPUT_FORBIDDEN" });
  input.snapshotRevision = (await desktop.snapshot(desktopBinding, { textOnly: true })).snapshotRevision;
  await invoke("computer_type", { text: reference }, () => desktop.action(input, { resolveSecretText: value => secrets.resolve(scope, value, current) }));
  assert.equal(driverCalls.find(item => item.name === "type_text").args.text, expected);
  await assert.rejects(desktop.action(input, { resolveSecretText: value => secrets.resolve(scope, value, current) }), { code: "COMPUTER_SNAPSHOT_STALE" });
  noPlaintext(paths.computerEphemeralDir);
  await desktop.close(); desktop = null;

  commands = new WorkspaceExecutionService({ cacheDir: path.join(root, "command-control"), paths: { trustedRoot: root, homeDir: root } });
  const run = { id: "command-run", profileId: scope.profileId, workspace, source: "chat" };
  const contract = { ...run, runId: run.id, runtime: "antigravity", permissionMode: "auto-review",
    permissionPolicy: { sandbox: "workspace-write", approvalPolicy: "on-request" }, workspaceExecutionVersion: 1 };
  const args = { command: "printf '%s' \"$FIXTURE_CREDENTIAL\"", secretEnv: { FIXTURE_CREDENTIAL: reference } };
  assert(secretEnvironment(args.secretEnv)); assert(!secretEnvironment({ NODE_OPTIONS: reference }));
  const command = await invoke("workspace_execute", args, () => commands.execute({ run, contract, args,
    scope: { runId: run.id, assertCurrent: current }, resolveSecretEnvironment: () => ({ FIXTURE_CREDENTIAL: secrets.resolve(scope, reference, current) }) }));
  assert.equal(command.result.exitCode, 0); assert.equal(command.result.stdout, reference);
  assert.equal((await execution.display(scope, command.receiptId)).result.stdout, expected);
  noPlaintext(path.join(root, "command-control"));
  const longRun = commands.execute({ run, contract, args: { ...args, command: "touch command-started; sleep 20; touch command-finished" },
    scope: { runId: run.id, assertCurrent: current }, resolveSecretEnvironment: () => ({ FIXTURE_CREDENTIAL: secrets.resolve(scope, reference, current) }) });
  const stopped = assert.rejects(longRun, { code: "HOST_CAPABILITY_REVOKED" });
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(path.join(workspace, "command-started")) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert(fs.existsSync(path.join(workspace, "command-started")));
  await execution.revokeReference(scope, reference);
  await stopped;
  assert(!fs.existsSync(path.join(workspace, "command-finished")), "revocation stops the process holding the credential environment");
  noPlaintext(paths.stateDir); noPlaintext(workspace);
  assert(!JSON.stringify(modelBodies).includes(expected));
  console.log(JSON.stringify({ pass: true, actualBrowser: "isolated Chrome + Playwright MCP", dynamicTarget: true,
    browserEcho: "reference", desktop: "production controller + fixture driver, secure field and stale snapshot enforced",
    screenshot: "text-only fallback", command: "real sandboxed process, private stdin configuration, in-flight revocation stops process", modelBodies: modelBodies.length }));
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(async () => {
  await browser?.close(); await desktop?.close(); await commands?.close();
  await execution.close(); await secrets.close(); key.fill(0);
  website.closeAllConnections(); await new Promise(resolve => website.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
});
