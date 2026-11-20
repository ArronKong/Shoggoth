"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createAgentService } = require("../app/agent-service/server");
const { resolveCanonicalServicePaths } = require("../app/agent-service/paths");
const { OpenCodeRuntimePool } = require("../app/agent-service/opencode-runtime-pool");
const { OpenCodeRuntimeHost } = require("../app/agent-service/opencode-runtime-host");
const { RuntimeMcpGateIssuer } = require("../app/agent-service/runtime-mcp-gate");
const { WorkspaceExecutionService } = require("../app/agent-service/workspace-execution");
const { LARK_AGENT_SERVER_ID } = require("../app/agent-service/lark-cli-agent-tools");
const { prepareFixture } = require("./fixtures/lark-cli-fixture.cjs");

async function waitForApproval(coordinator, runId) {
  const deadline = Date.now() + 5000;
  do {
    const run = coordinator.getRun(runId);
    if (run.status === "waiting_approval") return run.waitingRequestId;
    await new Promise(resolve => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  assert.fail("Expected a Shoggoth approval request");
}

async function main() {
  const root = fs.mkdtempSync("/private/tmp/shg-oc-");
  const paths = resolveCanonicalServicePaths({ userInfo: () => ({ homedir: root }) });
  const issuer = new RuntimeMcpGateIssuer({ paths, mcpHelperLaunch: { command: process.execPath, argsPrefix: [] } });
  const fixture = path.join(__dirname, "fixtures/opencode-mcp-local.cjs");
  const pool = new OpenCodeRuntimePool({
    paths, mcpGateIssuer: issuer, parentEnv: { HOME: root, PATH: "/usr/bin:/bin" },
    runtimeAccountResolver: { resolve: binding => Object.freeze({
      runtime: "opencode", runtimeAccountId: binding.runtimeAccountId,
      home: root, binaryPath: process.execPath, configSourceHome: root,
      configurationMode: "native", launchArgs: Object.freeze([]),
      spawnEnv: Object.freeze({ HOME: root, XDG_DATA_HOME: root }),
    }) },
    spawnProcess(command, args, options) {
      return spawn(command, [fixture, args[0] === "--version" ? "version" : "serve", root], options);
    },
    hostFactory(options) {
      const host = new OpenCodeRuntimeHost(options);
      // The fixture never makes a model request.
      const initialize = host.initialize.bind(host);
      host.initialize = async () => {
        const result = await initialize();
        host.modelSecretRoute = { ready: () => true, close() {} };
        return result;
      };
      return host;
    },
  });
  const workspaceExecutionService = new WorkspaceExecutionService({
    cacheDir: path.join(paths.cacheDir, "workspace-execution"), paths,
    requestApproval: input => service.workRunCoordinator.requestWorkspaceApproval(input),
    pauseRuntimeTimeout: input => service.workRunCoordinator.pauseManagedWorkspaceTimeout(input),
  });
  const cliCalls = [];
  let authorized = false;
  const json = value => ({ stdout: JSON.stringify(value), stderr: "", exitCode: 0 });
  const service = createAgentService({
    paths, runtimeMcpGateIssuer: issuer, openCodeRuntimePool: pool, workspaceExecutionService,
    builtinCliProfiles: true, builtinCliInstalledAccountIds: ["native-opencode-default-v1"],
    version: "opencode-local-connector-fixture", parentEnv: { HOME: root },
    larkCliOptions: { prepare: prepareFixture, setupOptions: { run: async (executable, argv, options) => {
      assert.equal(options.cwd, root);
      assert.equal(options.env.HOME, root);
      assert.ok(executable.startsWith(path.join(paths.stateDir, "runtime-bin", "lark-cli") + path.sep));
      cliCalls.push({ executable, argv, input: options.input });
      if (argv[0] === "auth") return json({ appId: "cli_fixture", brand: "feishu",
        identities: { user: { available: authorized, verified: authorized && argv.includes("--verify") || undefined,
          userName: "private-fixture-account", accessToken: "private-token-canary" } } });
      if (argv[1] === "+workbook-create") return json({ ok: true, data: { spreadsheet_token: "fixture-sheet",
        url: "https://example.test/sheets/fixture-sheet" } });
      if (argv[1] === "+cells-set") return json({ ok: true, data: { updated: 1 } });
      if (argv[1] === "+base-create") return json({ ok: true, data: { base_token: "fixture-base", table_id: "tblFixture" } });
      if (argv[1] === "+record-batch-create") return json({ ok: true, data: { records: [{ record_id: "recFixture" }] } });
      assert.fail(`Unexpected fixture CLI call: ${argv[0]} ${argv[1]}`);
    } } },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value),
      decryptString: value => value.toString() },
  });
  try {
    await service.start();
    const profile = service.productStore.listAgentProfiles().find(item => item.runtime === "opencode");
    assert(profile);
    const coordinator = service.workRunCoordinator;
    const workspace = path.join(paths.defaultWorkspaceDir, profile.id);
    fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
    const session = service.chatSessionStore.createSession({
      profileId: profile.id, workspace, operationId: "connector-session", createdAt: Date.now(),
    });
    service.chatSessionStore.setPermissionMode(session.sessionKey, "auto-review");
    const ack = await coordinator.send({ sessionKey: session.sessionKey, operationId: "connector-run", prompt: "fixture" });
    await coordinator.waitForIdle(ack.run.id);
    const run = coordinator.getRun(ack.run.id);
    assert.equal(run.status, "running", JSON.stringify(run));
    assert.equal(coordinator.runExecutionContracts.get(run.id).workspaceExecutionVersion, 1);
    const host = [...pool.entries.values()].find(item => item.host.mcpExecutionRunId === run.id)?.host;
    assert(host);
    const call = async (name, args = {}) => (await host.client.request("POST", "/fixture/call",
      { name, arguments: args }, { timeoutMs: 10000 })).data.result;
    const result = await call("workspace_execute", { command: "echo hello" });
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.equal(result.structuredContent.exitCode, 0);
    assert.equal(result.structuredContent.stdout, "hello\n");
    const deniedPrivatePath = path.join(paths.stateDir, "runtime-bin");
    fs.mkdirSync(deniedPrivatePath, { mode: 0o700, recursive: true });
    const denied = await call("workspace_execute", {
      command: "echo should-not-run", access: { readPaths: [deniedPrivatePath] }, reason: "Read protected service storage",
    });
    assert.equal(denied.isError, true);
    assert.match(JSON.stringify(denied), /WORKSPACE_EXECUTION_SCOPE_INVALID/u);
    assert.equal(coordinator.getRun(run.id).status, "running");
    const network = call("workspace_execute", {
      command: "printf permitted", access: { network: true }, reason: "Verify the approval flow using an isolated command",
    });
    const approve = async (operationId, choice) => coordinator.respondApproval({
      operationId, runId: run.id, requestId: await waitForApproval(coordinator, run.id), choice,
    });
    await approve("fixture-deny-network", "deny");
    assert.match(JSON.stringify(await network), /WORKSPACE_EXECUTION_APPROVAL_DENIED/u);
    const safeNetwork = call("workspace_execute", {
      command: "printf permitted", access: { network: true }, reason: "Verify approval followed by command output",
    });
    await approve("fixture-allow-network", "once");
    assert.equal((await safeNetwork).structuredContent.stdout, "permitted");
    const interrupted = await call("workspace_execute", {
      command: "printf started > once.txt; sleep 8", timeoutMs: 1500,
    });
    assert.match(JSON.stringify(interrupted), /SECRET_TOOL_OUTCOME_UNKNOWN/u);
    assert.equal(fs.readFileSync(path.join(workspace, "once.txt"), "utf8"), "started");

    assert.equal((await call("mcp_server_list")).structuredContent.localConnectors, undefined);
    const lark = service.larkCliConnectorController;
    await lark.handle("connector.lark.install", { expectedRevision: lark.status().revision });
    assert.equal((await call("mcp_server_list")).structuredContent.localConnectors[0].accountState, "needsAuthorization");
    authorized = true;
    const connector = (await call("mcp_server_list")).structuredContent.localConnectors[0];
    assert.equal(connector.id, LARK_AGENT_SERVER_ID);
    assert.equal(connector.accountState, "authorized");
    assert.equal(connector.toolsAvailable, true);
    assert.doesNotMatch(JSON.stringify(connector), /private-fixture-account|private-token-canary|runtime-bin/u);
    const state = await call("app_state_get", { section: "connectors", cursor: null, limit: 20 });
    assert.ok(state.structuredContent.items.some(item => item.id === connector.id && item.accountState === "authorized"));
    const tools = await call("mcp_server_tools", { serverId: connector.id, cursor: 0, limit: 20 });
    assert.ok(tools.structuredContent.items.some(item => item.name === "lark_sheets_create_workbook"));
    const larkCall = (toolName, args) => call("mcp_server_call", { serverId: connector.id, toolName, arguments: args });
    const account = await larkCall("lark_account_status", {});
    assert.equal(account.isError, false, JSON.stringify(account));
    assert.deepEqual(JSON.parse(account.structuredContent.result.content[0].text), { authorized: true, verification: "verified" });
    assert.doesNotMatch(JSON.stringify(account), /private-token-canary/u);
    const invalid = await larkCall("lark_sheets_create_workbook", { title: "Fixture", command: "extra" });
    assert.match(JSON.stringify(invalid), /MCP_TOOL_INVALID_ARGUMENTS/u);
    const create = { title: "招聘汇总", values: [["公司", "岗位"], ["示例", "设计师"]] };
    const denyCreate = larkCall("lark_sheets_create_workbook", create);
    await approve("fixture-deny-lark", "deny");
    assert.match(JSON.stringify(await denyCreate), /LARK_CLI_ACCESS_DENIED/u);
    assert.equal(cliCalls.filter(item => item.argv[0] === "sheets").length, 0);
    const createWorkbook = larkCall("lark_sheets_create_workbook", create);
    await approve("fixture-allow-lark", "once");
    const workbook = await createWorkbook;
    assert.equal(workbook.isError, false, JSON.stringify(workbook));
    assert.equal(JSON.parse(workbook.structuredContent.result.content[0].text).spreadsheet_token, "fixture-sheet");
    const calls = cliCalls.filter(item => item.argv[0] === "sheets");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].argv, ["sheets", "+workbook-create", "--as", "user", "--json", "--title=招聘汇总", "--values=-"]);
    assert.deepEqual(JSON.parse(calls[0].input), create.values);
    const writeCells = larkCall("lark_sheets_write_cells", { spreadsheetToken: "fixture-sheet", sheetId: "first",
      startCell: "B2", values: [[{ text: "设计师", link: "https://example.test/job" }]] });
    await approve("fixture-allow-cells", "once");
    assert.equal((await writeCells).isError, false);
    const cellWrite = cliCalls.at(-1);
    assert.ok(cellWrite.argv.includes("--allow-overwrite=false"));
    assert.deepEqual(JSON.parse(cellWrite.input), [[{ rich_text: [{ type: "link", text: "设计师", link: "https://example.test/job" }] }]]);
    const createBase = larkCall("lark_base_create", { name: "招聘汇总", tableName: "岗位",
      fields: [{ name: "岗位", type: "text" }] });
    await approve("fixture-allow-base", "once");
    assert.equal((await createBase).isError, false);
    assert.equal(cliCalls.at(-1).argv[1], "+base-create");
    const addRecords = larkCall("lark_base_add_records", { baseToken: "fixture-base", tableId: "tblFixture",
      records: [{ 岗位: "设计师" }] });
    await approve("fixture-allow-records", "once");
    assert.equal((await addRecords).isError, false);
    assert.ok(cliCalls.at(-1).argv.includes('--json={"create_records":[{"岗位":"设计师"}]}'));
    await lark.handle("connector.lark.remove", { expectedRevision: lark.status().revision });
    assert.equal((await call("mcp_server_list")).structuredContent.localConnectors, undefined);
    assert.equal((await larkCall("lark_account_status", {})).isError, true);
    await coordinator.abort({ sessionKey: session.sessionKey, runId: run.id, operationId: "connector-stop" });
    console.log("PASS OpenCode Service: workspace output and approval, Feishu discovery, authorization, approved write and revocation");
  } finally {
    try { await service.stop({ notify: false }); }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
