#!/usr/bin/env node
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"); const os = require("node:os"); const path = require("node:path");
const { ChatUiStore } = require("../app/agent-service/chat-ui-store");
const { resolveServicePaths } = require("../app/agent-service/paths");
const c = require("../app/agent-service/chat-ui-contract");
const owner = { profileId: "request-profile", transcriptSessionId: "transcript", sessionKey: "session" };
const request = (now = 1000) => ({ requestId: "request", kind: "secret", serverId: "server", registryName: null, url: null,
  title: "Configure connector", purpose: "Read the selected repository", status: "pending", requiredFields: [{ name: "TOKEN", label: "API token", kind: "env" }],
  createdAt: now, updatedAt: now, expiresAt: now + 86400000 });
test("connection request contract rejects credentials and invalid expiry", () => {
  assert.throws(() => c.normalizeConnectionRequest({ ...request(), fields: { env: { TOKEN: "secret-canary" } } }));
  assert.throws(() => c.normalizeConnectionRequest({ ...request(), expiresAt: 86401001 }));
  assert.throws(() => c.normalizeConnectionRequest({ ...request(), url: "https://example.test/mcp?token=secret-canary" }));
  assert.throws(() => c.normalizeConnectionRequest({ ...request(), requiredFields: [{ name: "TOKEN", label: "API token", kind: "env", value: "secret-canary" }] }));
});
test("request projection survives compact/restart; scope, expiry, terminal status are durable", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-request-ui-")); fs.chmodSync(root, 0o700);
  const paths = resolveServicePaths({ homeDir: root, stateRoot: path.join(root,"state"), cacheRoot: path.join(root,"cache"), profileRoot: path.join(root,"profile"), trustedRoot: root });
  let now = 1000, store;
  try {
    store = new ChatUiStore({ paths, now: () => now }); store.open();
    assert.deepEqual(store.upsertConnectionRequest(owner, request()), request());
    assert.deepEqual(store.upsertConnectionRequest(owner, request()), request());
    assert.equal(store.listConnectionRequests(owner).length, 1);
    assert.throws(() => store.upsertConnectionRequest(owner, { ...request(), purpose: "changed target" }), { code: "UI_STORAGE_CORRUPT" });
    assert.throws(() => store.listConnectionRequests({ ...owner, sessionKey: "foreign" }), { code: "UI_SCOPE_MISMATCH" });
    store.compact(owner); store.close(); store = new ChatUiStore({ paths, now: () => now }); store.open();
    assert.equal(store.getConnectionRequest(owner,"request").status,"pending");
    now = 86401000; assert.equal(store.getConnectionRequest(owner,"request").status,"expired");
    const done = { ...request(), status: "completed", updatedAt: now };
    store.upsertConnectionRequest(owner, done);
    assert.throws(() => store.upsertConnectionRequest(owner, { ...request(), updatedAt: now + 1 }), { code: "UI_STORAGE_CORRUPT" });
    store.compact(owner); store.close(); store = new ChatUiStore({ paths, now: () => now }); store.open();
    assert.equal(store.getConnectionRequest(owner,"request").status,"completed");
    const log = fs.readFileSync(path.join(paths.agentsDir,owner.profileId,"chat-ui",owner.transcriptSessionId,"journal.jsonl"),"utf8");
    assert.equal(log.includes("secret-canary"),false);
    assert.equal(store.connectionRequestPart(done).type,"connectionRequest");
  } finally { store?.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
test("historical OpenConnector card operations remain observable and are never replayed", async () => {
  const { ChatUiController } = require("../app/agent-service/chat-ui-controller");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-legacy-card-")); fs.chmodSync(root,0o700);
  const paths = resolveServicePaths({ homeDir:root,stateRoot:path.join(root,"state"),cacheRoot:path.join(root,"cache"),profileRoot:path.join(root,"profile"),trustedRoot:root });
  let store;
  try {
    store = new ChatUiStore({paths}); store.open();
    const declaration = {sourceFile:"ui.html",title:"Review",summary:"Continue",stateSchemaVersion:1,stateSchema:{type:"object",properties:{selected:{type:"string"}},required:["selected"],additionalProperties:false},initialState:{selected:"A"},actions:[{actionId:"continue",kind:"continue_agent",label:"Continue",instruction:"Proceed",stateFields:["selected"]}]};
    const pub = store.preparePublication({owner,callId:"publish",fingerprint:c.hash("publish"),tool:"render_ui",declaration,html:"<h1>Review</h1>",creatorRunId:"run",creatorAttemptId:"attempt",provenance:{}});
    const rev = store.markPublicationReady(owner,pub.publicationId,1), envelope = {operationId:"ui-operation-old",sessionKey:owner.sessionKey,prompt:"Old action",connectorSelection:["old-account"]};
    const operation = {actionRequestId:"old-action",operationId:envelope.operationId,artifactId:rev.artifactId,revision:rev.revision,sourceEventId:rev.sourceEventId,actionId:"continue",action:declaration.actions[0],baseStateRevision:0,snapshot:{selected:"A"},fingerprint:c.hash("old-action"),createdAt:Date.now(),sendEnvelope:envelope,sendFingerprint:c.hash(envelope),stateRevision:0,conversationEpoch:1,status:"prepared"};
    // Insert a journal fact in the historical format. The public prepare API
    // intentionally refuses this retired field for all new operations.
    store._append(store._owned(owner),"operation.prepare",operation);
    const controller = {store,deliveries:new Map(),coordinator:{getChatRunByOperation:()=>null,send:()=>assert.fail("retired operation must never resend")},operationResult:ChatUiController.prototype.operationResult};
    const result = await ChatUiController.prototype.deliver.call(controller,owner,operation);
    assert.equal(result.status,"unknown");assert.equal(result.errorCode,"UI_OPEN_CONNECTOR_RETIRED");
    store.close();store = new ChatUiStore({paths});store.open();
    assert.equal(store.getOperation(owner,{operationId:envelope.operationId}).status,"unknown");
    assert.deepEqual(store.getOperation(owner,{operationId:envelope.operationId}).sendEnvelope.connectorSelection,["old-account"]);
  } finally { store?.close(); fs.rmSync(root,{recursive:true,force:true}); }
});
