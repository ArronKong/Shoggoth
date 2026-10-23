"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { EncryptedSecretStore } = require("../app/agent-service/encrypted-secret-store");
const { OutlookCalendarGraphController, calendarRange, assertNextLink } =
  require("../app/agent-service/outlook-calendar-graph");
const { OutlookCalendarGraphMcpClient, VIEW_TOOL } =
  require("../app/agent-service/outlook-calendar-graph-mcp-client");
const { PluginStore } = require("../app/agent-service/plugin-store");
const { PluginPackageInstaller } = require("../app/agent-service/plugin-package-installer");
const { PluginComponentCatalog } = require("../app/agent-service/plugin-component-catalog");
const { PluginToolCatalogRegistry } = require("../app/agent-service/plugin-tool-catalog-registry");
const { PermissionEngine } = require("../app/agent-service/permission-engine");
const { CapabilityDispatcher } = require("../app/agent-service/capability-dispatcher");
const { PluginRuntimeToolService, pluginServerId } =
  require("../app/agent-service/plugin-runtime-tool-service");

const CLIENT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const ACCESS = "fixture-access-secret";
const REFRESH = "fixture-refresh-secret";
const RANGE = { startDateTime: "2026-09-27T00:00:00+08:00",
  endDateTime: "2026-09-28T00:00:00+08:00" };
const event = id => ({ id, subject: `Event ${id}`, start: { dateTime: "2026-09-27T01:00:00", timeZone: "UTC" },
  end: { dateTime: "2026-09-27T02:00:00", timeZone: "UTC" }, isAllDay: false,
  showAs: "busy", location: { displayName: "Room" }, organizer: { emailAddress: {
    name: "Fixture", address: "fixture@example.test" } }, body: { content: "private body" } });

function fixtureFetch() {
  const state = { account: "account-a", requests: [], challenge: null, refreshAccount: null,
    mode: "normal", graphGate: null, graphStarted: null, tokenGate: null, tokenStarted: null };
  const json = (body, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json" },
  });
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    state.requests.push({ url: url.href, method: init.method || "GET" });
    if (url.origin === "https://login.microsoftonline.com") {
      assert.equal(url.pathname, "/common/oauth2/v2.0/token");
      const body = new URLSearchParams(init.body);
      assert.equal(body.get("client_id"), CLIENT_ID);
      assert.equal(body.get("scope"), "Calendars.Read User.Read offline_access");
      const grant = body.get("grant_type");
      if (state.tokenStarted) state.tokenStarted();
      if (state.tokenGate) await state.tokenGate;
      if (grant === "authorization_code") {
        assert.equal(crypto.createHash("sha256").update(body.get("code_verifier")).digest("base64url"),
          state.challenge);
        assert.match(body.get("redirect_uri"), /^http:\/\/localhost:\d+\/$/u);
      } else {
        assert.equal(grant, "refresh_token");
        assert.match(body.get("refresh_token"), /^fixture-refresh-secret-/u);
      }
      const account = grant === "refresh_token" && state.refreshAccount
        ? state.refreshAccount : state.account;
      return json({ access_token: `${ACCESS}-${account}`, refresh_token: `${REFRESH}-${account}`,
        token_type: "Bearer", expires_in: 3600, scope: "Calendars.Read User.Read" });
    }
    assert.equal(url.origin, "https://graph.microsoft.com", "token must never reach another origin");
    const tokenAccount = (init.headers.Authorization || "").replace(`Bearer ${ACCESS}-`, "");
    if (url.pathname === "/v1.0/me") {
      assert.equal(url.searchParams.get("$select"), "id");
      return json({ id: tokenAccount });
    }
    assert.equal(url.pathname, "/v1.0/me/calendarView");
    assert.equal(url.searchParams.get("$select"),
      "id,subject,start,end,isAllDay,showAs,location,organizer");
    assert.equal(url.searchParams.get("$top"), "50");
    assert.equal(url.searchParams.get("startDateTime"), RANGE.startDateTime);
    assert.equal(url.searchParams.get("endDateTime"), RANGE.endDateTime);
    if (state.graphStarted) state.graphStarted();
    if (state.graphGate) await state.graphGate;
    if (state.mode === "evil-next") return json({ value: [event("1")],
      "@odata.nextLink": "https://evil.example/steal" });
    if (url.searchParams.has("$skiptoken")) return json({ value: [event("2")] });
    const next = new URL(url);
    next.searchParams.set("$skiptoken", "page-two");
    return json({ value: [event("1")], "@odata.nextLink": next.href });
  };
  return { state, fetchImpl };
}

function callbackRequest(redirect) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: "127.0.0.1", port: Number(redirect.port),
      path: `${redirect.pathname}${redirect.search}`, headers: { Host: redirect.host } }, response => {
      response.resume(); response.on("end", () => resolve(response.statusCode));
    });
    request.on("error", reject);
  });
}

function callbackUrl(started, fixture) {
  const url = new URL(started.authorizationUrl);
  assert.equal(url.origin, "https://login.microsoftonline.com");
  assert.equal(url.searchParams.get("scope"), "Calendars.Read User.Read offline_access");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  fixture.state.challenge = url.searchParams.get("code_challenge");
  const redirect = new URL(url.searchParams.get("redirect_uri"));
  redirect.search = new URLSearchParams({ code: `fixture-${fixture.state.account}`,
    state: url.searchParams.get("state") }).toString();
  return redirect;
}

async function authorize(controller, fixture, profileId) {
  const started = await controller.connect({ profileId });
  assert.equal(await callbackRequest(callbackUrl(started, fixture)), 200);
  assert.equal((await controller.flowStatus({ profileId, flowId: started.flowId })).status, "ready");
}

// This lower-level fixture substitutes the MCP transport with a first-party
// Graph client and exercises Store, Grant, Run and one-use Dispatcher. The
// separate Service fixture verifies the installable bundled sidecar path.
async function exerciseNativeDispatcher(root, paths, controller, principalHash, fixture) {
  const store = new PluginStore({ paths }).open();
  try {
    const sourcePath = path.join(root, "calendar-dispatch-fixture");
    fs.cpSync(path.join(__dirname, "fixtures/plugins/project-assistant"), sourcePath,
      { recursive: true });
    const installer = new PluginPackageInstaller({ store });
    const preview = installer.preview(sourcePath);
    const installed = installer.install({ sourcePath, previewDigest: preview.contentDigest,
      operationId: "calendar-fixture-install", expectedRevision: 0 });
    const installation = store.setInstallationDesiredState({ installationId: installed.installationId,
      desiredState: "enabled", expectedRevision: installed.revision });
    const component = new PluginComponentCatalog({ store }).list()[0].components
      .find(entry => entry.localName === "local-issues");
    const pending = store.createConnection({ connectionId: "calendar-fixture-connection",
      installationId: installed.installationId, componentId: component.componentId,
      endpointIdentity: "fixture://graph-transport-substitute" });
    const principalIdentity = `microsoft-graph:${principalHash}`;
    const connection = store.setConnectionIdentity({ connectionId: pending.connectionId,
      principalIdentity, state: "ready", expectedRevision: pending.revision });
    const created = store.createBinding({ bindingId: "calendar-fixture-binding",
      profileId: "profile-a", installationId: installed.installationId,
      componentId: component.componentId, connectionId: connection.connectionId });
    const binding = store.setBindingEnabled({ bindingId: created.bindingId,
      enabled: true, expectedRevision: created.revision });
    const catalog = new PluginToolCatalogRegistry();
    const productRegistry = { revision: "calendar-fixture", get: name =>
      name === "mcp_server_call" ? { tool: name, enabled: true, risk: "read" } : null,
    list() { return [this.get("mcp_server_call")]; } };
    const permissionEngine = new PermissionEngine({ toolRegistry: productRegistry });
    const dispatcher = new CapabilityDispatcher({ store, permissionEngine,
      resolveToolContract: input => catalog.resolve(input) });
    const createClient = () => new OutlookCalendarGraphMcpClient({ calendar: controller,
      connectionId: connection.connectionId, principalIdentity,
      authorizeEgress: request => dispatcher.authorizeEgress(request),
      assertCurrent() {
        const live = store.getConnection(connection.connectionId);
        if (live?.state !== "ready" || live.principalIdentity !== principalIdentity
          || live.authRevision !== connection.authRevision) {
          throw Object.assign(new Error("calendar connection changed"), { code: "GRANT_REVOKED" });
        }
      } });
    const discovery = createClient();
    const discovered = await catalog.refresh({ installation, connection, client: discovery });
    await discovery.release();
    const tool = discovered.entries.find(entry => entry.downstreamName === VIEW_TOOL.name);
    assert(tool);
    const grant = store.setGrant({ grantId: "calendar-fixture-grant",
      bindingId: binding.bindingId, toolIdentity: tool.toolIdentity,
      contractDigest: tool.contractDigest, effect: "allow", approvalMode: "always",
      expectedRevision: 0 });
    const run = { id: "calendar-fixture-run", profileId: "profile-a",
      workspace: root, status: "running" };
    const runtime = new PluginRuntimeToolService({ store,
      productStore: { getAgentProfile: id => id === "profile-a"
        ? { id, enabled: true } : null }, getRun: id => id === run.id ? run : null,
      toolCatalogRegistry: catalog, capabilityDispatcher: dispatcher, permissionEngine,
      acquireConnection: async () => createClient() });
    assert.equal(runtime.captureRun(run).serverCount, 1);
    const call = { serverId: pluginServerId(binding.bindingId), toolName: VIEW_TOOL.name,
      arguments: RANGE };
    const scope = { runId: run.id, assertCurrent() {} };
    const authority = { profileId: "profile-a", callId: crypto.randomUUID() };
    assert.deepEqual((await runtime.listTools({ serverId: call.serverId, cursor: 0, limit: 20 },
      authority, scope)).items.map(entry => entry.name), [VIEW_TOOL.name]);
    const answer = await runtime.callTool(call, authority, scope);
    assert.deepEqual(answer.result.structuredContent.events.map(item => item.id), ["1", "2"]);
    assert.equal(JSON.stringify(answer).includes("private body"), false);
    const graphRequests = () => fixture.state.requests.filter(item =>
      new URL(item.url).pathname === "/v1.0/me/calendarView").length;
    const sent = graphRequests();
    await assert.rejects(runtime.callTool(call, authority, scope),
      { code: "CALL_ALREADY_RECORDED" });
    await assert.rejects(runtime.callTool(call,
      { profileId: "profile-b", callId: crypto.randomUUID() }, scope),
    { code: "CAPABILITY_FORBIDDEN" });
    assert.equal(graphRequests(), sent, "replayed or foreign Run calls must not reach Graph");
    let releasePage;
    fixture.state.graphGate = new Promise(resolve => { releasePage = resolve; });
    const pageStarted = new Promise(resolve => { fixture.state.graphStarted = resolve; });
    const inFlight = runtime.callTool(call,
      { profileId: "profile-a", callId: crypto.randomUUID() }, scope);
    await pageStarted;
    store.setGrant({ grantId: grant.grantId, bindingId: binding.bindingId,
      toolIdentity: tool.toolIdentity, contractDigest: tool.contractDigest,
      effect: "deny", approvalMode: "always", expectedRevision: grant.revision });
    fixture.state.graphGate = null;
    fixture.state.graphStarted = null;
    releasePage();
    await assert.rejects(inFlight, { code: "GRANT_REVOKED" });
    assert.equal(graphRequests(), sent + 1,
      "a revoked Grant must stop an in-flight read before its second Graph page");
    await assert.rejects(runtime.callTool(call,
      { profileId: "profile-a", callId: crypto.randomUUID() }, scope),
    { code: "GRANT_REVOKED" });
    assert.equal(graphRequests(), sent + 1, "new calls after revocation must not reach Graph");
    runtime.releaseRun(run.id);
  } finally { store.close(); }
}

async function main() {
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/shoggoth-outlook-graph-"));
  const paths = resolveServicePaths({ userDataRoot: path.join(root, "user"),
    cacheRoot: path.join(root, "cache"), trustedRoot: root });
  fs.mkdirSync(paths.pluginsDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(paths.pluginsDir, "outlook-calendar-graph.json"),
    JSON.stringify({ version: 1, clientId: CLIENT_ID }), { mode: 0o600 });
  const key = crypto.randomBytes(32);
  const cryptoBroker = {
    async encrypt(bytes) {
      const nonce = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
      return Buffer.concat([nonce, cipher.update(bytes), cipher.final(), cipher.getAuthTag()]);
    },
    async decrypt(bytes) {
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(-16));
      return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]);
    },
  };
  const secrets = await new EncryptedSecretStore({ paths, cryptoBroker }).open();
  const profiles = new Map([["profile-a", { id: "profile-a", enabled: true }],
    ["profile-b", { id: "profile-b", enabled: true }]]);
  const products = { getAgentProfile: id => profiles.get(id) || null };
  const fixture = fixtureFetch();
  let now = Date.now();
  const controller = new OutlookCalendarGraphController({ paths, secretStore: secrets,
    productStore: products, fetchImpl: fixture.fetchImpl, now: () => now });
  const unconfigured = new OutlookCalendarGraphController({ paths, secretStore: secrets,
    productStore: products, config: null, fetchImpl: fixture.fetchImpl });
  try {
    assert.equal((await unconfigured.status({ profileId: "profile-a" })).configured, false);
    await assert.rejects(unconfigured.connect({ profileId: "profile-a" }),
      { code: "OUTLOOK_CALENDAR_UNAVAILABLE" });
    assert.deepEqual((await controller.status({ profileId: "profile-a" })).connected, false);
    await assert.rejects(controller.calendarView({ profileId: "profile-a", ...RANGE }),
      { code: "OUTLOOK_CALENDAR_AUTH_REQUIRED" });
    assert.throws(() => calendarRange({ startDateTime: "2026-02-30T00:00:00Z",
      endDateTime: RANGE.endDateTime }), { code: "OUTLOOK_CALENDAR_RANGE_INVALID" });
    assert.throws(() => calendarRange({ startDateTime: RANGE.endDateTime,
      endDateTime: RANGE.startDateTime }), { code: "OUTLOOK_CALENDAR_RANGE_INVALID" });
    assert.throws(() => assertNextLink("https://evil.example/steal", RANGE),
      { code: "OUTLOOK_CALENDAR_REMOTE_FAILED" });
    const nextLink = new URL("https://graph.microsoft.com/v1.0/me/calendarView");
    nextLink.search = new URLSearchParams({ ...RANGE,
      "$select": "id,subject,start,end,isAllDay,showAs,location,organizer",
      "$top": "50", "$skiptoken": "page-two" }).toString();
    assert.equal(assertNextLink(nextLink.href, RANGE), nextLink.href);
    for (const key of ["startDateTime", "endDateTime", "$select", "$top"]) {
      const missing = new URL(nextLink);
      missing.searchParams.delete(key);
      assert.throws(() => assertNextLink(missing.href, RANGE),
        { code: "OUTLOOK_CALENDAR_REMOTE_FAILED" }, `nextLink must retain ${key}`);
      const changed = new URL(nextLink);
      changed.searchParams.set(key, "changed");
      assert.throws(() => assertNextLink(changed.href, RANGE),
        { code: "OUTLOOK_CALENDAR_REMOTE_FAILED" }, `nextLink must preserve ${key}`);
    }
    const firstConnect = controller.connect({ profileId: "profile-a" });
    await assert.rejects(controller.connect({ profileId: "profile-b" }),
      { code: "OUTLOOK_CALENDAR_AUTH_BUSY" });
    const reservedFlow = await firstConnect;
    assert.deepEqual(controller.cancel({ profileId: "profile-a", flowId: reservedFlow.flowId }),
      { canceled: true });
    await authorize(controller, fixture, "profile-a");
    const a = await controller.status({ profileId: "profile-a" });
    assert.equal(a.connected, true);
    assert.equal((await controller.status({ profileId: "profile-b" })).connected, false);
    assert.equal((await controller.status({ profileId: "profile-a", client: "openclaw" })).connected, false);
    await assert.rejects(controller.calendarView({ profileId: "profile-a", client: "openclaw", ...RANGE }),
      { code: "OUTLOOK_CALENDAR_AUTH_REQUIRED" });
    await controller.grant({ profileId: "profile-a", client: "openclaw" });
    await controller.grant({ profileId: "profile-a", client: "hermes" });
    await controller.grant({ profileId: "profile-b", client: "native" });
    const three = await Promise.all(["native", "openclaw", "hermes"].map(client =>
      controller.calendarView({ profileId: "profile-a", client, ...RANGE })));
    assert.deepEqual(three.map(item => item.events.map(e => e.id)), [["1", "2"], ["1", "2"], ["1", "2"]]);
    assert.equal(three.every(item => item.pages === 2 && item.truncated === false), true);
    assert.equal(JSON.stringify(three).includes("private body"), false);

    // The independent first-party tool only reads after a one-use Service
    // dispatch ticket. A foreign account, revoked authority or reused ticket
    // cannot send a Graph calendar request, even though the OAuth account is
    // connected and the controller itself has its historical fixture grants.
    const tickets = new Set(["calendar-ticket-1", "calendar-ticket-2"]);
    let currentAuthority = true;
    const graphClient = new OutlookCalendarGraphMcpClient({ calendar: controller,
      connectionId: "calendar-connection", principalIdentity: `microsoft-graph:${a.principalHash}`,
      assertCurrent() {
        if (!currentAuthority) throw Object.assign(new Error("revoked"), { code: "GRANT_REVOKED" });
      },
      authorizeEgress({ connectionId, principalIdentity, toolName, arguments: args, authority }) {
        assert.equal(connectionId, "calendar-connection");
        assert.equal(principalIdentity, `microsoft-graph:${a.principalHash}`);
        assert.equal(toolName, VIEW_TOOL.name);
        assert.deepEqual(args, RANGE);
        if (!tickets.delete(authority.ticketId)) {
          throw Object.assign(new Error("missing ticket"), { code: "CAPABILITY_FORBIDDEN" });
        }
      } });
    assert.deepEqual((await graphClient.listTools())[0], VIEW_TOOL);
    const graphResult = await graphClient.callTool(VIEW_TOOL.name, RANGE,
      { ticketId: "calendar-ticket-1" });
    assert.deepEqual(graphResult.structuredContent.events.map(item => item.id), ["1", "2"]);
    assert.equal(JSON.stringify(graphResult).includes("private body"), false);
    const sentBeforeDenied = fixture.state.requests.filter(item =>
      new URL(item.url).pathname === "/v1.0/me/calendarView").length;
    await assert.rejects(graphClient.callTool(VIEW_TOOL.name, RANGE,
      { ticketId: "calendar-ticket-1" }), { code: "CAPABILITY_FORBIDDEN" });
    const foreignClient = new OutlookCalendarGraphMcpClient({ calendar: controller,
      connectionId: "calendar-connection", principalIdentity: `microsoft-graph:${"0".repeat(64)}`,
      assertCurrent() {}, authorizeEgress() {} });
    await assert.rejects(foreignClient.callTool(VIEW_TOOL.name, RANGE,
      { ticketId: "foreign-ticket" }), { code: "OUTLOOK_CALENDAR_AUTH_REQUIRED" });
    currentAuthority = false;
    await assert.rejects(graphClient.callTool(VIEW_TOOL.name, RANGE,
      { ticketId: "calendar-ticket-2" }), { code: "GRANT_REVOKED" });
    assert.equal(fixture.state.requests.filter(item =>
      new URL(item.url).pathname === "/v1.0/me/calendarView").length, sentBeforeDenied,
    "foreign or revoked tool calls must not reach Graph");
    await graphClient.release();
    await foreignClient.release();
    await exerciseNativeDispatcher(root, paths, controller, a.principalHash, fixture);
    const pluginPrincipal = `microsoft-graph:${a.principalHash}`;
    controller.deactivatePluginAccount({ principalIdentity: pluginPrincipal });
    const beforeDeactivatedRead = fixture.state.requests.length;
    await assert.rejects(controller.calendarViewForPrincipal({ principalIdentity: pluginPrincipal,
      ...RANGE, assertCurrent() {} }), { code: "OUTLOOK_CALENDAR_AUTH_REQUIRED" });
    assert.equal(fixture.state.requests.length, beforeDeactivatedRead);
    assert.equal((await controller.calendarView({ profileId: "profile-a",
      client: "openclaw", ...RANGE })).events.length, 2,
    "deactivating plugin principal must preserve separately granted host access");
    const freshProcess = new OutlookCalendarGraphController({ paths, secretStore: secrets,
      productStore: products, fetchImpl: fixture.fetchImpl, now: () => now });
    try {
      const beforeActivation = await freshProcess.status({ profileId: "profile-a", client: "openclaw" });
      assert.equal(beforeActivation.accountConnected, true);
      assert.equal(beforeActivation.connected, false);
      assert.equal(beforeActivation.activationRequired, true);
      const beforeDormantRead = fixture.state.requests.length;
      await assert.rejects(freshProcess.calendarView({ profileId: "profile-a",
        client: "openclaw", ...RANGE }), { code: "OUTLOOK_CALENDAR_AUTH_REQUIRED" });
      await assert.rejects(freshProcess.calendarViewForPrincipal({
        principalIdentity: `microsoft-graph:${a.principalHash}`,
        ...RANGE, assertCurrent() {} }), { code: "OUTLOOK_CALENDAR_AUTH_REQUIRED" });
      assert.equal(fixture.state.requests.length, beforeDormantRead);
      // This direct grant call is fixture-only. A product caller must prove a
      // fresh user decision and derive the host identity before invoking it.
      await freshProcess.grant({ profileId: "profile-a", client: "openclaw" });
      assert.equal((await freshProcess.calendarView({ profileId: "profile-a",
        client: "openclaw", ...RANGE })).events.length, 2);
    } finally { await freshProcess.close(); }

    // Canceling a switch after the new encrypted record was written must
    // restore the old shared account and every existing host grant.
    const originalPutIfRevision = secrets.putIfRevision.bind(secrets);
    let releaseSwitchWrite;
    const switchWriteGate = new Promise(resolve => { releaseSwitchWrite = resolve; });
    let signalSwitchWrite;
    const switchWriteStarted = new Promise(resolve => { signalSwitchWrite = resolve; });
    let holdOneWrite = true;
    secrets.putIfRevision = async (...args) => {
      const result = await originalPutIfRevision(...args);
      if (holdOneWrite) {
        holdOneWrite = false;
        signalSwitchWrite();
        await switchWriteGate;
      }
      return result;
    };
    fixture.state.account = "account-c";
    const switching = await controller.connect({ profileId: "profile-b" });
    const switchCallback = callbackRequest(callbackUrl(switching, fixture));
    await switchWriteStarted;
    const switchEgressBefore = fixture.state.requests.length;
    await assert.rejects(controller.calendarView({ profileId: "profile-a",
      client: "openclaw", ...RANGE }), { code: "OUTLOOK_CALENDAR_AUTH_REQUIRED" });
    assert.equal(fixture.state.requests.length, switchEgressBefore,
      "a not-yet-committed replacement account must never reach Graph");
    assert.deepEqual(controller.cancel({ profileId: "profile-b", flowId: switching.flowId }),
      { canceled: true });
    releaseSwitchWrite();
    assert.equal(await switchCallback, 400);
    secrets.putIfRevision = originalPutIfRevision;
    assert.equal((await controller.status({ profileId: "profile-a" })).principalHash, a.principalHash);
    assert.equal((await controller.status({ profileId: "profile-b" })).connected, true);
    for (const client of ["native", "openclaw", "hermes"]) {
      assert.equal((await controller.calendarView({ profileId: "profile-a", client, ...RANGE }))
        .events.length, 2);
    }
    fixture.state.account = "account-a";

    const encrypted = fs.readFileSync(paths.encryptedSecretsPath, "utf8");
    assert.equal(encrypted.includes(ACCESS), false);
    assert.equal(encrypted.includes(REFRESH), false);
    fixture.state.mode = "evil-next";
    await assert.rejects(controller.calendarView({ profileId: "profile-a", ...RANGE }),
      { code: "OUTLOOK_CALENDAR_REMOTE_FAILED" });
    assert.equal(fixture.state.requests.some(item => item.url.startsWith("https://evil.example")), false);
    fixture.state.mode = "normal";

    // A refresh response identifying a different Microsoft account is never
    // accepted as a continuation of the current shared credential.
    now += 3590_000;
    fixture.state.refreshAccount = "account-b";
    await assert.rejects(controller.calendarView({ profileId: "profile-a", ...RANGE }),
      { code: "OUTLOOK_CALENDAR_AUTH_FAILED" });
    fixture.state.refreshAccount = null;
    assert.equal((await controller.calendarView({ profileId: "profile-a", ...RANGE })).events.length, 2);

    // A new account replaces the single shared credential and revokes every
    // previous host/Profile grant; no old host can inherit it.
    fixture.state.account = "account-b";
    await authorize(controller, fixture, "profile-b");
    assert.notEqual((await controller.status({ profileId: "profile-b" })).principalHash, a.principalHash);
    for (const client of ["native", "openclaw", "hermes"]) {
      await assert.rejects(controller.calendarView({ profileId: "profile-a", client, ...RANGE }),
        { code: "OUTLOOK_CALENDAR_AUTH_REQUIRED" });
    }

    // During an intentionally delayed durable revoke, admission stays closed
    // even though the old encrypted record still exists.
    const originalDelete = secrets.delete.bind(secrets);
    let releaseDelete;
    const deleteGate = new Promise(resolve => { releaseDelete = resolve; });
    let deleteStarted;
    const deleting = new Promise(resolve => { deleteStarted = resolve; });
    secrets.delete = async (...args) => { deleteStarted(); await deleteGate; return originalDelete(...args); };
    const revoke = controller.disconnect({ profileId: "profile-b" });
    await deleting;
    const before = fixture.state.requests.length;
    assert.equal((await controller.status({ profileId: "profile-b" })).connected, false);
    await assert.rejects(controller.calendarView({ profileId: "profile-b", ...RANGE }),
      { code: "OUTLOOK_CALENDAR_AUTH_REQUIRED" });
    await assert.rejects(controller.grant({ profileId: "profile-b", client: "openclaw" }),
      { code: "OUTLOOK_CALENDAR_UNAVAILABLE" });
    assert.equal(fixture.state.requests.length, before);
    releaseDelete();
    assert.deepEqual(await revoke, { disconnected: true, hadConnection: true });
    assert.equal((await controller.status({ profileId: "profile-b" })).accountConnected, false);
    secrets.delete = originalDelete;

    // Cancel an already exchanging callback while its token response is held.
    // The callback cannot commit a credential after the cancellation.
    let releaseToken;
    fixture.state.tokenGate = new Promise(resolve => { releaseToken = resolve; });
    const tokenStarted = new Promise(resolve => { fixture.state.tokenStarted = resolve; });
    const pending = await controller.connect({ profileId: "profile-a" });
    const callback = callbackRequest(callbackUrl(pending, fixture));
    await tokenStarted;
    assert.deepEqual(controller.cancel({ profileId: "profile-a", flowId: pending.flowId }), { canceled: true });
    releaseToken();
    assert.equal(await callback, 400);
    assert.equal((await controller.status({ profileId: "profile-a" })).accountConnected, false);

    // Two independent failed durable revocations cannot be repaired by
    // retrying only the second subject while the first grant still exists.
    await authorize(controller, fixture, "profile-b");
    await controller.grant({ profileId: "profile-a", client: "native" });
    await controller.grant({ profileId: "profile-a", client: "openclaw" });
    secrets.putIfRevision = async () => { throw new Error("fixture grant revoke write failed"); };
    await assert.rejects(controller.disconnect({ profileId: "profile-a", client: "native" }),
      /grant revoke write failed/u);
    await assert.rejects(controller.disconnect({ profileId: "profile-a", client: "openclaw" }),
      /grant revoke write failed/u);
    secrets.putIfRevision = originalPutIfRevision;
    await controller.disconnect({ profileId: "profile-a", client: "openclaw" });
    assert.equal((await controller.status({ profileId: "profile-b" })).revocationFailed, true);
    await assert.rejects(controller.calendarView({ profileId: "profile-b", ...RANGE }),
      { code: "OUTLOOK_CALENDAR_UNAVAILABLE" });
    await controller.disconnect({ profileId: "profile-a", client: "native" });
    assert.equal((await controller.status({ profileId: "profile-b" })).revocationFailed, false);

    // A failed encrypted-store deletion must never revive the old grant for
    // subsequent reads. A successful explicit retry repairs the local state.
    secrets.delete = async () => { throw new Error("fixture durable delete failed"); };
    await assert.rejects(controller.disconnect({ profileId: "profile-b" }), /durable delete failed/u);
    const failed = await controller.status({ profileId: "profile-b" });
    assert.equal(failed.revocationFailed, true);
    assert.equal(failed.connected, false);
    await assert.rejects(controller.calendarView({ profileId: "profile-b", ...RANGE }),
      { code: "OUTLOOK_CALENDAR_UNAVAILABLE" });
    // A process restart loses the in-memory failure latch. The encrypted
    // credential may still contain the old grant, but it must not be active
    // or cause any Graph request until a fresh, trusted activation occurs.
    const restarted = new OutlookCalendarGraphController({ paths, secretStore: secrets,
      productStore: products, fetchImpl: fixture.fetchImpl, now: () => now });
    try {
      const postRestart = await restarted.status({ profileId: "profile-b" });
      assert.equal(postRestart.accountConnected, true);
      assert.equal(postRestart.connected, false);
      assert.equal(postRestart.activationRequired, true);
      const beforeRestartRead = fixture.state.requests.length;
      await assert.rejects(restarted.calendarView({ profileId: "profile-b", ...RANGE }),
        { code: "OUTLOOK_CALENDAR_AUTH_REQUIRED" });
      assert.equal(fixture.state.requests.length, beforeRestartRead);
    } finally { await restarted.close(); }
    assert.deepEqual(await controller.disconnect({ profileId: "profile-a" }),
      { disconnected: true, hadConnection: false });
    assert.equal((await controller.status({ profileId: "profile-b" })).revocationFailed, true,
      "a different subject cannot clear the failed-revoke latch");
    await assert.rejects(controller.calendarView({ profileId: "profile-b", ...RANGE }),
      { code: "OUTLOOK_CALENDAR_UNAVAILABLE" });
    secrets.delete = originalDelete;
    await controller.disconnect({ profileId: "profile-b" });
    assert.equal((await controller.status({ profileId: "profile-b" })).revocationFailed, false);
    console.log("plugin-outlook-calendar-graph-unit: ok (OAuth, three-host grant isolation, Graph bounds, switch, revoke fence)");
  } finally {
    await unconfigured.close();
    await controller.close();
    await secrets.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
