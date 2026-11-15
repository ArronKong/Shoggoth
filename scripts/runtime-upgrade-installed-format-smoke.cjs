#!/usr/bin/env node
"use strict";

// Exercise the released stores on synthetic data, then reopen with the current
// compatible readers. No App/Service launch, production paths or Keychain.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { audit, compare } = require("./runtime-upgrade-audit.cjs");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { JsonlProductStore, DEFAULT_AGENT_PROFILE_ID } = require("../app/agent-service/product-store");
const { ChatSessionStore } = require("../app/agent-service/chat-session-store");
const { PendingCommandInbox } = require("../app/agent-service/pending-command-inbox");
const { TranscriptStore } = require("../app/agent-service/transcript-store");
const { NativeCronStore } = require("../app/agent-service/native-cron-store");
const { SERVICE_PROTOCOL_VERSION } = require("../app/agent-service/service-protocol-version");

// Verified against the 0.8.318 and 0.8.319 release-source trees and the
// installed official 0.8.319 ASAR. These releases share the same store writers.
const FORMAT_MODULES = Object.freeze({
  "service-protocol-version.js": "87446e70e6ef1cc0ef9b12bfbcd4e7b330b3e69b9c337f832587df5119efd5d5",
  "product-schema-version.js": "43fbe2856ba92c8ebc6d8e10bd2b33424f19388515b42d32a1f8262281695000",
  "product-store.js": "f7c4c9a8cdafc23ea96e41d897961647102bbb9dd4c620afb9417bf23e7dd98a",
  "chat-session-store.js": "6559841d97c302f0064b1c1ad1f7c4e5a41b2439230d0ddd4642bf5e8d1781c7",
  "pending-command-inbox.js": "3b9a78693caf32f972b48aad30688a74a1057ae01b123638f89139ae84598426",
  "native-cron-store.js": "21a6885765b8b5bddd3f6f9e61300a7f88a3fe06d73d9c120b9373627d6bd0bf",
  "run-execution-store.js": "54beffb8ee33091d7e0c0c9e8d63c25c2fd76de60934a5879726bf717c96eb79",
  "transcript-store.js": "8d9f53bce54447129e5d6c83cb101684db05d319562914d540d7ba4562013635",
});
const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

function releasedWriters(source) {
  assert.ok(path.isAbsolute(source) && fs.statSync(source).isDirectory(), "Pass an absolute released source directory");
  const releaseSource = fs.realpathSync(source);
  const version = JSON.parse(fs.readFileSync(path.join(releaseSource, "package.json"), "utf8")).version;
  assert.ok(["0.8.318", "0.8.319"].includes(version), "Expected a reviewed 0.8.318 or 0.8.319 source tree");
  const base = path.join(releaseSource, "app", "agent-service");
  for (const [name, digest] of Object.entries(FORMAT_MODULES)) {
    assert.equal(sha256(fs.readFileSync(path.join(base, name))), digest, `Released module hash differs: ${name}`);
  }
  return {
    version,
    Product: require(path.join(base, "product-store")).JsonlProductStore,
    Sessions: require(path.join(base, "chat-session-store")).ChatSessionStore,
    Inbox: require(path.join(base, "pending-command-inbox")).PendingCommandInbox,
    Transcript: require(path.join(base, "transcript-store")).TranscriptStore,
    Cron: require(path.join(base, "native-cron-store")).NativeCronStore,
  };
}

async function smoke(source) {
  const released = releasedWriters(source);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sg-upgrade-format-")));
  const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state"),
    userDataRoot: root, cacheRoot: path.join(root, "cache") });
  const clock = Date.now(), key = crypto.randomBytes(32);
  const cryptoBroker = {
    async encrypt(plaintext) {
      const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      return Buffer.concat([iv, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
    },
    async decrypt(envelope) {
      const cipher = crypto.createDecipheriv("aes-256-gcm", key, envelope.subarray(0, 12));
      cipher.setAuthTag(envelope.subarray(-16));
      return Buffer.concat([cipher.update(envelope.subarray(12, -16)), cipher.final()]);
    },
  };
  const options = { paths, now: () => clock, cryptoBroker };
  const profileId = DEFAULT_AGENT_PROFILE_ID;
  const inboxPath = path.join(paths.stateDir, "pending-commands.json");
  const oldProduct = new released.Product(options).open();
  let session, original, oldJob;
  const cronInput = { operationId: "released-cron", name: "Synthetic Cron", enabled: false, profileId,
    workspace: null, prompt: "Synthetic scheduled input",
    schedule: { kind: "at", at: clock + 60_000 }, misfirePolicy: "skip", maxCatchUp: 1,
    overlapPolicy: "skip", threadPolicy: "new", threadId: null, nextRunAt: null, createdAt: clock };
  try {
    const profile = oldProduct.getAgentProfile(profileId);
    assert.ok(profile?.defaultBindingId);
    const sessions = new released.Sessions({ ...options,
      getProfileBinding: (id, bindingId) => oldProduct.getAgentRuntimeBinding(id, bindingId) });
    const transcript = new released.Transcript(options);
    const inbox = new released.Inbox(options);
    const cron = new released.Cron({ ...options, profileExists: id => !!oldProduct.getAgentProfile(id) });
    try {
      sessions.open();
      transcript.open();
      cron.open();
      await inbox.open();
      session = sessions.createSession({ operationId: "released-chat", profileId, workspace: null,
        defaultBindingId: profile.defaultBindingId, createdAt: clock });
      original = { operationId: "released-input", runId: "released-run", sessionKey: session.sessionKey,
        prompt: "Synthetic text only", createdAt: clock };
      await inbox.enqueue(original);
      oldJob = cron.createJob(cronInput);
      transcript.appendEvent({ profileId, sessionId: session.id, id: "released-user-event",
        runId: original.runId, kind: "user", content: { text: original.prompt, operationId: original.operationId } });
    } finally {
      await inbox.close();
      cron.close();
      transcript.close();
      sessions.close();
    }
  } finally { oldProduct.close(); }
  const before = audit(paths);
  assert.equal(before.quiescent, true);
  assert.equal(before.product.schemaVersion, 17);
  assert.equal(before.pendingCommands.version, 1);

  const currentProduct = new JsonlProductStore(options).open();
  const currentSessions = new ChatSessionStore({ ...options,
    getProfileBinding: (id, bindingId) => currentProduct.getAgentRuntimeBinding(id, bindingId) });
  const currentTranscript = new TranscriptStore(options);
  const currentCron = new NativeCronStore({ ...options, profileExists: id => !!currentProduct.getAgentProfile(id) });
  const currentInbox = new PendingCommandInbox({ ...options, workerWrites: true });
  const accepted = { ...original, operationId: "candidate-input", runId: "candidate-run", prompt: "Another synthetic message",
    acceptance: { profileId, sessionId: session.id, workspace: null, selectionFingerprint: sha256("fixture-selection") } };
  let watchedJob;
  try {
    currentSessions.open();
    currentTranscript.open();
    currentCron.open();
    await currentInbox.open();
    assert.deepEqual(currentSessions.getSession(session.sessionKey), session);
    assert.deepEqual(currentInbox.get(original.operationId), { ...original, state: "pending" });
    assert.equal(currentTranscript.getEvent(profileId, session.id, "released-user-event").content.text, original.prompt);
    assert.deepEqual(currentCron.getJob(oldJob.id), oldJob);
    await currentInbox.enqueue(accepted, { groupCommit: true });
    watchedJob = currentCron.createJob({ ...cronInput, operationId: "candidate-cron", watch: true });
  } finally {
    await currentInbox.close();
    currentCron.close();
    currentTranscript.close();
    currentSessions.close();
    currentProduct.close();
  }
  const after = audit(paths, { baseline: before }), upgraded = compare(before, after);
  assert.equal(after.pendingCommands.version, 2);
  assert.equal(upgraded.comparable, true);
  assert.equal(upgraded.originalRecordsPreserved, true);
  assert.deepEqual(upgraded.privateFileChanges, ["pending-commands.json", "native-cron.json"]);
  assert.equal(JSON.stringify(after).includes(accepted.prompt), false);

  // The compatible rollback reader disables the writer worker but still
  // understands the v2 file. An actual legacy v1 executable cannot downgrade it.
  const compatible = new PendingCommandInbox({ ...options, workerWrites: false });
  try {
    await compatible.open();
    assert.equal(compatible.fileWriter, null);
    assert.deepEqual(compatible.get(original.operationId), { ...original, state: "pending" });
    assert.deepEqual(compatible.get(accepted.operationId), { ...accepted, state: "pending" });
  } finally { await compatible.close(); }
  const frozenHash = sha256(fs.readFileSync(inboxPath));
  const legacy = new released.Inbox(options);
  await assert.rejects(legacy.open(), { code: "PENDING_COMMAND_INBOX_CORRUPT" });
  assert.equal(sha256(fs.readFileSync(inboxPath)), frozenHash);
  const cronPath = path.join(paths.stateDir, "native-cron.json");
  const cronHash = sha256(fs.readFileSync(cronPath));
  const legacyCron = new released.Cron({ ...options, profileExists: id => id === profileId });
  assert.throws(() => legacyCron.open(), { code: "CRON_STORE_CORRUPT" });
  assert.equal(sha256(fs.readFileSync(cronPath)), cronHash);
  const compatibleCron = new NativeCronStore({ ...options, profileExists: id => id === profileId });
  try {
    compatibleCron.open();
    assert.deepEqual(compatibleCron.getJob(oldJob.id), oldJob);
    assert.deepEqual(compatibleCron.getJob(watchedJob.id), watchedJob);
  } finally { compatibleCron.close(); }
  assert.equal(compare(after, audit(paths)).matches, true);
  key.fill(0);
  return { releasedVersion: released.version, releasedProtocol: 32, candidateProtocol: SERVICE_PROTOCOL_VERSION,
    productSchema: before.product.schemaVersion, chatSchema: before.chat.version,
    inboxVersionBefore: before.pendingCommands.version, inboxVersionAfter: after.pendingCommands.version,
    originalRecordsPreserved: true, compatibleReaderPreservedBothOperations: true,
    releasedReaderRefusedV2WithoutWriting: true, oldAndNewCronJobsPreserved: true,
    releasedCronReaderRefusedWatchWithoutWriting: true, fixtureRoot: root };
}

if (require.main === module) (async () => {
  const sources = process.argv.slice(2);
  assert.ok(sources.length, "Usage: runtime-upgrade-installed-format-smoke.cjs /absolute/released/source […]");
  for (const source of sources) console.log(JSON.stringify(await smoke(source)));
})().catch(error => { console.error(error); process.exitCode = 1; });

module.exports = { smoke };
