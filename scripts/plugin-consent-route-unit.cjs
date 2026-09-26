"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startStaticServer } = require("../app/static-server");

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-consent-route-"));
  let server;
  let approve = false;
  let confirmations = 0;
  let commits = [];
  const gitSources = [];
  const challenge = "private-challenge-never-browser";
  const backend = {
    preparePluginMcpConsent: async input => {
      assert.equal(input.agentId, "agent-a");
      return { challenge, summary: { action: "connect", agent: "A", package: "P", capability: "C", approvalMode: null } };
    },
    commitPluginMcpConsent: async input => {
      assert.equal(input.challenge, challenge); commits.push(input.approved);
      return { canceled: !input.approved, receipt: input.approved ? { bindingId: "bound" } : null };
    },
    discoverPluginMcpTools: async (agentId, bindingId) => ({ agentId, bindingId, catalogRevision: "catalog" }),
    previewPluginUninstall: async input => ({ ...input, dataRetained: true }),
    uninstallPlugin: async input => ({ uninstall: { ...input, dataRetained: true }, operation: { phase: "completed" } }),
    previewPluginInstall: async source => {
      gitSources.push(source);
      return { sourceKind: "remote-git", installable: true, previewDigest: "b".repeat(64), expectedRevision: 0 };
    },
    installPlugin: async input => {
      assert.deepEqual(input.source, gitSources.at(-1));
      return { operation: { operationId: input.operationId, phase: "completed" } };
    },
  };
  try {
    server = await startStaticServer(0, { homeDir: root, userDataRoot: root,
      registry: { route: id => id === "agent-a" ? backend : null,
        backends: new Map([["shoggoth", backend]]),
        listExternalPluginCatalogs: async () => [{ backend: "external", catalog: { supported: true, items: [] } }] },
      hostOps: { confirmPluginCapability: async summary => {
        assert.deepEqual(Object.keys(summary).sort(), summary.action === "remote-git"
          ? ["action", "commit", "repositoryUrl", "subdir"] : ["action", "agent", "approvalMode", "capability", "package"]);
        confirmations += 1; return approve;
      } } });
    const post = (route, value, origin = server.url) => fetch(`${server.url}/__api/plugins/${route}`,
      { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(value) });
    const input = { action: "connect", agentId: "agent-a", installationId: "install",
      componentId: "a".repeat(64), expectedRevision: 2, operationId: "connect" };
    assert.equal((await post("mcp-consent", input, "https://evil.example")).status, 403);
    assert.equal(confirmations, 0);
    assert.equal((await post("mcp-consent", { ...input, challenge })).status, 400);
    const canceled = await post("mcp-consent", input);
    assert.equal(canceled.status, 200);
    assert.deepEqual(await canceled.json(), { canceled: true, receipt: null });
    approve = true;
    const accepted = await post("mcp-consent", input);
    assert.equal(accepted.status, 200);
    assert(!JSON.stringify(await accepted.json()).includes(challenge));
    assert.deepEqual(commits, [false, true]);
    assert.equal((await post("mcp-consent", { ...input, agentId: "other" })).status, 404);
    assert.equal((await post("mcp-discover", { agentId: "agent-a", bindingId: "bound" })).status, 200);
    assert.equal((await post("uninstall-preview", { installationId: "install", expectedRevision: 3 })).status, 200);
    assert.equal((await post("uninstall", { installationId: "install", expectedRevision: 3, operationId: "remove" })).status, 200);
    const external = await fetch(`${server.url}/__api/plugins/external`);
    assert.equal(external.status, 200);
    assert.equal((await external.json()).backends[0].catalog.supported, true);
    const source = { repositoryUrl: "https://example.org/team/plugin.git", commit: "a".repeat(40), subdir: "packages/example" };
    approve = false;
    assert.deepEqual(await (await post("git-preview", source)).json(), { canceled: true });
    assert.equal(gitSources.length, 0, "cancel must precede any remote fetch");
    approve = true;
    for (const invalid of [{ ...source, repositoryUrl: "https://secret@example.org/repo" },
      { ...source, commit: "main" }, { ...source, subdir: "--output=escape" },
      { ...source, subdir: "../escape" }, { ...source, executablePath: "/tmp/forbidden" }]) {
      assert.equal((await post("git-preview", invalid)).status, 400);
    }
    assert.equal((await post("git-preview", source, "https://evil.example")).status, 403);
    const selected = await (await post("git-preview", source)).json();
    assert(!JSON.stringify(selected).includes(source.repositoryUrl), "source is held behind the native selection handle");
    assert.equal(gitSources.length, 1);
    assert.deepEqual(gitSources[0], { kind: "remote-git", ...source });
    const install = { selectionHandle: selected.selectionHandle, previewDigest: "b".repeat(64), expectedRevision: 0, operationId: "git-install" };
    assert.equal((await post("install", install)).status, 200);
    assert.equal((await post("install", install)).status, 409, "source handles are consumed once");
    console.log("plugin native consent/uninstall/external REST boundary: PASS");
  } finally { await server?.close(); fs.rmSync(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
