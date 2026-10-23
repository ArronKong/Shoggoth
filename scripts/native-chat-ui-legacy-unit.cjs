#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict"), crypto = require("node:crypto"), fs = require("node:fs"), path = require("node:path");
const { test } = require("node:test");
const { fixture, declaration } = require("./native-chat-ui-service-unit.cjs");
const { legacyHtmlBlocks } = require("../app/manage-ui/src/lib/chatUiLegacy.mjs");
const tick = "`".repeat(3), page = "<!doctype html><style>body{color:red}</style><button onclick=\"sendPrompt('历史待提交内容')\">选择</button>";
test("legacy lexer preserves code and quoted examples and only offers closed runnable HTML", () => {
  assert.deepEqual(legacyHtmlBlocks(`> ${tick}html\n> ${page}\n> ${tick}\n`), []);
  assert.deepEqual(legacyHtmlBlocks(`    ${tick}html\n    ${page}\n    ${tick}`), []);
  assert.deepEqual(legacyHtmlBlocks(`${tick}text\n${tick}html\n${page}\n${tick}\n${tick}`), []);
  assert.deepEqual(legacyHtmlBlocks(`${tick}html\n${page}`), []);
  const blocks = legacyHtmlBlocks(`${tick}html\n<button>教学片段</button>\n${tick}\n~~~html\n${page}\n~~~`);
  assert.equal(blocks.length, 2); assert.equal(blocks[0].runnable, false); assert.equal(blocks[1].runnable, true); assert.equal(blocks[1].blockIndex, 1);
});
test("actual Service imports complete canonical legacy source once and does not add a message or Run", async () => {
  const f = await fixture(); try {
    const session = f.service.chatSessionStore.getSession(f.owner.sessionKey), sourceId = crypto.randomUUID();
    const text = "长正文".repeat(30000) + `\n${tick}html\n<button>教学片段</button>\n${tick}\n${tick}html\n${page}\n${tick}`;
    f.service.transcriptStore.appendEvent({ profileId: f.owner.profileId, sessionId: session.id, id: sourceId, runId: f.runId,
      kind: "assistant", content: { text, transcriptType: "text" }, runtimeRef: null, contextExcluded: false, occurredAt: Date.now() });
    const events = f.service.transcriptStore.listEvents(f.owner.profileId, session.id).length, runs = f.service.productStore.listWorkRuns().length;
    const spec = { ...f.owner, sourceEventId: sourceId, blockIndex: 1 }, first = await f.ipc("chat.ui.import", spec);
    assert.equal(first.part.sourceEventId, sourceId); assert.deepEqual(await f.ipc("chat.ui.import", spec), first);
    assert.equal(f.service.transcriptStore.listEvents(f.owner.profileId, session.id).length, events);
    assert.equal(f.service.productStore.listWorkRuns().length, runs);
    const desc = await f.ipc("chat.ui.describe", f.reference(first.part)); assert.equal(desc.legacy, true); assert.deepEqual(desc.actions, []);
    const open = await f.ipc("chat.ui.open", { ...f.reference(first.part), mountId: "legacy" });
    const source = await f.ipc("chat.ui.read", { ...f.owner, leaseId: open.leaseId, offset: 0 });
    assert.equal(Buffer.from(source.data, "base64").toString(), page);
    await assert.rejects(f.ipc("chat.ui.import", { ...spec, html: page }), { code: "UI_REQUEST_INVALID" });
    await assert.rejects(f.ipc("chat.ui.import", { ...spec, blockIndex: 0 }), { code: "UI_SOURCE_EXPIRED" });
    await f.close(); await f.open(); assert.equal((await f.ipc("chat.ui.describe", f.reference(first.part))).legacy, true);
    f.service.transcriptStore.setContextExcluded({ profileId: f.owner.profileId, sessionId: session.id, eventId: sourceId, contextExcluded: true });
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(f.ipc("chat.ui.describe", f.reference(first.part)), { code: "UI_SOURCE_EXPIRED" });
    assert.equal(f.service.chatUiStore.publicationsForRecovery()[0].status, "revoked");
    assert.equal(fs.existsSync(path.join(f.paths.agentsDir, f.owner.profileId, "chat-ui", "objects", source.htmlHash + ".html")), false);
  } finally { await f.remove(); }
});
test("user, error, incomplete and wrong-owner legacy sources cannot get execution authority", async () => {
  const f = await fixture(); try { const session = f.service.chatSessionStore.getSession(f.owner.sessionKey);
    for (const [kind, content] of [["user", { text: `${tick}html\n${page}\n${tick}`, transcriptType: "text" }],
      ["assistant", { text: `${tick}html\n${page}`, transcriptType: "text" }],
      ["assistant", { text: `${tick}html\n${page}\n${tick}`, transcriptType: "text", contextComplete: false }],
      ["assistant", { text: `${tick}html\n${page}\n${tick}`, transcriptType: "error" }]]) {
      const id = crypto.randomUUID(); f.service.transcriptStore.appendEvent({ profileId: f.owner.profileId, sessionId: session.id,
        id, runId: f.runId, kind, content, runtimeRef: null, contextExcluded: false, occurredAt: Date.now() });
      await assert.rejects(f.ipc("chat.ui.import", { ...f.owner, sourceEventId: id, blockIndex: 0 }), { code: "UI_SOURCE_EXPIRED" });
    }
    assert.equal(f.service.chatUiStore.publicationsForRecovery().length, 0);
  } finally { await f.remove(); }
});
test("session archive changes one epoch, Runtime settings preserve confirmed state, and feature off retains cards", async () => {
  const f = await fixture(); try {
    const part = (await f.call("render_ui", declaration())).part, session = f.service.chatSessionStore.getSession(f.owner.sessionKey);
    const own = { ...f.owner, transcriptSessionId: session.id }, opened = await f.ipc("chat.ui.open", { ...f.reference(part), mountId: "life" });
    await f.ipc("chat.ui.state.save", { ...f.owner, leaseId: opened.leaseId, baseStateRevision: 0, patch: { selected: "B" } });
    const epoch = f.service.chatUiStore.revision(own, part.artifactId, 1).currentEpoch;
    f.service.chatUiController.reconcileSources(); assert.equal(f.service.chatUiStore.revision(own, part.artifactId, 1).currentEpoch, epoch);
    f.service.chatSessionStore.requestArchive(f.owner.sessionKey, "actual-session-archive", Date.now());
    await new Promise(resolve => setImmediate(resolve)); f.service.chatUiController.invalidateSession(own);
    assert.equal(f.service.chatUiStore.revision(own, part.artifactId, 1).currentEpoch, epoch + 1);
    assert.equal((await f.ipc("chat.ui.describe", f.reference(part))).readOnly, true);
    await f.ipc("chat.ui.config.apply", { revision: 2, config: { nativeChatUiV1: false } });
    assert.equal(f.service.chatUiStore.revision(own, part.artifactId, 1).state.selected, "B");
  } finally { await f.remove(); }
});
