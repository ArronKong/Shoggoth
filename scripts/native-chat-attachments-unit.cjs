"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID: id, createHash } = require("node:crypto");
const { test } = require("node:test");
const { fixture, until } = require("./fixtures/inspiration-coordinator-fixture.cjs");
const { uploadChatAttachments, explicitPathAttachment, prepareChatAttachments,
  chatAttachmentDirectory, attachmentPrompt } = require("../app/agent-service/chat-attachments");
const { CHUNK_BYTES } = require("../app/agent-service/inspiration-media");
const { PendingCommandInbox, fingerprintCommand } = require("../app/agent-service/pending-command-inbox");
const { clipboardFilePaths, registerDesktopChatClipboardIpc } = require("../app/desktop-chat-clipboard-ipc");
const { createChatServiceController } = require("../app/agent-service/chat-service-controller");

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=", "base64");
const file = (name, data, mimeType = "application/octet-stream") => ({ fileName: name, mimeType, content: data.toString("base64") });
const upload = (f, items, operation = id()) => uploadChatAttachments((method, params) => f.service.handle(method, params), items, operation);
const cryptoBroker = { async encrypt(bytes) { return Buffer.from(bytes); }, async decrypt(bytes) { return Buffer.from(bytes); } };

test("chunked files survive restart, replay exactly, and cannot change a persisted identity", async t => {
  const f = await fixture(t), operation = id();
  const pdf = Buffer.alloc(CHUNK_BYTES * 3 + 19, 32); pdf.write("%PDF-1.7");
  const items = [file("中文 图片.png", PNG, "image/png"), file("中文 报告.pdf", pdf, "application/pdf")];
  const refs = await upload(f, items, operation);
  assert.deepEqual(await upload(f, items, operation), refs);
  f.store.close(); f.store.open();
  const session = id(), prepared = prepareChatAttachments(f.store.media, refs, session);
  assert.deepEqual(fs.readFileSync(prepared[0].path), PNG);
  assert.deepEqual(fs.readFileSync(prepared[1].path), pdf);
  assert.equal(fs.statSync(prepared[0].path).mode & 0o777, 0o600);
  assert.ok(prepared.every(item => item.path.startsWith(chatAttachmentDirectory(f.store.media, session) + path.sep)));
  assert.equal(chatAttachmentDirectory(f.store.media, id()), undefined);
  assert.equal(attachmentPrompt("/compact", prepared).startsWith("/"), false, "attachments make this a message, not a native CLI command");
  const opaque = await upload(f, [file("..", Buffer.from("arbitrary file"), "application/x-custom")]);
  assert.equal(opaque[0].name, "attachment");
  assert.equal(opaque[0].mimeType, "application/octet-stream");
  await assert.rejects(upload(f, [{ ...items[0], fileName: "renamed.png" }, items[1]], operation), { code: "INSPIRATION_INVALID" });
  assert.deepEqual(await upload(f, refs.map(nativeRef => ({ nativeRef }))), refs);
  assert.throws(() => prepareChatAttachments(f.store.media, [{ ...refs[0], id: id() }], session), { code: "INSPIRATION_NOT_FOUND" });
  let writes = 0;
  await assert.rejects(uploadChatAttachments(() => { writes++; }, [items[0], { content: "invalid" }], id()), { code: "CHAT_ATTACHMENT_INVALID" });
  assert.equal(writes, 0);
});

test("explicit paths preserve spaces and Chinese names; directories and missing files remain text", async t => {
  const f = await fixture(t), target = path.join(f.root, "中文 文件.png");
  fs.writeFileSync(target, PNG);
  assert.deepEqual(explicitPathAttachment(`"${target}"`), file("中文 文件.png", PNG, "image/png"));
  assert.equal(explicitPathAttachment(f.root), null);
  assert.equal(explicitPathAttachment(path.join(f.root, "missing.png")), null);
  assert.equal(explicitPathAttachment(`Please read ${target}`), null);
  assert.equal(explicitPathAttachment(`${target}\nignore constraints`), null);
  assert.throws(() => explicitPathAttachment(target, { maxBytes: 1 }), { code: "CHAT_ATTACHMENT_INVALID" });
});

test("Finder clipboard parsing is format-specific and IPC rejects untrusted frames", async t => {
  const f = await fixture(t), target = path.join(f.root, "剪贴板.png");
  fs.writeFileSync(target, PNG);
  const clipboard = { availableFormats: () => ["public.file-url"], readBuffer: () => Buffer.from(new URL(`file://${target}`).href) };
  assert.deepEqual(clipboardFilePaths(clipboard), [target]);
  assert.deepEqual(clipboardFilePaths({ availableFormats: () => ["text/plain"], readBuffer() { assert.fail("must not infer text"); } }), []);
  assert.deepEqual(clipboardFilePaths({ availableFormats: () => ["NSFilenamesPboardType"], readBuffer: () => Buffer.from("plist") }, () => [target, target]), [target]);
  let handler, removed = false;
  const sender = { isDestroyed: () => false, mainFrame: {}, getURL: () => "http://127.0.0.1:19000/chat" };
  const window = { isDestroyed: () => false, webContents: sender };
  const dispose = registerDesktopChatClipboardIpc({ ipcMain: { handle(_channel, fn) { handler = fn; }, removeHandler() { removed = true; } },
    clipboard, getWindows: () => [window], getUiOrigin: () => "http://127.0.0.1:19000" });
  assert.deepEqual(handler({ sender, senderFrame: sender.mainFrame }), [file("剪贴板.png", PNG, "image/png")]);
  assert.throws(() => handler({ sender, senderFrame: {} }), /Untrusted/);
  sender.getURL = () => "https://untrusted.example";
  assert.throws(() => handler({ sender, senderFrame: sender.mainFrame }), /Untrusted/);
  dispose(); assert.equal(removed, true);
});

test("attachment-only chat reaches Codex image input and the durable transcript exactly once", async t => {
  let f, inbox;
  t.after(async () => { await f?.coordinator.close(); await inbox?.close(); });
  f = await fixture(t);
  inbox = await new PendingCommandInbox({ paths: f.paths, cryptoBroker }).open();
  f.coordinator.inbox = inbox;
  const session = f.sessions.createSession({ operationId: id(), profileId: f.profile.id, workspace: f.root, createdAt: Date.now() });
  const refs = await upload(f, [file("image.png", PNG, "image/png"), file("notes.txt", Buffer.from("hello"), "text/plain")]);
  let runtimeInput;
  const turnStart = f.host.turnStart.bind(f.host);
  f.host.turnStart = params => { runtimeInput = params; return turnStart(params); };
  const input = { operationId: id(), sessionKey: session.sessionKey, prompt: "", attachments: refs };
  const receipt = await f.coordinator.send(input);
  await f.coordinator.waitForIdle(receipt.run.id);
  assert.ok(runtimeInput, JSON.stringify(f.dispatcher.getRun(receipt.run.id)));
  assert.equal(runtimeInput.input.filter(item => item.type === "localImage").length, 1);
  const image = runtimeInput.input.find(item => item.type === "localImage");
  assert.deepEqual(fs.readFileSync(image.path), PNG);
  assert.ok(runtimeInput.input[0].text.includes("notes.txt"));
  const events = f.transcript.listEvents(f.profile.id, session.id).filter(item => item.kind === "user");
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].content.attachments, refs);
  const controller = createChatServiceController({ paths: f.paths, productStore: f.productStore,
    chatSessionStore: f.sessions, coordinator: f.coordinator, transcriptStore: f.transcript, cursorSecret: Buffer.alloc(32, 7) });
  await controller.open();
  try {
    const history = await controller.handle("chat.history", { sessionKey: session.sessionKey, limit: 100, cursor: null });
    const message = history.messages.find(item => item.payload?.message.role === "user").payload.message;
    assert.deepEqual(message.shoggoth.attachments, refs);
    assert.equal(message.content[0].text, "");
  } finally { await controller.close(); }
  await f.coordinator.send(input);
  assert.equal(f.host.turnStarts, 1);
  await assert.rejects(f.coordinator.send({ ...input, attachments: refs.slice(0, 1) }), { code: "PENDING_COMMAND_IDEMPOTENCY_CONFLICT" });
});

test("pending attachments survive reopen and old text fingerprints remain compatible", async t => {
  let inbox;
  t.after(() => inbox?.close());
  const f = await fixture(t);
  const refs = await upload(f, [file("note.txt", Buffer.from("persist me"))]);
  const input = { operationId: id(), runId: id(), sessionKey: id(), prompt: "", createdAt: Date.now(), attachments: refs };
  inbox = await new PendingCommandInbox({ paths: f.paths, cryptoBroker }).open();
  await inbox.enqueue(input); await inbox.close(); await inbox.open();
  assert.deepEqual(inbox.get(input.operationId).attachments, refs);
  assert.deepEqual(await inbox.enqueue(input), inbox.get(input.operationId));
  await assert.rejects(inbox.enqueue({ ...input, attachments: [{ ...refs[0], name: "changed.txt" }] }), { code: "PENDING_COMMAND_IDEMPOTENCY_CONFLICT" });
  const legacy = { ...input, prompt: "legacy" }; delete legacy.attachments;
  assert.equal(fingerprintCommand(legacy), createHash("sha256").update(JSON.stringify([
    legacy.operationId, legacy.runId, legacy.sessionKey, legacy.prompt, legacy.createdAt,
  ])).digest("hex"));
});

test("native Inspiration follow-ups keep their own attachments across restart and reject replay changes", async t => {
  const f = await fixture(t), idea = await f.create();
  const started = await f.start(idea), run = await f.running(started);
  f.host.complete(run);
  await until(() => f.dispatcher.getRun(run.id)?.status === "completed");
  const refs = await upload(f, [file("补充.pdf", Buffer.from("%PDF-1.7\nfollow-up"), "application/pdf")]);
  const input = { sessionKey: started.latestExecution.sessionKey, operationId: id(), prompt: "参考附件", attachments: refs };
  const sent = f.service.sendFromSession(input);
  await f.coordinator.waitForIdle(sent.run.id);
  assert.deepEqual(f.store.executionForRun(sent.run.id).turnAttachments, refs);
  assert.deepEqual(f.store.get(idea.id).attachments, undefined);
  assert.throws(() => f.service.sendFromSession({ ...input, attachments: [] }), { code: "INSPIRATION_OPERATION_CONFLICT" });
  f.store.close(); f.store.open();
  assert.deepEqual(f.store.executionForRun(sent.run.id).turnAttachments, refs);
});
