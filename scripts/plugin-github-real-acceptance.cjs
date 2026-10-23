"use strict";

// Opt-in, source-mode acceptance against one disposable GitHub repository.
// The operator enters a repository-scoped PAT in the actual bundled React UI.
// This process never reads that PAT: Service verifies it and stores it through
// the ordinary encrypted credential path. Do not use a production userData.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline/promises");
const { PassThrough } = require("node:stream");
const { resolveCanonicalServicePaths, resolveServicePaths } = require("../app/agent-service/paths");
const { createAgentService } = require("../app/agent-service/server");
const { ShoggothBackend } = require("../app/core/shoggoth-backend");
const { BackendRegistry } = require("../app/core/backend-registry");
const { startStaticServer } = require("../app/static-server");
const { pluginServerId } = require("../app/agent-service/plugin-runtime-tool-service");
const { buildPluginToolCatalog } = require("../app/agent-service/plugin-tool-contract");
const { serviceError } = require("../app/agent-service/security");

const REPOSITORY = Object.freeze({ owner: "ArronKong",
  repo: "shoggoth-plugin-acceptance-2026-09-27", branch: "main", issue: 1 });
const SEED = Object.freeze({ fileLine: "Shoggoth GitHub plugin acceptance fixture",
  initialValue: "Initial value: alpha",
  issueTitle: "Shoggoth plugin acceptance fixture",
  issueBody: "Isolated test issue for verifying GitHub MCP read and comment operations." });
const REQUIRED = Object.freeze(["get_file_contents", "create_or_update_file",
  "issue_read", "add_issue_comment"]);
const ARGUMENTS = Object.freeze({
  get_file_contents: ["owner", "repo", "path", "ref"],
  create_or_update_file: ["owner", "repo", "path", "branch", "content", "message", "sha"],
  issue_read: ["method", "owner", "repo", "issue_number"],
  add_issue_comment: ["owner", "repo", "issue_number", "body"],
});
const SCHEMA_ROOT_KEYS = Object.freeze(["$schema", "type", "title", "description",
  "properties", "required", "additionalProperties", "oneOf", "anyOf", "allOf", "not"]);
const SCHEMA_FIELD_KEYS = Object.freeze(["type", "title", "description", "enum",
  "minLength", "default", "pattern", "format", "minimum", "maximum"]);
const NUMERIC_SCHEMA_KEYS = Object.freeze(["minLength", "maxLength", "minimum", "maximum",
  "exclusiveMinimum", "exclusiveMaximum", "multipleOf"]);
const BOOLEAN_SCHEMA_KEYS = Object.freeze(["deprecated", "readOnly", "writeOnly"]);
const DIAGNOSTIC_SCHEMA_KEYWORDS = Object.freeze(["$ref", "additionalProperties", "allOf",
  "anyOf", "const", "contains", "contentEncoding", "contentMediaType", "default",
  "dependentRequired", "deprecated", "description", "else", "enum", "examples",
  "exclusiveMaximum", "exclusiveMinimum", "format", "if", "items", "maxItems",
  "maxLength", "maxProperties", "maximum", "minItems", "minLength", "minProperties",
  "minimum", "multipleOf", "not", "oneOf", "pattern", "patternProperties",
  "properties", "propertyNames", "readOnly", "required", "then", "title", "type",
  "unevaluatedItems", "unevaluatedProperties", "uniqueItems", "writeOnly"]);
// macOS sockaddr_un is shorter than os.tmpdir() under /private/var/folders.
const ROOT_BASE = "/private/tmp";
// Account-scoped PAT creation is a human workflow. Keep the local-only page up
// for an hour without making any provider call until the user connects.
const PROFILE_WAIT_MS = 60 * 60_000;
const MAX_CONTRACT_RECHECKS = 3;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const SAFE_ERROR_CODES = new Set(["ACTIVATION_DEFERRED", "CONNECTION_IDENTITY_CHANGED",
  "ECONNREFUSED", "ECONNRESET", "EAI_AGAIN", "ENOSPC", "ENOTFOUND", "ETIMEDOUT",
  "MCP_AUTH_FAILED", "MCP_AUTH_REQUIRED", "MCP_SERVER_EXITED",
  "MCP_SERVER_REQUEST_TOO_LARGE", "MCP_SERVER_RESPONSE_INVALID",
  "MCP_SERVER_RESPONSE_TOO_LARGE", "PLUGIN_SERVICE_FAILED", "SERVICE_DISCONNECTED",
  "SERVICE_UNAVAILABLE", "TOOL_CONTRACT_CHANGED"]);
const safeCode = error => SAFE_ERROR_CODES.has(error?.code) ? error.code : "UNAVAILABLE";
const REPORT_ERROR_CODES = new Set([...SAFE_ERROR_CODES, "CONNECT_WAIT_TIMEOUT",
  "CONNECTION_NOT_PRESERVED", "LIVE_DISCOVERY_FAILED", "LIVE_TOOL_CONTRACT_MISMATCH",
  "MANAGE_UI_BUILD_REQUIRED", "MCP_RESULT_UNVERIFIED", "OPERATOR_GATE_CLOSED",
  "OPERATOR_GATE_DENIED", "OPERATOR_STOPPED", "SCHEMA_DIAGNOSTIC_TIMEOUT",
  "WRITER_LEASE_IDENTITY_UNAVAILABLE"]);

function isolatedStorage(key) {
  return {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      const nonce = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
      return Buffer.concat([nonce, cipher.update(value, "utf8"), cipher.final(), cipher.getAuthTag()]);
    },
    decryptString(value) {
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(-16));
      return Buffer.concat([decipher.update(value.subarray(12, -16)), decipher.final()]).toString("utf8");
    },
  };
}

function assertTemporaryRoot(root) {
  const canonical = fs.realpathSync(root);
  const relative = path.relative(fs.realpathSync(ROOT_BASE), canonical);
  assert(relative.startsWith("shoggoth-github-acceptance-") && !relative.includes(path.sep));
  const production = resolveCanonicalServicePaths().userDataRoot;
  assert.notEqual(canonical, production);
  assert.notEqual(path.resolve(canonical, "user"), production);
  assert.equal(fs.statSync(canonical).mode & 0o077, 0);
}

async function launch({ live, externalPluginAgentVerifier } = {}) {
  const bundle = path.join(__dirname, "..", "app", "manage-ui", "dist", "index.html");
  if (!fs.existsSync(bundle)) throw Object.assign(new Error(), { code: "MANAGE_UI_BUILD_REQUIRED" });
  const oldUmask = process.umask(0o077);
  let root;
  try {
    root = fs.realpathSync(fs.mkdtempSync(path.join(ROOT_BASE, "shoggoth-github-acceptance-")));
  } finally { process.umask(oldUmask); }
  assertTemporaryRoot(root);
  const key = crypto.randomBytes(32);
  const paths = resolveServicePaths({ userDataRoot: path.join(root, "user"),
    cacheRoot: path.join(root, "cache"), trustedRoot: root });
  let service, backend, registry, web;
  try {
    service = createAgentService({ paths, safeStorage: isolatedStorage(key), parentEnv: {},
      prewarmMcpAuth: false, version: "github-real-acceptance-source",
      ...(externalPluginAgentVerifier ? { externalPluginAgentVerifier } : {}) });
    await service.start();
    backend = new ShoggothBackend({ paths, pollIntervalMs: 30_000 });
    registry = new BackendRegistry();
    registry.register(backend);
    assert.equal((await registry.start("shoggoth")).get("shoggoth"), true);
    const profiles = service.productStore.listAgentProfiles().filter(item => item.enabled);
    assert.equal(profiles.length, 1, "fresh isolated profile required");
    const profile = profiles[0];
    const source = { kind: "bundled", packageId: "github" };
    const preview = await backend.previewPluginInstall(source);
    assert.equal(preview.installable, true);
    assert(preview.components.mcpServers.some(item => item.name === "github"));
    const installed = await backend.installPlugin({ source,
      previewDigest: preview.previewDigest, expectedRevision: preview.expectedRevision,
      operationId: `real-github-install-${crypto.randomUUID()}` });
    const enabled = await backend.setPluginInstallationState({
      installationId: installed.installation.installationId, desiredState: "enabled",
      expectedRevision: installed.installation.revision,
      operationId: `real-github-enable-${crypto.randomUUID()}` });
    const page = await backend.getPluginCapabilitiesPage({ cursor: 0, limit: 20,
      catalogRevision: null });
    const item = page.items.find(row => row.installationId === enabled.installation.installationId);
    const component = item?.components.find(row => row.kind === "mcp-server" && row.localName === "github");
    assert(component, "bundled GitHub MCP component required");
    // Node source mode has no Electron native dialog. This deliberately narrow
    // opt-in surrogate exists only for the fixed GitHub test connection; it is
    // not proof of the installed App's native confirmation behavior.
    let bearerApproved = false;
    const hostOps = { async confirmPluginCapability(summary) {
      const allowed = live && !bearerApproved && summary?.action === "bearer-connect"
        && summary.agent === "所有助理"
        && summary.package === "github" && summary.capability === "github"
        && summary.provider === "GitHub" && summary.reconnect === false;
      if (allowed) bearerApproved = true;
      return allowed;
    } };
    web = await startStaticServer(0, { homeDir: root, userDataRoot: paths.userDataRoot,
      registry, hostOps });
    return { root, paths, key, service, backend, registry, web, profile,
      installationId: item.installationId, componentId: component.componentId,
      installationRevision: enabled.installation.revision,
      async close() {
        const failures = [];
        for (const stop of [() => this.web?.close(), () => this.backend?.stop(),
          () => this.service?.stop({ notify: false })]) {
          try { await stop(); } catch (error) { failures.push(error); }
        }
        key.fill(0);
        try { fs.rmSync(root, { recursive: true, force: true }); }
        catch (error) { failures.push(error); }
        if (failures.length) throw failures[0];
      } };
  } catch (error) {
    await web?.close().catch(() => {});
    await backend?.stop().catch(() => {});
    await service?.stop({ notify: false }).catch(() => {});
    key.fill(0);
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

async function waitForConnection(context, signal) {
  const deadline = Date.now() + PROFILE_WAIT_MS;
  while (Date.now() < deadline && !signal.aborted) {
    const binding = context.service.pluginStore.listGlobalBindings().find(row =>
      row.installationId === context.installationId && row.componentId === context.componentId
        && row.enabled === true);
    const connection = binding && context.service.pluginStore.getConnection(binding.connectionId);
    if (connection?.state === "ready" && /^github:[1-9][0-9]{0,19}$/u.test(connection.principalIdentity)
      && connection.endpointIdentity === "https://api.githubcopilot.com/mcp/") {
      return binding;
    }
    await wait(1500);
  }
  throw Object.assign(new Error(), { code: signal.aborted ? "OPERATOR_STOPPED" : "CONNECT_WAIT_TIMEOUT" });
}

function assertMcpSuccess(response) {
  const result = response?.result;
  if (!result || result.isError === true || !Array.isArray(result.content)) {
    throw Object.assign(new Error(), { code: "MCP_RESULT_UNVERIFIED" });
  }
  return result;
}

function resultContains(result, text) {
  const material = JSON.stringify({ structuredContent: result.structuredContent,
    content: result.content }).slice(0, 256 * 1024);
  if (material.includes(text)) return true;
  const pending = [result.structuredContent, result.content];
  let inspected = 0;
  while (pending.length && inspected++ < 256) {
    const value = pending.pop();
    if (typeof value === "string") {
      if (value.includes(text)) return true;
      if (value.length < 256 * 1024 && /^[\s]*[\[{]/u.test(value)) {
        try { pending.push(JSON.parse(value)); } catch { /* ordinary text */ }
      }
      continue;
    }
    if (!value || typeof value !== "object") continue;
    if (value.encoding === "base64" && typeof value.content === "string"
      && value.content.length < 256 * 1024) {
      if (Buffer.from(value.content, "base64").toString("utf8").includes(text)) return true;
    }
    pending.push(...(Array.isArray(value) ? value : Object.values(value)));
  }
  return false;
}

function gitBlobSha(content) {
  return crypto.createHash("sha1").update(`blob ${Buffer.byteLength(content)}\0${content}`).digest("hex");
}

// A live contract mismatch must be diagnosable without another blind PAT run.
// Emit only a bounded, allowlisted shape: never schema descriptions, defaults,
// examples, accounts, or credential-bearing values.
function schemaDiagnostic(tools) {
  const byName = new Map((Array.isArray(tools) ? tools : [])
    .filter(item => REQUIRED.includes(item?.name)).map(item => [item.name, item]));
  const shape = (value, allowlist) => {
    const keys = value && typeof value === "object" && !Array.isArray(value)
      ? Object.keys(value) : [];
    const other = keys.filter(key => !allowlist.includes(key));
    return { keys: allowlist.filter(key => keys.includes(key)),
      // Only fixed JSON Schema keywords may appear by name. Arbitrary
      // server-controlled keys are counted but never echoed to the terminal.
      otherKeys: DIAGNOSTIC_SCHEMA_KEYWORDS.filter(key => other.includes(key)).slice(0, 8),
      otherKeyCount: other.length };
  };
  const type = value => ["object", "string", "number", "integer", "array", "boolean", "null"]
    .includes(value) ? value : "other";
  const knownConstraints = value => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries([...NUMERIC_SCHEMA_KEYS, ...BOOLEAN_SCHEMA_KEYS]
      .filter(key => (NUMERIC_SCHEMA_KEYS.includes(key)
        ? typeof value[key] === "number" && Number.isFinite(value[key])
          && Math.abs(value[key]) <= 1_000_000
        : typeof value[key] === "boolean"))
      .map(key => [key, value[key]]));
  };
  return REQUIRED.map(name => {
    const schema = byName.get(name)?.inputSchema;
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
      return { tool: name, present: byName.has(name), inputSchema: "missing-or-invalid" };
    }
    const properties = schema.properties && typeof schema.properties === "object"
      && !Array.isArray(schema.properties) ? schema.properties : {};
    const supplied = ARGUMENTS[name];
    const required = Array.isArray(schema.required) ? schema.required : [];
    return { tool: name, present: true, inputType: type(schema.type),
      root: shape(schema, SCHEMA_ROOT_KEYS),
      requiredKnown: supplied.filter(field => required.includes(field)),
      requiredOtherCount: required.filter(field => !supplied.includes(field)).length,
      fields: Object.fromEntries(supplied.map(field => [field, {
        present: Object.hasOwn(properties, field), type: type(properties[field]?.type),
        ...shape(properties[field], SCHEMA_FIELD_KEYS),
        constraints: knownConstraints(properties[field]),
        ...(name === "get_file_contents" && field === "path"
          ? { defaultIsRoot: properties[field]?.default === "/" } : {}),
        ...(name === "issue_read" && field === "method"
          ? { enumIncludesGet: Array.isArray(properties[field]?.enum)
            && properties[field].enum.includes("get") } : {}),
      }])),
    };
  });
}

async function recordSchemaDiagnostic(context, binding, report) {
  let handle;
  try {
    const installation = context.service.pluginStore.getInstallation(binding.installationId);
    const connection = context.service.pluginStore.getConnection(binding.connectionId);
    report.schemaProbePhase = "acquire";
    handle = await context.service.pluginMcpConnectionManager.acquire({ installation,
      binding, connection });
    report.schemaProbePhase = "list-tools";
    const tools = await handle.listTools();
    report.schemaDiagnostic = schemaDiagnostic(tools);
    report.schemaProbePhase = "catalog-build";
    buildPluginToolCatalog({ installationId: installation.installationId,
      componentId: binding.componentId, connectionId: connection.connectionId, tools });
    report.schemaProbePhase = "complete";
  } catch (error) {
    report.schemaDiagnosticError = safeCode(error);
  } finally { try { await handle?.release(); } catch { /* diagnostic only */ } }
}

// Keep the already-authorized, encrypted temporary profile in this process
// while a schema-only source fix is reviewed. Reload only the Service and its
// verifier modules, then reopen the same profile with the same in-memory key.
// No credential is read by this harness or passed through the terminal.
async function restartProductStack(context, { requireReadyBinding = true } = {}) {
  await context.web?.close();
  context.web = null;
  await context.backend?.stop();
  context.backend = null;
  await context.service?.stop({ notify: false });
  context.service = null;
  for (const id of ["../app/agent-service/plugin-verified-mcp-capabilities",
    "../app/agent-service/plugin-tool-catalog-registry", "../app/agent-service/server"]) {
    delete require.cache[require.resolve(id)];
  }
  const { createAgentService: createFreshService } = require("../app/agent-service/server");
  context.service = createFreshService({ paths: context.paths,
    safeStorage: isolatedStorage(context.key), parentEnv: {},
    prewarmMcpAuth: false, version: "github-real-acceptance-source" });
  await context.service.start();
  context.backend = new ShoggothBackend({ paths: context.paths, pollIntervalMs: 30_000 });
  context.registry = new BackendRegistry();
  context.registry.register(context.backend);
  assert.equal((await context.registry.start("shoggoth")).get("shoggoth"), true);
  assert(context.service.productStore.listAgentProfiles().some(item =>
    item.id === context.profile.id && item.enabled));
  assert(context.service.pluginStore.getInstallation(context.installationId),
    "isolated bundled installation must survive a source-mode Service restart");
  if (!requireReadyBinding) return null;
  const binding = context.service.pluginStore.listGlobalBindings().find(row =>
    row.installationId === context.installationId && row.componentId === context.componentId
      && row.enabled === true);
  const connection = binding && context.service.pluginStore.getConnection(binding.connectionId);
  if (connection?.state !== "ready" || connection.endpointIdentity !== "https://api.githubcopilot.com/mcp/"
    || !/^github:[1-9][0-9]{0,19}$/u.test(connection.principalIdentity)) {
    throw Object.assign(new Error(), { code: "CONNECTION_NOT_PRESERVED" });
  }
  return binding;
}

async function withRun(context, bindingId, execute) {
  const id = crypto.randomUUID();
  const service = context.service;
  service.workDispatcher.enqueue({ id, source: "chat", sourceId: `github-acceptance-${id}`,
    idempotencyKey: `github-acceptance-${id}`, profileId: context.profile.id,
    workspace: context.root });
  const admitted = service.workDispatcher.admit(id, { writable: true });
  assert.equal(admitted.disposition, "started");
  service.pluginRuntimeToolService.captureRun(admitted.run);
  service.workDispatcher.transition(id, "running");
  const call = async (toolName, args) => assertMcpSuccess(await service.pluginRuntimeToolService.callTool({
    serverId: pluginServerId(bindingId), toolName, arguments: args,
  }, { profileId: context.profile.id, callId: crypto.randomUUID(), confirmation: true },
  { runId: id, assertCurrent() {
    assert.equal(service.workDispatcher.getRun(id)?.status, "running");
  } }));
  try { return await execute(call); }
  finally {
    service.pluginRuntimeToolService.releaseRun(id);
    if (service.workDispatcher.getRun(id)?.status === "running") {
      service.workDispatcher.transition(id, "completed");
    }
  }
}

async function grantTools(context, binding, catalog, names) {
  assert(names.every(name => REQUIRED.includes(name)));
  for (const name of names) {
    const tool = catalog.items.find(item => item.name === name);
    assert(tool && !tool.savedGrant);
    const prepared = await context.backend.preparePluginMcpConsent({ action: "allow",
      agentId: context.profile.agentId, bindingId: binding.bindingId,
      toolIdentity: tool.toolIdentity, contractDigest: tool.contractDigest,
      catalogRevision: catalog.catalogRevision, approvalMode: "always", expectedRevision: 0,
      operationId: `real-github-grant-${name}-${crypto.randomUUID()}` });
    const committed = await context.backend.commitPluginMcpConsent({
      challenge: prepared.challenge, approved: true });
    assert.equal(committed.canceled, false);
  }
}

async function requireOperatorGate(command, signal,
  { input = process.stdin, output = process.stdout, timeoutMs = 30 * 60_000 } = {}) {
  const rl = readline.createInterface({ input, output });
  let answer;
  try {
    const timer = setTimeout(() => rl.close(), timeoutMs);
    try { answer = await rl.question(`OPERATOR_GATE> Type ${command} to continue: `,
      { signal }); }
    finally { clearTimeout(timer); }
  } catch {
    throw Object.assign(new Error(), { code: signal.aborted ? "OPERATOR_STOPPED" : "OPERATOR_GATE_CLOSED" });
  } finally { rl.close(); }
  if (answer !== command) throw Object.assign(new Error(), { code: "OPERATOR_GATE_DENIED" });
}

async function accept(context, binding, report, signal) {
  report.stage = "tools-list";
  let catalog;
  try {
    await context.backend.discoverPluginMcpTools(context.profile.agentId, binding.bindingId);
    catalog = await context.backend.getPluginMcpTools(context.profile.agentId, binding.bindingId);
  } catch (error) {
    report.discoveryErrorCode = safeCode(error);
    await recordSchemaDiagnostic(context, binding, report);
    throw Object.assign(new Error(), { code: "LIVE_DISCOVERY_FAILED" });
  }
  assert.equal(catalog.available, true, "authenticated MCP catalog must be available");
  const operations = new Set((catalog.portableCapabilities || []).map(item => item.toolName));
  report.liveToolNames = REQUIRED.filter(name => catalog.items.some(item => item.name === name));
  if (!REQUIRED.every(name => operations.has(name))) {
    await recordSchemaDiagnostic(context, binding, report);
    throw Object.assign(new Error(), { code: "LIVE_TOOL_CONTRACT_MISMATCH" });
  }
  assert.equal(catalog.referenceCoverage?.equivalence, "unverified");
  report.fixedSourceAndLiveContracts = true;
  await requireOperatorGate(`GRANT_READ ${REPOSITORY.owner}/${REPOSITORY.repo}`, signal);
  report.stage = "read-only-grants";
  await grantTools(context, binding, catalog, ["get_file_contents", "issue_read"]);
  report.readGrants = 2;
  const repo = { owner: REPOSITORY.owner, repo: REPOSITORY.repo };
  report.stage = "real-provider-read-only";
  await withRun(context, binding.bindingId, async call => {
    const existing = await call("get_file_contents", { ...repo,
      path: "fixtures/input.txt", ref: REPOSITORY.branch });
    assert(resultContains(existing, SEED.fileLine)
      && resultContains(existing, SEED.initialValue),
    "real MCP file response must contain both fixed seed lines");
    report.existingFixtureRead = true;
    const issue = await call("issue_read", { ...repo, method: "get",
      issue_number: REPOSITORY.issue });
    assert(resultContains(issue, SEED.issueTitle)
      && resultContains(issue, SEED.issueBody),
    "real MCP Issue response must contain fixed test Issue title and body");
    report.issueRead = true;
  });
  report.stage = "read-only-complete";
  console.log(`GITHUB_ACCEPTANCE_READ_ONLY ${JSON.stringify({
    connectedAccount: report.connectedAccount,
    liveToolNames: report.liveToolNames,
    existingFixtureRead: report.existingFixtureRead,
    issueRead: report.issueRead,
    repository: report.repository,
  })}`);
  await requireOperatorGate(`RUN_WRITE ${REPOSITORY.owner}/${REPOSITORY.repo}`, signal);
  report.stage = "write-grants";
  await grantTools(context, binding, catalog, ["create_or_update_file", "add_issue_comment"]);
  report.writeGrants = 2;
  report.stage = "real-provider-read-write";
  const marker = `shoggoth-mcp-${crypto.randomUUID()}`;
  const file = `fixtures/${marker}.txt`;
  const first = `${marker}\nphase=create\n`;
  const second = `${marker}\nphase=update\n`;
  report.testFile = file;
  await withRun(context, binding.bindingId, async call => {
    // Each write has one attempt. On an ambiguous provider response, stop and
    // inspect the named test file/Issue externally before deciding to retry.
    report.stage = "file-create-pending-verification";
    const created = await call("create_or_update_file", { ...repo, path: file,
      branch: REPOSITORY.branch, content: first,
      message: `Shoggoth MCP acceptance create ${marker}` });
    assert(created.content.length > 0);
    report.fileCreated = true;
    const firstRead = await call("get_file_contents", { ...repo, path: file,
      ref: REPOSITORY.branch });
    assert(resultContains(firstRead, marker), "new file readback must contain run marker");
    report.fileCreateReadback = true;

    report.stage = "file-update-pending-verification";
    const updated = await call("create_or_update_file", { ...repo, path: file,
      branch: REPOSITORY.branch, sha: gitBlobSha(first), content: second,
      message: `Shoggoth MCP acceptance update ${marker}` });
    assert(updated.content.length > 0);
    report.fileUpdated = true;
    const secondRead = await call("get_file_contents", { ...repo, path: file,
      ref: REPOSITORY.branch });
    assert(resultContains(secondRead, "phase=update"), "updated file readback must match");
    report.fileUpdateReadback = true;

    report.stage = "issue-comment-pending-verification";
    const comment = `Shoggoth MCP acceptance ${marker}`;
    const posted = await call("add_issue_comment", { ...repo, issue_number: REPOSITORY.issue,
      body: comment });
    assert(posted.content.length > 0);
    report.issueCommentPosted = true;
    const comments = await call("issue_read", { ...repo, method: "get_comments",
      issue_number: REPOSITORY.issue });
    assert(resultContains(comments, comment), "issue comment readback must match");
    report.issueCommentReadback = true;
  });
  report.stage = "revoke";
  const after = await context.backend.getPluginMcpTools(context.profile.agentId, binding.bindingId);
  const commentTool = after.items.find(item => item.name === "add_issue_comment");
  assert(commentTool?.savedGrant?.revision >= 1);
  await context.backend.revokePluginMcpGrant({ agentId: context.profile.agentId,
    bindingId: binding.bindingId, toolIdentity: commentTool.toolIdentity,
    expectedRevision: commentTool.savedGrant.revision,
    operationId: `real-github-revoke-${crypto.randomUUID()}` });
  const revoked = await context.backend.getPluginMcpTools(context.profile.agentId, binding.bindingId);
  assert.equal(revoked.items.find(item => item.name === "add_issue_comment")?.savedGrant?.effect, "deny");
  report.commentGrantRevoked = true;
  report.stage = "complete";
}

async function selfTest(context) {
  const diagnostic = schemaDiagnostic([{ name: "get_file_contents", inputSchema: {
    type: "object", description: "DO_NOT_LOG_SECRET", properties: {
      path: { type: "string", default: "DO_NOT_LOG_SECRET",
        description: "DO_NOT_LOG_SECRET", pattern: "DO_NOT_LOG_SECRET" },
      owner: { type: "string", maxLength: 39,
        shortSecret: "DO_NOT_LOG_SECRET",
        DO_NOT_LOG_SECRET_LONGER_THAN_A_SCHEMA_KEY: true },
    }, required: ["owner", "repo"],
  } }]);
  assert.equal(diagnostic[0].fields.path.defaultIsRoot, false);
  assert.deepEqual(diagnostic[0].fields.owner.otherKeys, ["maxLength"]);
  assert.deepEqual(diagnostic[0].fields.owner.constraints, { maxLength: 39 });
  assert.equal(diagnostic[0].fields.owner.otherKeyCount, 3);
  assert(!JSON.stringify(diagnostic).includes("shortSecret"));
  assert(!JSON.stringify(diagnostic).includes("DO_NOT_LOG_SECRET"));
  const hostile = schemaDiagnostic([{ name: "get_file_contents", inputSchema: {
    type: "object", properties: { owner: { type: "string",
      ...Object.fromEntries(Array.from({ length: 20 }, (_, index) =>
        [`extra${index}`, "DO_NOT_LOG_SECRET"])) } }, required: ["owner", "repo"],
  } }]);
  assert.equal(hostile[0].fields.owner.otherKeyCount, 20);
  assert.deepEqual(hostile[0].fields.owner.otherKeys, []);
  assert(!JSON.stringify(hostile).includes("DO_NOT_LOG_SECRET"));
  const fakeBinding = { installationId: context.installationId,
    componentId: context.componentId, connectionId: "offline-diagnostic" };
  const fakeStore = { getInstallation: () => ({ installationId: context.installationId }),
    getConnection: () => ({ connectionId: fakeBinding.connectionId }) };
  const fakeTools = [{ name: "get_file_contents", inputSchema: { type: "object",
    properties: { owner: { type: "string", maxLength: 39 },
      repo: { type: "string", maxLength: 100 }, path: { type: "string", default: "/" } },
    required: ["owner", "repo"] } }];
  const probeReport = {};
  await recordSchemaDiagnostic({ service: { pluginStore: fakeStore,
    pluginMcpConnectionManager: { acquire: async () => ({ listTools: async () => fakeTools,
      release: async () => {} }) } } }, fakeBinding, probeReport);
  assert.equal(probeReport.schemaProbePhase, "complete");
  assert.deepEqual(probeReport.schemaDiagnostic[0].fields.owner.otherKeys, ["maxLength"]);
  assert.deepEqual(probeReport.schemaDiagnostic[0].fields.owner.constraints, { maxLength: 39 });
  const failedProbe = {};
  await recordSchemaDiagnostic({ service: { pluginStore: fakeStore,
    pluginMcpConnectionManager: { acquire: async () => ({ listTools: async () => {
      throw Object.assign(new Error("DO_NOT_LOG_SECRET"), { code: "MCP_SERVER_RESPONSE_TOO_LARGE" });
    }, release: async () => {} }) } } }, fakeBinding, failedProbe);
  assert.equal(failedProbe.schemaProbePhase, "list-tools");
  assert.equal(failedProbe.schemaDiagnosticError, "MCP_SERVER_RESPONSE_TOO_LARGE");
  assert(!JSON.stringify(failedProbe).includes("DO_NOT_LOG_SECRET"));
  assert(resultContains({ structuredContent: null,
    content: [{ type: "text", text: `${SEED.fileLine}\n${SEED.initialValue}\n` }] },
  SEED.initialValue));
  assert(resultContains({ structuredContent: { encoding: "base64",
    content: Buffer.from("shoggoth-marker\nphase=create\n").toString("base64") }, content: [] },
  "shoggoth-marker"));
  assert(!resultContains({ structuredContent: { encoding: "base64",
    content: Buffer.from("unrelated").toString("base64") }, content: [] },
  "shoggoth-marker"));
  const [ui, agents, bundled, catalog] = await Promise.all([
    fetch(`${context.web.url}/`), fetch(`${context.web.url}/__api/agents?backend=shoggoth&lifecycle=active`),
    fetch(`${context.web.url}/__api/plugins/bundled`),
    fetch(`${context.web.url}/__api/plugins?backend=shoggoth&cursor=0&limit=20`),
  ]);
  assert.equal(ui.status, 200);
  assert.equal(agents.status, 200);
  if (bundled.status !== 200) {
    const body = await bundled.clone().json().catch(() => null);
    console.error(`OFFLINE_BUNDLED_STATUS ${JSON.stringify({ status: bundled.status,
      publicCode: safeCode({ code: body?.code || body?.error?.code }) })}`);
  }
  assert.equal(bundled.status, 200);
  assert.equal(catalog.status, 200);
  assert((await ui.text()).includes("<div id=\"root\""));
  assert((await agents.json()).agents.some(item => item.id === context.profile.agentId));
  assert((await bundled.json()).items.some(item => item.id === "github"));
  assert((await catalog.json()).page.items.some(item => item.installationId === context.installationId));
  // Discovery must preserve fixed, non-sensitive MCP failure categories across
  // Service IPC and Backend so a real failure is not reduced to a generic code.
  const controller = context.service.pluginServiceController;
  const originalHandle = controller.handle;
  try {
    for (const code of ["MCP_SERVER_EXITED", "MCP_SERVER_RESPONSE_INVALID",
      "MCP_SERVER_RESPONSE_TOO_LARGE"]) {
      controller.handle = async method => {
        assert.equal(method, "plugins.mcp.discover");
        throw serviceError(code, "DO_NOT_LOG_SECRET");
      };
      await assert.rejects(context.backend.discoverPluginMcpTools(
        context.profile.agentId, "offline-diagnostic"), error =>
        error.code === code && !error.message.includes("DO_NOT_LOG_SECRET"));
    }
    controller.handle = async method => {
      assert.equal(method, "plugins.mcp.discover");
      throw serviceError("UNREVIEWED_PRIVATE_FAILURE", "DO_NOT_LOG_SECRET");
    };
    await assert.rejects(context.backend.discoverPluginMcpTools(
      context.profile.agentId, "offline-diagnostic"), error =>
      error.code === "PLUGIN_SERVICE_FAILED" && !error.message.includes("DO_NOT_LOG_SECRET"));
  } finally { controller.handle = originalHandle; }
  const deniedGrant = await fetch(`${context.web.url}/__api/plugins/mcp-consent`, {
    method: "POST", headers: { origin: context.web.url, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "connect", agentId: context.profile.agentId,
      installationId: context.installationId, componentId: context.componentId,
      expectedRevision: context.installationRevision,
      operationId: `offline-consent-deny-${crypto.randomUUID()}` }),
  });
  assert.equal(deniedGrant.status, 409,
    "GitHub MCP connect cannot bypass its dedicated verified bearer route");
  assert.equal(context.service.pluginStore.listGlobalBindings().length, 0);
  const prepared = await context.backend.preparePluginBearer({
    agentId: context.profile.agentId, installationId: context.installationId,
    componentId: context.componentId, expectedRevision: context.installationRevision,
    operationId: `offline-github-confirmation-${crypto.randomUUID()}` });
  assert.deepEqual(prepared.summary, { action: "bearer-connect", agent: "所有助理",
    package: "github", capability: "github", provider: "GitHub", reconnect: false });
  assert.deepEqual(await context.backend.commitPluginBearer({ challenge: prepared.challenge,
    approved: false, accessToken: null }), { canceled: true, receipt: null });
  const input = new PassThrough(), output = new PassThrough();
  setImmediate(() => input.write("GRANT_READ ArronKong/shoggoth-plugin-acceptance-2026-09-27\n"));
  await requireOperatorGate("GRANT_READ ArronKong/shoggoth-plugin-acceptance-2026-09-27",
    new AbortController().signal, { input, output });
  input.destroy(); output.destroy();
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !["--self-test", "--live"].includes(args[0])) {
    console.error("Usage: node scripts/plugin-github-real-acceptance.cjs --self-test|--live");
    process.exitCode = 2;
    return;
  }
  const live = args[0] === "--live";
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let context;
  const report = { kind: live ? "real-provider-source-mode" : "offline-harness-self-test",
    repository: `${REPOSITORY.owner}/${REPOSITORY.repo}`, stage: "startup" };
  try {
    context = await launch({ live });
    await selfTest(context);
    if (!live) {
      await restartProductStack(context, { requireReadyBinding: false });
      report.stage = "complete";
      return;
    }
    console.log(`GITHUB_ACCEPTANCE_READY ${context.web.url}/#/plugins`);
    console.log("SOURCE_MODE: isolated temporary profile; GitHub connection confirmation is a fixed test surrogate, not an Electron native dialog.");
    console.log("Connect the bundled GitHub card in this UI with the repository-scoped PAT; never paste it in chat or terminal.");
    report.stage = "waiting-for-app-connection";
    let binding = await waitForConnection(context, abort.signal);
    report.connectedAccount = "verified-github-account";
    console.log("GITHUB_ACCEPTANCE_CONNECTION_READY verified isolated GitHub account; no token shown");
    let diagnosticDeadline = null;
    for (let recheck = 0; ; recheck++) {
      try { await accept(context, binding, report, abort.signal); break; }
      catch (error) {
        if (!["LIVE_TOOL_CONTRACT_MISMATCH", "LIVE_DISCOVERY_FAILED"].includes(error?.code)
          || recheck >= MAX_CONTRACT_RECHECKS) throw error;
        report.stage = "schema-diagnostic-hold";
        console.log(`GITHUB_ACCEPTANCE_SCHEMA_PROBE ${JSON.stringify({
          repository: report.repository, liveToolNames: report.liveToolNames,
          discoveryErrorCode: report.discoveryErrorCode,
          schemaProbePhase: report.schemaProbePhase,
          schemaDiagnostic: report.schemaDiagnostic,
          schemaDiagnosticError: report.schemaDiagnosticError,
          recheck,
        })}`);
        console.log("TOOLS_LIST_DIAGNOSTIC_HOLD: no tool Grants or business calls; temporary encrypted profile remains in this process. Review the failure and any source fix before recheck.");
        diagnosticDeadline ??= Date.now() + 30 * 60_000;
        const remaining = diagnosticDeadline - Date.now();
        if (remaining <= 0) throw Object.assign(new Error(), {
          code: "SCHEMA_DIAGNOSTIC_TIMEOUT" });
        await requireOperatorGate(`RECHECK_CONTRACT ${REPOSITORY.owner}/${REPOSITORY.repo}`,
          abort.signal, { timeoutMs: remaining });
        binding = await restartProductStack(context);
        delete report.schemaDiagnostic;
        delete report.schemaDiagnosticError;
        delete report.schemaProbePhase;
        delete report.discoveryErrorCode;
      }
    }
  } catch (error) {
    if (!live) console.error("GITHUB_ACCEPTANCE_SELF_TEST_DIAGNOSTIC", error?.stack || error);
    report.errorCode = REPORT_ERROR_CODES.has(error?.code)
      ? error.code : "ACCEPTANCE_ASSERTION_FAILED";
    report.needsRemoteVerification = report.stage.includes("pending-verification");
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    if (context) {
      try { await context.close(); }
      catch { report.cleanup = "failed"; process.exitCode = 1; }
    }
    console.log(`GITHUB_ACCEPTANCE_RESULT ${JSON.stringify(report)}`);
  }
}

if (require.main === module) void main();
module.exports = { REPOSITORY, SEED, REQUIRED, assertTemporaryRoot, gitBlobSha,
  isolatedStorage, resultContains, launch, waitForConnection, assertMcpSuccess,
  withRun, grantTools, requireOperatorGate };
