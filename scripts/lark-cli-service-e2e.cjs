"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { startInspirationFixture } = require("./fixtures/inspiration-service-fixture.cjs");
const { prepareFixture } = require("./fixtures/lark-cli-fixture.cjs");
const { prepareLarkCli, RELEASE } = require("../app/agent-service/lark-cli-installer");
const { McpExternalToolService } = require("../app/agent-service/mcp-external-tool-service");
const { validateLarkCliResult } = require("../app/core/lark-cli-contract");

async function main() {
  const live = process.argv.includes("--live");
  let releaseInstall, reachedInstall;
  const started = new Promise(resolve => { reachedInstall = resolve; });
  const gate = new Promise(resolve => { releaseInstall = resolve; });
  const downloads = [];
  const prepare = live ? async input => prepareLarkCli({ ...input,
    // The optional cache contains immutable downloaded official archives; their
    // pinned hashes are still verified by the production installer.
    ...(process.env.LARK_CLI_ARCHIVE_CACHE ? { downloadFile: async (url, destination) => {
      downloads.push(url);
      const name = url.includes("codeload.github.com") ? "source.zip" : "lark-cli.tar.gz";
      fs.copyFileSync(path.join(process.env.LARK_CLI_ARCHIVE_CACHE, name), destination);
    } } : {}),
  }) : async input => { reachedInstall(); await gate; return prepareFixture(input); };
  const f = await startInspirationFixture({ codexFakeEnv: { CODEX_FAKE_AUTOCOMPLETE_ALL: "1" },
    serviceOptions: { autoSparkNotes: false, larkCliOptions: { prepare },
      setCronTimer: () => 1, clearCronTimer() {}, setProactiveTimer: () => 1, clearProactiveTimer() {} } });
  let shared;
  const rest = async (endpoint, body, { origin = f.url, expected = 200 } = {}) => {
    const response = await fetch(`${f.url}/__api/connectors/lark/${endpoint}`, body === undefined ? {} : {
      method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(body),
    });
    const text = await response.text(); let value; try { value = JSON.parse(text); } catch { value = { error: text }; }
    assert.equal(response.status, expected, JSON.stringify(value)); return value;
  };
  try {
    let state = await rest("status"); assert.equal(state.state, "notInstalled");
    await rest("install", { expectedRevision: state.revision }, { origin: "https://untrusted.example", expected: 403 });
    await rest("install", { expectedRevision: state.revision, command: "injected" }, { expected: 400 });
    await rest("status?path=outside", undefined, { expected: 400 });
    await assert.rejects(f.ipc("connector.lark.install", { expectedRevision: 0, path: "/tmp/escape" }), { code: "LARK_CLI_INVALID_ARGUMENT" });
    const installing = rest("install", { expectedRevision: state.revision });
    if (!live) {
      await started; state = await rest("status"); assert.equal(state.state, "installing");
      await rest("remove", { expectedRevision: state.revision }, { expected: 409 }); releaseInstall();
    }
    state = await installing; validateLarkCliResult("connector.lark.install", state);
    assert.equal(state.state, "installed"); assert.equal(state.skillCount, live ? RELEASE.skillCount : 2);
    assert.deepEqual(await f.backend.connectorRequest("connector.lark.status", {}), state);
    const profileId = f.service.productStore.listAgentProfiles()[0].id;
    const catalog = await f.ipc("harness.skills.query", { profileId, query: "飞书", status: "on", pageIndex: 0, limit: 100, expectedRevision: null });
    assert.equal(catalog.items.filter(item => item.id.startsWith("lark-")).length, state.skillCount);
    shared = new McpExternalToolService({ paths: f.paths, connector: f.service.mcpConnectorController,
      approvalBroker: { close() {} },
      authorize: () => true, getPermissionProfile: () => ({ id: profileId, enabled: true }),
      getSubjects: async () => ({ items: [{ backendId: "openclaw", agentId: "fixture", enabled: true, connected: true }], unavailableBackends: [] }),
      getNativeSkillStore: () => f.service.nativeSkillStore });
    const identity = { backendId: "openclaw", instanceId: "lark-fixture", agentId: "fixture", sessionId: "lark-session", runId: "lark-run", toolCallId: "search" };
    const external = (name, args, toolCallId) => shared.handle("mcp.external.tool", { credentialToken: "isolated-fixture", identity: { ...identity, toolCallId }, name, arguments: args });
    let search = await external("shoggoth_capability_search", { query: "飞书" }, "search");
    const found = [...search.items];
    while (search.nextCursor !== null) {
      search = await external("shoggoth_capability_search", { query: "飞书", cursor: search.nextCursor, revision: search.revision }, `search-${search.nextCursor}`);
      found.push(...search.items);
    }
    assert.equal(found.length, state.skillCount);
    assert.ok(found.some(item => item.id === "lark-shared" && item.eligible));
    const skill = await external("shoggoth_skill_read", { skillId: "lark-shared" }, "read");
    assert.ok(skill.content.includes(state.cliPath));
    if (live) {
      const { execFileSync } = require("node:child_process");
      const env = { HOME: path.join(f.root, "isolated-lark-home"), PATH: "/usr/bin:/bin" }; fs.mkdirSync(env.HOME);
      const list = JSON.parse(execFileSync(state.cliPath, ["skills", "list"], { env, encoding: "utf8", timeout: 15000 }));
      assert.equal(list.ok, true); assert.equal(list.count, RELEASE.skillCount);
      const official = JSON.parse(execFileSync(state.cliPath, ["skills", "read", "lark-shared", "--json"], { env, encoding: "utf8", timeout: 15000 }));
      assert.ok(official.content.includes("auth"));
      const root = path.dirname(path.dirname(state.cliPath));
      assert.ok(fs.readFileSync(path.join(root, "LICENSE"), "utf8").includes("MIT"));
      assert.ok(fs.existsSync(path.join(root, "skills/lark-sheets/scripts/lark_sheet_read_cli.py")));
      assert.ok(fs.existsSync(path.join(root, "skills/lark-mail/assets/templates/newsletter--weekly-brief.html")));
    }
    await rest("remove", { expectedRevision: 0 }, { expected: 409 });
    const executable = state.cliPath;
    state = await rest("remove", { expectedRevision: state.revision });
    assert.equal(state.state, "notInstalled"); assert.equal(fs.existsSync(executable), false);
    assert.equal(f.service.nativeSkillStore.listGlobalEnabled().filter(skill => skill.id.startsWith("lark-")).length, 0);
    await assert.rejects(external("shoggoth_skill_read", { skillId: "lark-shared" }, "after-removal"), { code: "SKILL_NOT_ENABLED" });
    const after = await rest("status"); assert.deepEqual(after, state);
    console.log(JSON.stringify({ outcome: "PASS", mode: live ? "official-release-isolated-install" : "controlled-install",
      cliVersion: RELEASE.version, skillsInstalledAndRemoved: live ? RELEASE.skillCount : 2,
      serviceRestIpc: true, nativeAndExternalSkillDiscovery: true, explicitInstallOnly: true, originAndRevisionChecks: true,
      accountAuthorizationTested: false, ...(downloads.length ? { verifiedArchives: downloads } : {}) }));
  } finally { releaseInstall(); try { shared?.close(); } finally { await f.close(); } }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
