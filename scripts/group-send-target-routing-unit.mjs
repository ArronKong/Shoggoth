// Composer recipient resolution through the actual group protocol and SQLite routing.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(root, "app/manage-ui/package.json"));
const ts = require("typescript");
const { createFixture } = require(path.join(root, "scripts/fixtures/group-store-fixture.cjs"));
const { validateParams, MAX_USER_MESSAGE_BYTES } = require(path.join(root, "app/agent-service/group-chat-protocol.js"));
const source = fs.readFileSync(path.join(root, "app/manage-ui/src/pages/GroupChatSendTarget.tsx"), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: {
  jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} }).outputText;
const module = { exports: {} };
vm.runInNewContext(compiled, { module, exports: module.exports, require: name => {
  if (name === "react" || name.startsWith("react/")) return require(name);
  return {};
} });
const { composerPrefill, sendTargetMentions } = module.exports;

function send(fixture, target, body, quote = null, manual = false) {
  const view = fixture.view();
  const input = { groupId: fixture.groupId, clientMessageId: crypto.randomUUID(), body,
    mentions: [...sendTargetMentions(composerPrefill(target, view.currentOwnerId, quote, manual),
      view.members.filter(member => member.state === "active"), view.currentOwnerId)],
    replyTo: quote?.seq ?? null, attachments: [] };
  validateParams("group.send", input);
  return fixture.store.appendUserMessage({ ...input, mentionMemberIds: input.mentions, replyToSeq: input.replyTo });
}

test("a selected recipient receives fenced code and block quotes without parsing their example mentions", t => {
  const f = createFixture(t);
  const target = f.roster[1];
  const body = "```text\n@not-a-member\n```\n\n> @" + f.roster[2].handle + " quoted example";
  const result = send(f, { kind: "member", memberId: target.id }, body);
  assert.equal(result.message.body, body);
  assert.deepEqual(result.message.mentions.unresolved, []);
  assert.deepEqual(result.message.mentions.memberIds, [target.id]);
  assert.equal(f.store.claimNext(f.groupId, f.fence).member.id, target.id);
});

test("recipient selection accepts the entire UTF-8 message budget", t => {
  const f = createFixture(t);
  const body = "你".repeat(Math.floor(MAX_USER_MESSAGE_BYTES / 3)) + "ab";
  assert.equal(Buffer.byteLength(body), MAX_USER_MESSAGE_BYTES);
  const target = f.roster[2];
  const result = send(f, { kind: "member", memberId: target.id }, body);
  assert.equal(result.message.body, body);
  assert.equal(f.store.claimNext(f.groupId, f.fence).member.id, target.id);
});

test("choosing the owner after quoting another member keeps the quote and dispatches to the owner", t => {
  const f = createFixture(t), target = f.roster[1];
  f.send("A source reply", { mentionMemberIds: [target.id] });
  const claim = f.store.claimNext(f.groupId, f.fence);
  f.store.bindSession({ groupId: f.groupId, memberId: target.id, sessionKey: "quote-session", fence: f.fence });
  f.store.recordRun({ opportunityId: claim.opportunity.id, sessionKey: "quote-session", runId: "quote-run", fence: f.fence });
  f.store.completeTurn({ opportunityId: claim.opportunity.id, fence: f.fence, status: "completed", text: "Source" });
  const quote = f.messages().at(-1);
  const result = send(f, { kind: "owner" }, "Owner, please review this", quote, true);
  assert.equal(result.message.replyTo.seq, quote.seq);
  assert.equal(f.store.claimNext(f.groupId, f.fence).member.id, f.view().currentOwnerId);
});

test("all addresses the current roster with the owner first", t => {
  const f = createFixture(t), owner = f.roster[1];
  f.store.updateGroup({ groupId: f.groupId, expectedMetadataRevision: f.view().group.metadataRevision,
    patch: { ownerMemberId: owner.id } });
  const result = send(f, { kind: "all" }, "Each of you, please respond");
  assert.deepEqual(result.message.mentions.memberIds, [owner.id, f.roster[0].id, f.roster[2].id]);
  const claim = f.store.claimNext(f.groupId, f.fence);
  assert.equal(claim.member.id, owner.id);
  assert.deepEqual(claim.order.map(slot => slot.memberId), [owner.id, f.roster[0].id, f.roster[2].id]);
});

test("quoting retains the existing explicit mention override", t => {
  const f = createFixture(t), quoted = f.roster[1], explicit = f.roster[2];
  f.send("Source", { mentionMemberIds: [quoted.id] });
  const claim = f.store.claimNext(f.groupId, f.fence);
  f.store.bindSession({ groupId: f.groupId, memberId: quoted.id, sessionKey: "quoted-session", fence: f.fence });
  f.store.recordRun({ opportunityId: claim.opportunity.id, sessionKey: "quoted-session", runId: "quoted-run", fence: f.fence });
  f.store.completeTurn({ opportunityId: claim.opportunity.id, fence: f.fence, status: "completed", text: "Quoted source" });
  const quote = f.messages().at(-1);
  const result = send(f, { kind: "member", memberId: quoted.id }, `@${explicit.handle} review this`, quote);
  assert.equal(result.message.replyTo.seq, quote.seq);
  assert.deepEqual(result.message.mentions.memberIds, [explicit.id]);
  assert.equal(f.store.claimNext(f.groupId, f.fence).member.id, explicit.id);
});

test("the default owner uses ordinary group routing", t => {
  const f = createFixture(t);
  const result = send(f, { kind: "owner" }, "Hello");
  assert.deepEqual(result.message.mentions.memberIds, []);
  assert.equal(f.store.claimNext(f.groupId, f.fence).member.id, f.view().currentOwnerId);
});

test("a manual @all reaches the owner and the rest of the roster in order", t => {
  const f = createFixture(t), owner = f.roster[1];
  f.store.updateGroup({ groupId: f.groupId, expectedMetadataRevision: f.view().group.metadataRevision,
    patch: { ownerMemberId: owner.id } });
  const result = send(f, { kind: "owner" }, "@all Please review");
  assert.equal(result.message.mentions.broadcast, true);
  assert.deepEqual(f.store.claimNext(f.groupId, f.fence).order.map(slot => slot.memberId), [owner.id, f.roster[0].id, f.roster[2].id]);
});
