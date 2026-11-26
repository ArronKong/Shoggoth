"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { NativeMcpStore } = require("../app/agent-service/native-mcp-store");
const { NativeMcpClientManager } = require("../app/agent-service/native-mcp-client-manager");
const { McpConnectorController } = require("../app/agent-service/mcp-connector-controller");
const { SecretExecutionBroker } = require("../app/agent-service/secret-execution-broker");
const { validateConnectorParams, validateConnectorResult } = require("../app/core/connector-dto");
const { validateDesktopPreset } = require("../app/agent-service/mcp-desktop-presets");
const { GoogleWorkspaceSetup, googleWorkspaceStatus } = require("../app/google-workspace-setup");
const { resolveGoogleWorkspaceCli, signedIn } = require("../app/agent-service/google-workspace-cli");
const products = ["gmail", "drive", "docs", "sheets", "slides", "calendar", "chat", "people", "tasks"];

test("the Google Cloud bulk link covers all 17 APIs and Workspace recognizes scope-only logins", async () => {
  const apis = ["gmail", "drive", "docs", "sheets", "slides", "calendar-json", "chat", "people", "tasks",
    "gmailmcp", "drivemcp", "docsmcp", "sheetsmcp", "slidesmcp", "calendarmcp", "chatmcp", "tasksmcp"].map(api => api + ".googleapis.com");
  const setup = new GoogleWorkspaceSetup({ resolve: () => { throw Object.assign(Error(), { code: "MCP_PACKAGE_RUNTIME_MISSING" }); } });
  const url = new URL((await setup.status()).enableApisUrl);
  assert.equal(url.origin + url.pathname, "https://console.cloud.google.com/flows/enableapi");
  assert.deepEqual(url.searchParams.get("apiid").split(",").sort(), apis.sort());
  assert.equal(signedIn("Granted the following scopes:\n  - https://www.googleapis.com/auth/drive.readonly\n"), true);
  assert.equal(signedIn("Logged in as the following user:\nfixture@example.test"), true);
  assert.equal(signedIn("No logged in user found.\nGranted the following scopes:\n"), false);
  const resolve = () => "/tmp/test/gwscli";
  for (const input of [{ action: "enable" }, { action: "import", path: "/secret" }, { action: "login", args: ["drive"] }, { action: "exec" }, { action: [] }]) {
    assert.throws(() => setup.start(input), { code: "MCP_TOOL_INVALID_ARGUMENTS" });
  }
  let requirement;
  validateDesktopPreset(resolve(), [], resolve(), { platform: "darwin", spawnSync: (_, argv) => { requirement = argv.at(-2); return { status: 0 }; } });
  assert.match(requirement, /anchor apple generic.*EQHXZ8M8AV.*identifier "gwscli"/u);
  assert.throws(() => validateDesktopPreset(resolve(), [], resolve(), { platform: "darwin", spawnSync: () => ({ status: 1 }) }), { code: "MCP_SERVER_PATH_INVALID" });
});

test("desktop setup installs once, imports via a native picker, and completes read-only browser authorization", async t => {
  const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "google-workspace-desktop-")));
  const command = path.join(homeDir, "gwscli");
  const config = path.join(homeDir, "Library", "Application Support", "gwscli", "client_credentials.json");
  const selectedFile = path.join(homeDir, "chosen client 'file'.json");
  const approved = path.join(homeDir, "consent");
  fs.writeFileSync(selectedFile, JSON.stringify({ installed: {
    client_id: "fixture.apps.googleusercontent.com", client_secret: "test-client-secret", auth_uri: "https://accounts.google.com/o/oauth2/auth",
    token_uri: "https://oauth2.googleapis.com/token", redirect_uris: ["http://localhost"],
  } }));
  const executable = "#!" + process.execPath + "\n" + String.raw`
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const home = process.env.HOME, [, action, ...args] = process.argv.slice(2);
const consent = path.join(home, "consent");
const config = path.join(home, "Library", "Application Support", "gwscli", "client_credentials.json");
if (action === "status") {
  console.log(fs.existsSync(path.join(home, "granted")) ? "Granted the following scopes:\n  - https://www.googleapis.com/auth/gmail.readonly" : "No logged in user found.");
} else if (action === "setup") {
  const file = args[0].split("=")[1];
  const data = fs.readFileSync(file, "utf8");
  assert.equal(JSON.parse(data).installed.client_secret, "test-client-secret");
  assert.notEqual(path.dirname(file), home);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  let text = "";
  process.stdin.setEncoding("utf8").on("data", chunk => { text += chunk; });
  process.stdin.on("end", () => {
    assert.equal(text, "Y\n");
    fs.mkdirSync(path.dirname(config), { recursive: true }); fs.writeFileSync(config, "{}");
  });
} else if (action === "login") {
  assert.deepEqual(args, ["--bundle=readonly"]);
  console.log("https://accounts.google.com.example/o/oauth2/v2/auth?response_type=code");
  console.log("https://accounts.google.com/o/oauth2/v2/auth?response_type=code&state=test&code_challenge=fixture&redirect_uri=http%3A%2F%2F127.0.0.1%3A4321%2F");
  const watch = setInterval(() => {
    if (!fs.existsSync(consent)) return;
    fs.writeFileSync(path.join(home, "granted"), "{}"); clearInterval(watch);
  }, 25);
}
`;
  let chosen = null, signIns = 0, installations = 0;
  const opened = [];
  const setup = new GoogleWorkspaceSetup({
    homeDir, env: { PATH: "/usr/bin:/bin" },
    resolve: () => {
      if (!fs.existsSync(command)) throw Object.assign(Error(), { code: "MCP_PACKAGE_RUNTIME_MISSING" });
      return command;
    },
    install: async () => { installations++; fs.writeFileSync(command, executable, { mode: 0o700 }); },
    selectClient: async () => chosen,
    openExternal: async url => { opened.push(url); return true; },
    onAuthorized: async () => { signIns++; },
  });
  t.after(() => { setup.close(); fs.rmSync(homeDir, { recursive: true, force: true }); });
  const waitFor = async state => {
    const end = Date.now() + 5000;
    do {
      const status = await setup.status();
      if (state(status)) return status;
      await new Promise(resolve => setTimeout(resolve, 25));
    } while (Date.now() < end);
    assert.fail("desktop authorization did not reach expected phase");
  };
  assert.equal((await setup.status()).state, "missing");
  assert.equal(setup.start({ action: "install" }).phase, "installing");
  assert.throws(() => setup.start({ action: "install" }), { code: "GOOGLE_WORKSPACE_BUSY" });
  await waitFor(s => s.state === "signedOut" && !s.phase);
  setup.start({ action: "install" }); await waitFor(s => !s.phase);
  assert.equal(installations, 1);
  setup.start({ action: "import" }); await waitFor(s => !s.phase);
  assert.equal(fs.existsSync(config), false, "canceling the native picker must not alter CLI configuration");
  chosen = path.join(homeDir, "invalid.json");
  fs.writeFileSync(chosen, '{"web":{}}');
  setup.start({ action: "import" });
  assert.equal((await waitFor(s => !s.phase)).errorCode, "GOOGLE_WORKSPACE_CLIENT_INVALID");
  chosen = selectedFile;
  setup.start({ action: "import" });
  await waitFor(s => s.phase === "waitingForConsent");
  assert.equal(opened.length, 1); assert.equal(new URL(opened[0]).hostname, "accounts.google.com");
  assert.equal(fs.existsSync(config), true);
  setup.start({ action: "cancel" }); await waitFor(s => s.state === "signedOut" && !s.phase);
  assert.equal(signIns, 0);
  setup.start({ action: "login" }); await waitFor(s => s.phase === "waitingForConsent");
  fs.writeFileSync(approved, "yes");
  const connected = await waitFor(s => s.state === "signedIn" && !s.phase);
  assert.equal(connected.configured, true);
  assert.equal(signIns, 1); assert.equal(opened.length, 2);
  assert.doesNotMatch(JSON.stringify(connected), /test-client-secret|chosen client|code_challenge|local files/u);
});

test("a signed-in Workspace connector verifies, reuses its id, discovers all services, and binds one-time approvals to the waiting process", async t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "workspace-connector-test-"));
  const paths = resolveServicePaths({ homeDir: root, trustedRoot: root, stateRoot: path.join(root, "state"), cacheRoot: path.join(root, "cache"), profileRoot: path.join(root, "profiles") });
  const cli = path.join(root, ".local/bin/gwscli");
  fs.mkdirSync(path.dirname(cli), { recursive: true }); fs.mkdirSync(paths.defaultWorkspaceDir, { recursive: true });
  const env = { HOME: root, TMPDIR: root, PATH: "/usr/bin:/bin" };
  // This child implements the documented stdout/stderr/stdin contract. No Google identity or network.
  fs.writeFileSync(cli, "#!" + process.execPath + "\n" + String.raw`
const fs = require("node:fs"), path = require("node:path");
const root = process.env.HOME, [service, action, ...args] = process.argv.slice(2);
if (service === "auth" && action === "status") console.log(fs.existsSync(path.join(root, "signed-in")) ? "Granted the following scopes:\n  - https://www.googleapis.com/auth/drive.readonly" : "No logged in user found.");
else if (action === "--help") console.log("Available Commands:\n  create_draft  Create a draft.\n  search_people  Search for a contact.\n  search_threads  Search mail.\n  download_file_content  Download file content.\n\nFlags:\n  -h, --help   Print help");
else if (args.includes("--help")) console.log("Usage:\n  gwscli service action\n\nFlags:\n      --to stringArray  Recipients.\n      --fileId string   Drive file ID.\n      --filePath string  Local file.\n  -o, --destinationPath string   Local destination.\n      --show-scopes    Show scopes.\n\nGlobal Flags:\n      --oauth_token string   Override.");
else if (action === "download_file_content") fs.writeFileSync(args.find(arg => arg.startsWith("--destinationPath=")).slice(18), "hello");
else if (action === "search_threads") {
  fs.appendFileSync(path.join(root, "search-executions"), "1\n");
  console.error(JSON.stringify({ isError: true, resultType: "complete", content: [{
    type: "text", text: "Access to this tool requires that your Google Cloud project (1234567890) is enrolled in the Google Workspace Developer Preview Program. Fixture-only diagnostics."
  }] }));
  process.exitCode = 1;
}
else {
  process.stderr.write("Approve this draft?\napproval_choice\n(Options: Allow once, Always allow this tool, Don't allow)");
  process.stdin.once("data", data => { const answer = data.toString().trim(); fs.appendFileSync(path.join(root, "answers"), answer + "\n"); console.log(JSON.stringify(args)); process.exit(answer === "ALLOW_ONCE" ? 0 : 1); });
}
`, { mode: 0o700 });
  const validated = [];
  const store = new NativeMcpStore({ paths, validateDesktopPreset: (cmd, args, real) => { assert.equal(cmd, cli); assert.deepEqual(args, []); assert.equal(real, cli); validated.push(cmd); } }).open();
  const manager = new NativeMcpClientManager({ store, env });
  const controller = new McpConnectorController({ store, manager, paths, oauth: { close: async () => {} }, secrets: { remove: async () => {} } }).open();
  t.after(async () => { await controller.close(); await manager.close(); store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const control = async (method, params) => validateConnectorResult(method, await controller.handle(method, validateConnectorParams(method, params)));
  const hostStatus = () => googleWorkspaceStatus({ resolve: () => resolveGoogleWorkspaceCli(env), run: (cmd, args, opts) => promisify(execFile)(cmd, args, { ...opts, env }) });
  assert.deepEqual(await hostStatus(), { state: "signedOut" });
  const add = () => control("connector.mcp.add", { source: { kind: "custom" }, name: "Google Workspace", option: { kind: "stdio-command", command: "gwscli", args: [], cwd: "" }, expectedRevision: store.revision });
  let result = await add();
  assert.equal(result.server.status, "signedOut");
  const id = result.server.id;
  fs.writeFileSync(path.join(root, "signed-in"), "1");
  assert.deepEqual(await hostStatus(), { state: "signedIn" });
  // There is no UI poll or explicit verify here. The Service must finish a detached sign-in.
  const deadline = Date.now() + 15000;
  while (store.get(id).status !== "ready" && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(store.get(id).status, "ready");
  result = await control("connector.mcp.verify", { id });
  assert.equal(result.server.status, "ready"); assert.equal(result.server.recommendationId, "google-workspace");
  assert.equal((await add()).server.id, id); assert.equal(store.list().servers.length, 1);
  assert.equal(store.getPrivate(id).secretRef, null); assert.ok(validated.length >= 2);
  const available = await manager.listTools(id);
  assert.deepEqual(available.map(tool => tool.name), ["list_actions", "describe_action", "run_action"]);
  for (const tool of available) assert.deepEqual(tool.inputSchema.properties.service.enum, products);
  const invoke = (tool, args, options) => manager.callTool(id, tool, args, options);
  assert.ok(JSON.parse((await invoke("list_actions", { service: "people" })).content[0].text).search_people);
  const broker = new SecretExecutionBroker({ paths, cryptoBroker: {
    encrypt: async value => Buffer.from(value), decrypt: async value => Buffer.from(value),
  }, secrets: { resolve: (_scope, value) => value, project: (_scope, value) => value } });
  await broker.open();
  try {
    const request = { scope: { profileId: "fixture-profile", sessionId: "fixture-session" }, callId: "preview-denial",
      tool: "mcp:" + id + ":run_action", args: { service: "gmail", action: "search_threads", parameters: {} }, assertCurrent() {},
      invoke: args => invoke("run_action", args) };
    const denied = await broker.execute(request);
    assert.equal(denied.result.isError, true);
    assert.equal(denied.result.structuredContent.code, "GOOGLE_WORKSPACE_PREVIEW_REQUIRED");
    assert.match(denied.result.content[0].text, /developers\.google\.com\/workspace\/preview/u);
    assert.doesNotMatch(JSON.stringify(denied.result), /1234567890|Fixture-only/u);
    const repeated = await broker.execute(request);
    assert.equal(repeated.recovered, true);
    assert.deepEqual(repeated.result, denied.result);
    assert.equal(fs.readFileSync(path.join(root, "search-executions"), "utf8"), "1\n");
  } finally {
    await broker.close();
  }
  const args = { service: "gmail", action: "create_draft" };
  const help = (await invoke("describe_action", args)).content[0].text;
  assert.match(help, /--to stringArray/u); assert.doesNotMatch(help, /oauth_token|filePath|destinationPath|show-scopes/u);
  for (const parameters of [{ filePath: "/tmp/private" }, { destinationPath: "/tmp/out" }, { oauth_token: "secret" }, { show: true }]) {
    await assert.rejects(invoke("run_action", { ...args, parameters }), { code: "MCP_TOOL_INVALID_ARGUMENTS" });
  }
  await assert.rejects(invoke("run_action", { service: "auth", action: "login", parameters: {} }), { code: "MCP_TOOL_INVALID_ARGUMENTS" });
  let reviews = 0;
  const run = (options, reviewedWrite = true) => invoke("run_action", { ...args, parameters: { to: ["a@example.test", "b@example.test"] } }, { reviewedWrite, ...options });
  await assert.rejects(run({}, false), { code: "MCP_TOOL_CONFIRMATION_REQUIRED" });
  await assert.rejects(run({ requestApproval: async message => { assert.equal(message, "Google Workspace"); return false; } }, false), { code: "MCP_EXTERNAL_APPROVAL_DENIED" });
  const allowed = await run({ requestApproval: async message => {
    reviews++; assert.match(message, /Approve this draft/u);
    await assert.rejects(invoke("list_actions", { service: "auth" }), { code: "MCP_TOOL_INVALID_ARGUMENTS" });
    return true;
  } });
  assert.deepEqual(JSON.parse(allowed.content[0].text), ["--to=a@example.test", "--to=b@example.test"]);
  await assert.rejects(run({ requestApproval: async () => { reviews++; return false; } }), { code: "MCP_EXTERNAL_APPROVAL_DENIED" });
  await assert.rejects(run({}), { code: "MCP_TOOL_CONFIRMATION_REQUIRED" });
  const aborted = new AbortController();
  await assert.rejects(run({ signal: aborted.signal, requestApproval: async () => { aborted.abort(); return true; } }), { code: "MCP_SERVER_RESULT_UNKNOWN" });
  assert.equal(reviews, 2);
  assert.deepEqual(fs.readFileSync(path.join(root, "answers"), "utf8").trim().split("\n"), ["ALLOW_ONCE", "DENY_ONCE"]);
  const file = await invoke("run_action", { service: "drive", action: "download_file_content", parameters: { fileId: "file-1" } });
  assert.equal(JSON.parse(file.content[0].text).base64Content, Buffer.from("hello").toString("base64"));
  await assert.rejects(control("connector.mcp.credentials.update", { id, expectedRevision: store.revision, fields: { env: { TOKEN: "fake" } } }), { code: "MCP_SECRET_INVALID" });
  await control("connector.mcp.remove", { id, expectedRevision: store.revision });
  assert.equal(store.list().servers.length, 0);
});
