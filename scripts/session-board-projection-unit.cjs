"use strict";

const assert = require("node:assert/strict");
const { AgentBackend } = require("../app/core/agent-backend");
const {
  SESSION_BOARD_METHOD_NAMES,
  CANVAS_DOCUMENT_CAPABILITY,
  BOARD_MAX_OPS,
  sessionBoardMethodMap,
  sessionBoardCapabilityMap,
  projectSessionBoardEnvelope,
  normalizeSessionBoardAgentId,
  normalizeSessionBoardSessionKey,
  normalizeSessionBoardOps,
  normalizeSessionBoardCanvasSpec,
  normalizeSessionBoardGrantSpec,
} = require("../app/core/session-board-projection");

async function main() {
const methods = sessionBoardMethodMap(Object.fromEntries(
  SESSION_BOARD_METHOD_NAMES.map((name) => [name, true]),
));
const capabilities = sessionBoardCapabilityMap({ [CANVAS_DOCUMENT_CAPABILITY]: true });

assert.deepEqual(Object.keys(methods), SESSION_BOARD_METHOD_NAMES);
assert.deepEqual(capabilities, { [CANVAS_DOCUMENT_CAPABILITY]: true });
assert.equal(normalizeSessionBoardAgentId("main"), "main");
assert.equal(normalizeSessionBoardAgentId("main/other"), null);
assert.equal(normalizeSessionBoardAgentId("main\t"), null);
assert.equal(normalizeSessionBoardSessionKey("agent:main:branch/one"), "agent:main:branch/one");
assert.equal(normalizeSessionBoardSessionKey("agent:main:branch\tbad"), null);
assert.deepEqual(await new AgentBackend().getSessionBoard("main", "agent:main:main"), {
  supported: false,
  reason: "unsupported",
  methods: sessionBoardMethodMap(),
  capabilities: sessionBoardCapabilityMap(),
  snapshot: null,
});

const projected = projectSessionBoardEnvelope({
  supported: true,
  methods,
  capabilities,
  snapshot: {
    sessionKey: "agent:main:main",
    revision: 9,
    tabs: [{ tabId: "main", title: "Main\nBoard", position: Number.MAX_SAFE_INTEGER, chatDock: "right", leak: "tab-secret" }],
    widgets: [
      {
        name: "registered-widget",
        tabId: "main",
        title: "Registered",
        contentKind: "plugin",
        contentOwner: "registered",
        registeredContentKind: "secret-kind",
        pluginKind: "secret:widget",
        props: { token: "props-secret" },
        presentation: "card",
        heightMode: "fixed",
        sizeW: 6,
        sizeH: 4,
        position: 0,
        grantState: "pending",
        revision: 3,
        instanceId: "instance-3",
        declared: {
          netOrigins: ["https://api.example", "https://files.example"],
          tools: ["prompt", "cron.trigger:job-1"],
        },
        declaredSummary: ["secret-summary"],
        frameUrl: "https://secret.example/frame",
        viewTicket: "secret-ticket",
        viewTicketTtlMs: 60_000,
        viewGeneration: "0123456789abcdef0123456789abcdef",
        sandboxUrl: "/secret-sandbox",
        sandboxPort: 1234,
        sandboxOrigin: "https://secret.example",
        unknown: "unknown-secret",
      },
      {
        name: "future-widget",
        tabId: "main",
        contentKind: "future-payload",
        payload: { token: "future-secret" },
        sizeW: 1,
        sizeH: 1,
        position: 1,
        grantState: "none",
        revision: 1,
      },
    ],
  },
  resolvedWidgetName: "registered-widget",
});
assert.equal(projected.supported, true);
assert.equal(projected.snapshot.tabs[0].position, Number.MAX_SAFE_INTEGER);
assert.deepEqual(projected.snapshot.widgets[0], {
  name: "registered-widget",
  tabId: "main",
  title: "Registered",
  content: { kind: "registered", supported: false },
  presentation: "card",
  heightMode: "fixed",
  sizeW: 6,
  sizeH: 4,
  position: 0,
  grantState: "pending",
  revision: 3,
  instanceId: "instance-3",
  accessSummary: {
    networkOrigins: ["https://api.example", "https://files.example"],
    tools: ["cron.trigger:job-1", "prompt"],
  },
});
assert.equal(projected.snapshot.tabs[0].title, "Main Board");
assert.deepEqual(projected.snapshot.widgets[1].content, { kind: "unknown", supported: false });
assert.equal(projected.resolvedWidgetName, "registered-widget");
for (const secret of [
  "tab-secret", "secret-kind", "secret:widget", "props-secret", "secret-summary",
  "secret-ticket", "secret-sandbox", "unknown-secret", "future-secret",
]) {
  assert.equal(JSON.stringify(projected).includes(secret), false, secret);
}

const wrongSession = projectSessionBoardEnvelope({
  supported: true,
  methods,
  capabilities,
  snapshot: {
    sessionKey: "agent:other:main",
    revision: 1,
    tabs: [],
    widgets: [],
  },
}, "agent:main:main");
assert.equal(wrongSession.supported, false);
assert.equal(wrongSession.reason, "invalid-response");

const missingResolvedWidget = projectSessionBoardEnvelope({
  supported: true,
  methods,
  capabilities,
  snapshot: {
    sessionKey: "agent:main:main",
    revision: 1,
    tabs: [],
    widgets: [],
  },
  resolvedWidgetName: "missing-widget",
}, "agent:main:main");
assert.equal(missingResolvedWidget.supported, false);
assert.equal(missingResolvedWidget.reason, "invalid-response");

const invalidSnapshot = projectSessionBoardEnvelope({
  supported: true,
  methods,
  capabilities,
  snapshot: {
    sessionKey: "agent:main:main",
    revision: 1,
    tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" }],
    widgets: [{
      name: "orphan", tabId: "missing", contentKind: "html", sizeW: 1, sizeH: 1,
      position: 0, grantState: "none", revision: 1,
    }],
  },
});
assert.equal(invalidSnapshot.supported, false);
assert.equal(invalidSnapshot.reason, "invalid-response");
assert.equal(invalidSnapshot.snapshot, null);

const invalidAccess = projectSessionBoardEnvelope({
  supported: true,
  methods,
  capabilities,
  snapshot: {
    sessionKey: "agent:main:main",
    revision: 1,
    tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" }],
    widgets: [{
      name: "unsafe", tabId: "main", contentKind: "html", sizeW: 1, sizeH: 1,
      position: 0, grantState: "pending", revision: 1, instanceId: "instance-1",
      declared: { netOrigins: ["http://not-https.example"], tools: ["prompt"] },
    }],
  },
});
assert.equal(invalidAccess.supported, false);
assert.equal(invalidAccess.reason, "invalid-response");

const allOps = [
  { kind: "tab_create", tabId: "review", title: "Review", chatDock: "bottom" },
  { kind: "tab_update", tabId: "review", title: "Updated", position: Number.MAX_SAFE_INTEGER },
  { kind: "tab_delete", tabId: "review" },
  { kind: "tabs_reorder", tabIds: ["main", "review"] },
  { kind: "widget_move", name: "widget-1", tabId: "main", after: "widget-0" },
  { kind: "widget_resize", name: "widget-1", sizeW: 12, sizeH: 20, heightMode: "auto" },
  { kind: "widget_remove", name: "widget-1" },
];
assert.deepEqual(normalizeSessionBoardOps(allOps), allOps);
for (const invalid of [
  [],
  [{ kind: "unknown" }],
  [{ kind: "tab_create", tabId: "main", title: "Main", extra: true }],
  [{ kind: "tab_update", tabId: "main" }],
  [{ kind: "widget_move", name: "widget", position: 0, after: "anchor" }],
  [{ kind: "widget_resize", name: "widget", sizeW: 13, sizeH: 1 }],
  [{ kind: "tabs_reorder", tabIds: ["main", "main"] }],
  Array.from({ length: BOARD_MAX_OPS + 1 }, () => ({ kind: "widget_remove", name: "widget" })),
]) {
  assert.equal(normalizeSessionBoardOps(invalid), null);
}

assert.deepEqual(normalizeSessionBoardCanvasSpec({
  name: "canvas-widget",
  docId: "cv_0123456789abcdef",
  title: "Canvas",
  placement: { tabId: "main", size: "lg", after: "widget-0" },
}), {
  name: "canvas-widget",
  docId: "cv_0123456789abcdef",
  title: "Canvas",
  placement: { tabId: "main", size: "lg", after: "widget-0" },
});
for (const invalid of [
  { name: "canvas", docId: "../secret" },
  { name: "canvas", docId: " cv_1" },
  { name: "canvas", docId: "cv_1", html: "<script>secret</script>" },
  { name: "canvas", docId: "cv_1", placement: {} },
  { name: "canvas", docId: "cv_1", placement: { size: "huge" } },
]) {
  assert.equal(normalizeSessionBoardCanvasSpec(invalid), null);
}

assert.deepEqual(normalizeSessionBoardGrantSpec({
  name: "registered-widget",
  revision: 3,
  instanceId: "instance-3",
  decision: "rejected",
}), {
  name: "registered-widget",
  revision: 3,
  instanceId: "instance-3",
  decision: "rejected",
});
assert.equal(normalizeSessionBoardGrantSpec({
  name: "registered-widget", revision: 0, instanceId: "instance-3", decision: "granted",
}), null);
assert.equal(normalizeSessionBoardGrantSpec({
  name: "registered-widget", revision: 3, instanceId: "instance-3", decision: "allow-once",
}), null);

  console.log("session board projection: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
