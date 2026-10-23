"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const { CAPABILITIES, SHAREPOINT_ITEMS_TOOL, SHAREPOINT_ITEM_FIELDS_TOOL,
  listRequest, projectList } =
  require("../app/agent-service/plugin-microsoft-graph-capabilities");
const { OutlookCalendarGraphController } =
  require("../app/agent-service/outlook-calendar-graph");
const { MicrosoftGraphFamilyMcpClient, TOOLS, TOOLS_BY_PACKAGE } =
  require("../app/agent-service/plugin-microsoft-graph-mcp-client");

const CLIENT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const RANGE = { startDateTime: "2026-09-27T00:00:00+08:00",
  endDateTime: "2026-09-28T00:00:00+08:00" };
const SITE_ID = "contoso.sharepoint.com,11111111-2222-4333-8444-555555555555,aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const LIST_ID = "b5dabb84-f89f-4317-a884-99b3d2067c2c";
const FIELD_INPUT = Object.freeze({ siteId: SITE_ID, listId: LIST_ID,
  itemId: "item-1", fieldNames: ["Title", "Quantity"] });
const json = value => new Response(JSON.stringify(value), {
  status: 200, headers: { "Content-Type": "application/json" },
});

function fixture() {
  const state = { account: "account-a", refreshAccount: null, omitScope: null,
    extraScope: null,
    graphMode: "normal", requests: [], revision: null, stored: null, nextRevision: 1 };
  const secrets = {
    getCredentialRevision() { return state.revision; },
    async get() { return state.stored; },
    async putIfRevision(_ref, value, _meta, expectedRevision) {
      assert.equal(state.revision, expectedRevision);
      state.stored = value;
      state.revision = state.nextRevision++;
      return { revision: state.revision };
    },
    async delete() { state.revision = null; state.stored = null; },
  };
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    state.requests.push({ url: url.href, method: init.method || "GET" });
    if (url.origin === "https://login.microsoftonline.com") {
      const form = new URLSearchParams(init.body);
      assert.equal(form.get("client_id"), CLIENT_ID);
      const scope = form.get("scope").split(" ").filter(item => item !== "offline_access"
        && item !== state.omitScope);
      if (state.extraScope) scope.push(state.extraScope);
      const account = form.get("grant_type") === "refresh_token" && state.refreshAccount
        ? state.refreshAccount : state.account;
      return json({ access_token: `access-token-${account}`,
        refresh_token: `refresh-token-${account}`, expires_in: 3600,
        token_type: "Bearer", scope: scope.join(" ") });
    }
    assert.equal(url.origin, "https://graph.microsoft.com");
    assert.equal(init.method, "GET");
    assert.match(init.headers.Authorization, /^Bearer access-token-account-[ab]$/u);
    if (url.pathname === "/v1.0/me" && url.searchParams.get("$select") === "id") {
      return json({ id: init.headers.Authorization.replace("Bearer access-token-", "") });
    }
    if (url.pathname === "/v1.0/me/calendarView") return json({ value: [] });
    if (url.pathname === "/v1.0/me/messages") return json({ value: [{ id: "mail-1",
      subject: "Report", receivedDateTime: "2026-09-27T00:00:00Z", isRead: true,
      sender: { emailAddress: { name: "Alice", address: "alice@example.test" } },
      body: { content: "PRIVATE BODY" }, attachments: ["PRIVATE ATTACHMENT"] }],
    "@odata.nextLink": state.graphMode === "evil-next" ? "https://evil.example/steal" : undefined });
    if (url.pathname === `/v1.0/sites/${SITE_ID}/lists`) return json({ value: [
      { id: LIST_ID, name: "Documents", displayName: "Documents", list: { template: "documentLibrary" },
        columns: ["PRIVATE COLUMN"] }] });
    if (url.pathname === `/v1.0/sites/${SITE_ID}/lists/${LIST_ID}/items`) return json({ value: [
      { id: "item-1", name: "Document A", createdDateTime: "2026-09-27T00:00:00Z",
        lastModifiedDateTime: "2026-09-27T01:00:00Z", fields: { Secret: "PRIVATE FIELD" },
        description: "PRIVATE DESCRIPTION" }] });
    if (url.pathname === `/v1.0/sites/${SITE_ID}/lists/${LIST_ID}/items/item-1`) {
      assert.equal(url.searchParams.get("expand"), "fields(select=Title,Quantity)");
      return json({ id: "item-1", fields: { Title: "Document A", Quantity: 7,
        Secret: "PRIVATE FIELD" }, driveItem: { content: "PRIVATE FILE" } });
    }
    if (url.pathname === "/v1.0/me/chats") return json({ value: [
      { id: "chat-1", chatType: "group", topic: "Project", messages: ["PRIVATE MESSAGE"] }] });
    throw new Error(`Unexpected Graph path: ${url.pathname}`);
  };
  return { state, secrets, fetchImpl };
}

async function authorize(controller, state, { packageId = "outlook-calendar", onReady,
  expectedAccountRevision } = {}) {
  const started = packageId === "outlook-calendar"
    ? await controller.connect({ profileId: "profile-a", onReady })
    : await controller.connectForCapability({ profileId: "profile-a", packageId, onReady,
      expectedAccountRevision });
  const authorization = new URL(started.authorizationUrl);
  assert.equal(authorization.origin, "https://login.microsoftonline.com");
  const scopes = authorization.searchParams.get("scope").split(" ");
  assert.ok(scopes.includes("User.Read") && scopes.includes("offline_access"));
  if (packageId !== "outlook-calendar") assert.ok(scopes.includes(CAPABILITIES[packageId].scope));
  const callback = new URL(authorization.searchParams.get("redirect_uri"));
  callback.search = new URLSearchParams({ code: `fixture-${state.account}`,
    state: authorization.searchParams.get("state") }).toString();
  const status = await new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port: Number(callback.port),
      path: `${callback.pathname}${callback.search}`,
      headers: { Host: callback.host } }, res => {
      res.resume(); res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
  });
  return { status, scopes };
}

async function main() {
  assert.deepEqual(Object.keys(CAPABILITIES).sort(), ["outlook-email", "sharepoint", "teams"]);
  assert.equal(new URL(listRequest("outlook-email", {})).pathname, "/v1.0/me/messages");
  assert.equal(new URL(listRequest("sharepoint", { siteId: SITE_ID })).pathname,
    `/v1.0/sites/${SITE_ID}/lists`);
  assert.equal(new URL(listRequest("sharepoint", { siteId: SITE_ID, listId: LIST_ID },
    SHAREPOINT_ITEMS_TOOL)).pathname, `/v1.0/sites/${SITE_ID}/lists/${LIST_ID}/items`);
  const fieldUrl = new URL(listRequest("sharepoint", FIELD_INPUT, SHAREPOINT_ITEM_FIELDS_TOOL));
  assert.equal(fieldUrl.pathname, `/v1.0/sites/${SITE_ID}/lists/${LIST_ID}/items/item-1`);
  assert.equal(fieldUrl.searchParams.get("expand"), "fields(select=Title,Quantity)");
  assert.equal(fieldUrl.searchParams.size, 1);
  assert.equal(new URL(listRequest("teams", {})).pathname, "/v1.0/me/chats");
  assert.throws(() => listRequest("sharepoint", { siteId: "../me" }),
    { code: "MICROSOFT_GRAPH_INPUT_INVALID" });
  for (const bad of [{ siteId: ".", listId: LIST_ID },
    { siteId: "..", listId: LIST_ID },
    { siteId: SITE_ID, listId: ".." },
    { siteId: SITE_ID, listId: "../me" },
    { siteId: SITE_ID, listId: `${LIST_ID}?$expand=fields` },
    { siteId: SITE_ID, listId: LIST_ID, extra: true }]) {
    assert.throws(() => listRequest("sharepoint", bad, SHAREPOINT_ITEMS_TOOL),
      { code: "MICROSOFT_GRAPH_INPUT_INVALID" });
  }
  assert.throws(() => listRequest("sharepoint", { siteId: SITE_ID, listId: LIST_ID }),
    { code: "MICROSOFT_GRAPH_INPUT_INVALID" },
    "list item input cannot be smuggled through the separately granted lists tool");
  for (const bad of [
    { ...FIELD_INPUT, siteId: "../me" },
    { ...FIELD_INPUT, listId: `${LIST_ID}?expand=fields` },
    { ...FIELD_INPUT, itemId: "../me" },
    { ...FIELD_INPUT, fieldNames: [] },
    { ...FIELD_INPUT, fieldNames: ["Title", "Title"] },
    { ...FIELD_INPUT, fieldNames: ["Title", "Secret)" ] },
    { ...FIELD_INPUT, fieldNames: Array.from({ length: 9 }, (_, index) => `Field${index}`) },
    { ...FIELD_INPUT, extra: true },
  ]) assert.throws(() => listRequest("sharepoint", bad, SHAREPOINT_ITEM_FIELDS_TOOL),
    { code: "MICROSOFT_GRAPH_INPUT_INVALID" });
  assert.throws(() => listRequest("sharepoint", FIELD_INPUT, SHAREPOINT_ITEMS_TOOL),
    { code: "MICROSOFT_GRAPH_INPUT_INVALID" });
  assert.throws(() => listRequest("outlook-email", { folder: "inbox" }),
    { code: "MICROSOFT_GRAPH_INPUT_INVALID" });
  assert.equal(projectList("teams", { value: Array.from({ length: 21 }, (_, id) =>
    ({ id: `chat-${id}` })) }).truncated, true);
  assert.deepEqual(projectList("sharepoint", { value: [{ id: "item-1", name: "Document A",
    fields: { Secret: "PRIVATE" } }] }, SHAREPOINT_ITEMS_TOOL),
  { items: [{ id: "item-1", name: "Document A", createdDateTime: null,
    lastModifiedDateTime: null }], truncated: false });
  assert.equal(projectList("sharepoint", { value: Array.from({ length: 21 }, (_, index) =>
    ({ id: `item-${index}` })) }, SHAREPOINT_ITEMS_TOOL).truncated, true);
  assert.equal(projectList("sharepoint", { value: [{ id: "item-1" }],
    "@odata.nextLink": "https://evil.example/next" }, SHAREPOINT_ITEMS_TOOL).truncated, true);
  assert.deepEqual(projectList("sharepoint", { id: "item-1", fields: {
    Title: "Document A", Quantity: 7, Secret: "PRIVATE", Nested: { secret: "PRIVATE" },
  }, driveItem: { content: "PRIVATE" } }, SHAREPOINT_ITEM_FIELDS_TOOL, FIELD_INPUT),
  { id: "item-1", fields: { Title: "Document A", Quantity: 7 } });
  for (const bad of [
    { id: "other", fields: { Title: "Document A", Quantity: 7 } },
    { id: "item-1", fields: { Title: "Document A" } },
    { id: "item-1", fields: { Title: { content: "PRIVATE" }, Quantity: 7 } },
    { id: "item-1", fields: { Title: "x".repeat(1025), Quantity: 7 } },
  ]) assert.throws(() => projectList("sharepoint", bad,
    SHAREPOINT_ITEM_FIELDS_TOOL, FIELD_INPUT), { code: "MICROSOFT_GRAPH_REMOTE_FAILED" });
  assert.throws(() => projectList("sharepoint", { id: "item-1", fields: {
    Title: "Document A", Quantity: 7 } }, SHAREPOINT_ITEM_FIELDS_TOOL,
  { ...FIELD_INPUT, fieldNames: ["Unknown"] }), { code: "MICROSOFT_GRAPH_REMOTE_FAILED" });
  const eightFields = Array.from({ length: 8 }, (_, index) => `Field${index}`);
  assert.throws(() => projectList("sharepoint", { id: "item-1",
    fields: Object.fromEntries(eightFields.map(name => [name, "x".repeat(1024)])) },
  SHAREPOINT_ITEM_FIELDS_TOOL, { ...FIELD_INPUT, fieldNames: eightFields }),
  { code: "MICROSOFT_GRAPH_REMOTE_FAILED" }, "8 KiB projection limit is independent of per-field limits");
  assert.deepEqual(TOOLS_BY_PACKAGE.sharepoint.map(tool => tool.name),
    ["sharepoint_site_lists", SHAREPOINT_ITEMS_TOOL, SHAREPOINT_ITEM_FIELDS_TOOL]);

  const { state, secrets, fetchImpl } = fixture();
  let now = Date.now();
  const makeController = () => new OutlookCalendarGraphController({
    paths: { pluginsDir: "/unused-in-injected-config" }, secretStore: secrets,
    productStore: { getAgentProfile: id => id === "profile-a" ? { id, enabled: true } : null },
    fetchImpl, now: () => now, config: { version: 1, clientId: CLIENT_ID },
  });
  const controller = makeController();
  try {
    assert.equal((await authorize(controller, state)).status, 200);
    const initial = await controller.status({ profileId: "profile-a" });
    assert.equal(initial.connected, true);
    const oldPrincipal = `microsoft-graph:${initial.principalHash}`;
    const input = {};
    const graphCount = () => state.requests.filter(request =>
      new URL(request.url).origin === "https://graph.microsoft.com"
      && new URL(request.url).pathname !== "/v1.0/me").length;
    const beforeMissingScope = graphCount();
    await assert.rejects(controller.readCollectionForPrincipal({ principalIdentity: oldPrincipal,
      packageId: "outlook-email", input, assertCurrent() {} }),
    { code: "OUTLOOK_CALENDAR_AUTH_REQUIRED" });
    await assert.rejects(controller.activatePluginAccount({ principalIdentity: oldPrincipal,
      packageId: "teams", assertCurrent() {} }), { code: "OUTLOOK_CALENDAR_AUTH_REQUIRED" });
    assert.equal(graphCount(), beforeMissingScope, "missing scope must send no Graph read");

    state.omitScope = "Mail.ReadBasic";
    assert.equal((await authorize(controller, state, { packageId: "outlook-email" })).status, 400,
      "missing requested scope must fail before replacing the account");
    state.omitScope = null;
    assert.equal((await controller.status({ profileId: "profile-a" })).connected, true);
    state.extraScope = "Chat.ReadBasic";
    assert.equal((await authorize(controller, state, { packageId: "outlook-email" })).status, 400,
      "an unrequested extra capability scope must not silently widen authority");
    state.extraScope = null;
    assert.equal((await controller.status({ profileId: "profile-a" })).connected, true);
    const emailPlan = await controller.consentPlanForCapability("outlook-email");
    assert.deepEqual(emailPlan.scopes, ["Calendars.Read", "Mail.ReadBasic",
      "User.Read", "offline_access"]);
    assert.equal(emailPlan.accountRevision, state.revision);
    await assert.rejects(controller.connectForCapability({ profileId: "profile-a",
      packageId: "outlook-email", expectedAccountRevision: state.revision + 1 }),
    { code: "OUTLOOK_CALENDAR_AUTH_FAILED" });
    const emailConsent = await authorize(controller, state, { packageId: "outlook-email",
      expectedAccountRevision: emailPlan.accountRevision });
    assert.equal(emailConsent.status, 200);
    assert.deepEqual(emailConsent.scopes, ["Calendars.Read", "Mail.ReadBasic",
      "User.Read", "offline_access"]);
    assert.equal((await controller.status({ profileId: "profile-a" })).connected, true,
      "same-principal scope expansion must preserve calendar grant");
    assert.deepEqual((await controller.calendarView({ profileId: "profile-a", ...RANGE })).events, []);
    state.graphMode = "evil-next";
    const beforeEmail = graphCount();
    const mail = await controller.readCollectionForPrincipal({ principalIdentity: oldPrincipal,
      packageId: "outlook-email", input, assertCurrent() {} });
    assert.equal(mail.items[0].subject, "Report");
    assert.equal(mail.truncated, true);
    assert.equal(JSON.stringify(mail).includes("PRIVATE"), false);
    assert.equal(graphCount(), beforeEmail + 1,
      "collection contract must never follow remote nextLink, including foreign origin");
    assert.equal(state.requests.some(request => request.url.startsWith("https://evil.example")), false);
    state.graphMode = "normal";
    const canceled = new AbortController();
    canceled.abort();
    const beforeCanceledRead = graphCount();
    await assert.rejects(controller.readCollectionForPrincipal({ principalIdentity: oldPrincipal,
      packageId: "outlook-email", input: {}, assertCurrent() {}, signal: canceled.signal }),
    { code: "OUTLOOK_CALENDAR_AUTH_REQUIRED" });
    assert.equal(graphCount(), beforeCanceledRead);

    const tickets = new Set(["mail-ticket"]);
    const mailClient = new MicrosoftGraphFamilyMcpClient({ broker: controller,
      packageId: "outlook-email", connectionId: "mail-connection",
      principalIdentity: oldPrincipal, assertCurrent() {},
      authorizeEgress({ connectionId, toolName, authority }) {
        assert.equal(connectionId, "mail-connection");
        assert.equal(toolName, TOOLS["outlook-email"].name);
        if (!tickets.delete(authority.ticketId)) {
          throw Object.assign(new Error("ticket consumed"), { code: "CAPABILITY_FORBIDDEN" });
        }
      } });
    assert.equal((await mailClient.listTools())[0].name, "outlook_email_list");
    const toolResult = await mailClient.callTool("outlook_email_list", {},
      { ticketId: "mail-ticket" });
    assert.deepEqual(toolResult.structuredContent.items.map(item => item.id), ["mail-1"]);
    const afterTool = graphCount();
    await assert.rejects(mailClient.callTool("outlook_email_list", {},
      { ticketId: "mail-ticket" }), { code: "CAPABILITY_FORBIDDEN" });
    await assert.rejects(mailClient.callTool("outlook_email_list", { body: true },
      { ticketId: "new-ticket" }), { code: "MICROSOFT_GRAPH_INPUT_INVALID" });
    assert.equal(graphCount(), afterTool, "reused or invalid tool calls must send no Graph request");
    await mailClient.release();

    const staleTeamsPlan = await controller.consentPlanForCapability("teams");
    for (const packageId of ["sharepoint", "teams"]) {
      const before = graphCount();
      await assert.rejects(controller.readCollectionForPrincipal({ principalIdentity: oldPrincipal,
        packageId, input: packageId === "sharepoint" ? { siteId: SITE_ID } : {},
        assertCurrent() {} }), { code: "OUTLOOK_CALENDAR_AUTH_REQUIRED" });
      assert.equal(graphCount(), before);
      if (packageId === "teams") {
        await assert.rejects(controller.connectForCapability({ profileId: "profile-a",
          packageId, expectedAccountRevision: staleTeamsPlan.accountRevision }),
        { code: "OUTLOOK_CALENDAR_AUTH_FAILED" });
      }
      const plan = await controller.consentPlanForCapability(packageId);
      assert.equal((await authorize(controller, state, { packageId,
        expectedAccountRevision: plan.accountRevision })).status, 200);
    }
    const lists = await controller.readCollectionForPrincipal({ principalIdentity: oldPrincipal,
      packageId: "sharepoint", input: { siteId: SITE_ID }, assertCurrent() {} });
    const fields = await controller.readCollectionForPrincipal({ principalIdentity: oldPrincipal,
      packageId: "sharepoint", input: FIELD_INPUT,
      toolName: SHAREPOINT_ITEM_FIELDS_TOOL, assertCurrent() {} });
    const chats = await controller.readCollectionForPrincipal({ principalIdentity: oldPrincipal,
      packageId: "teams", input: {}, assertCurrent() {} });
    assert.deepEqual(lists.items.map(item => item.name), ["Documents"]);
    assert.deepEqual(fields.fields, { Title: "Document A", Quantity: 7 });
    assert.deepEqual(chats.items.map(item => item.topic), ["Project"]);
    assert.equal(JSON.stringify({ lists, fields, chats }).includes("PRIVATE"), false);

    // A process restart must not make persisted scopes or a historic account
    // enough to execute a capability; the Store must explicitly reactivate a
    // current bound Connection before any read is possible.
    const restarted = makeController();
    try {
      const beforeRestart = graphCount();
      await assert.rejects(restarted.readCollectionForPrincipal({ principalIdentity: oldPrincipal,
        packageId: "teams", input: {}, assertCurrent() {} }),
      { code: "OUTLOOK_CALENDAR_AUTH_REQUIRED" });
      assert.equal(graphCount(), beforeRestart);
      await restarted.activatePluginAccount({ principalIdentity: oldPrincipal,
        packageId: "teams", assertCurrent() {} });
      assert.equal((await restarted.readCollectionForPrincipal({ principalIdentity: oldPrincipal,
        packageId: "teams", input: {}, assertCurrent() {} })).items.length, 1);
      restarted.deactivatePluginAccount({ principalIdentity: oldPrincipal });
      const beforeRevoke = graphCount();
      await assert.rejects(restarted.readCollectionForPrincipal({ principalIdentity: oldPrincipal,
        packageId: "teams", input: {}, assertCurrent() {} }),
      { code: "OUTLOOK_CALENDAR_AUTH_REQUIRED" });
      assert.equal(graphCount(), beforeRevoke);
    } finally { await restarted.close(); }

    // Refresh must request all consented scopes and bind the response to the
    // same /me account. A changed identity or missing scope cannot reach data.
    now += 3_590_000;
    state.omitScope = "Chat.ReadBasic";
    const beforeMissingRefreshScope = graphCount();
    await assert.rejects(controller.readCollectionForPrincipal({ principalIdentity: oldPrincipal,
      packageId: "teams", input: {}, assertCurrent() {} }),
    { code: "OUTLOOK_CALENDAR_AUTH_FAILED" });
    assert.equal(graphCount(), beforeMissingRefreshScope);
    state.omitScope = null;
    state.refreshAccount = "account-b";
    const beforeBadRefresh = graphCount();
    await assert.rejects(controller.readCollectionForPrincipal({ principalIdentity: oldPrincipal,
      packageId: "teams", input: {}, assertCurrent() {} }),
    { code: "OUTLOOK_CALENDAR_AUTH_FAILED" });
    assert.equal(graphCount(), beforeBadRefresh);
    state.refreshAccount = null;
    assert.equal((await controller.readCollectionForPrincipal({ principalIdentity: oldPrincipal,
      packageId: "teams", input: {}, assertCurrent() {} })).items.length, 1);

    // An actual account switch replaces the single credential and fences
    // prior Calendar and family principals, even if earlier grants remain.
    state.account = "account-b";
    let newPrincipal;
    assert.equal((await authorize(controller, state, { packageId: "teams",
      onReady({ principalHash }) { newPrincipal = `microsoft-graph:${principalHash}`; } })).status, 200);
    assert.notEqual(newPrincipal, oldPrincipal);
    assert.equal((await controller.status({ profileId: "profile-a" })).connected, false);
    const beforeSwitchRead = graphCount();
    await assert.rejects(controller.readCollectionForPrincipal({ principalIdentity: oldPrincipal,
      packageId: "outlook-email", input: {}, assertCurrent() {} }),
    { code: "OUTLOOK_CALENDAR_AUTH_REQUIRED" });
    assert.equal(graphCount(), beforeSwitchRead);
    assert.equal((await controller.readCollectionForPrincipal({ principalIdentity: newPrincipal,
      packageId: "teams", input: {}, assertCurrent() {} })).items.length, 1);

    await controller.grant({ profileId: "profile-a", client: "native" });
    await controller.disconnect({ profileId: "profile-a" });
    const beforeDisconnectRead = graphCount();
    await assert.rejects(controller.readCollectionForPrincipal({ principalIdentity: newPrincipal,
      packageId: "teams", input: {}, assertCurrent() {} }),
    { code: "OUTLOOK_CALENDAR_AUTH_REQUIRED" });
    assert.equal(graphCount(), beforeDisconnectRead);

    // A Mail-first account is valid without a Calendar scope. Its existence
    // must not make Calendar appear connected or allow a legacy host grant.
    assert.equal((await authorize(controller, state, { packageId: "outlook-email" })).status, 200);
    const mailFirst = await controller.status({ profileId: "profile-a" });
    assert.equal(mailFirst.accountConnected, true);
    assert.equal(mailFirst.connected, false);
    await assert.rejects(controller.grant({ profileId: "profile-a", client: "native" }),
      { code: "OUTLOOK_CALENDAR_AUTH_REQUIRED" });
    const mailPrincipal = `microsoft-graph:${JSON.parse(state.stored).principalHash}`;
    assert.equal((await controller.readCollectionForPrincipal({ principalIdentity: mailPrincipal,
      packageId: "outlook-email", input: {}, assertCurrent() {} })).items.length, 1);
    const beforeCalendarScope = graphCount();
    await assert.rejects(controller.calendarViewForPrincipal({ principalIdentity: mailPrincipal,
      ...RANGE, assertCurrent() {} }), { code: "OUTLOOK_CALENDAR_AUTH_REQUIRED" });
    assert.equal(graphCount(), beforeCalendarScope);
    console.log("plugin-microsoft-graph-family-unit: ok (per-card scope, bounded projection, account switch/restart/revoke fences)");
  } finally { await controller.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
