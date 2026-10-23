"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { nativeAttachmentParts, legacyAttachmentText } = require("../app/agent-service/opencode-attachments");
const { attachmentTextParts, MAX_TEXT_BYTES } = require("../app/agent-service/chat-attachment-text");

test("OpenCode receives submitted HTML as user text without relaxing file permissions", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-text-parts-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const save = (name, content, mimeType = "application/octet-stream") => {
    const file = path.join(root, name); fs.writeFileSync(file, content, { mode: 0o600 });
    return { name, path: file, mimeType };
  };
  const html = save("daily-news.html", "<html>中文测试</html>"), png = save("preview.png", "fixture", "image/png");
  const parts = [...attachmentTextParts([html, png], fs), ...nativeAttachmentParts([html, png])];
  assert.equal(parts[0].type, "text");
  assert.ok(parts[0].text.includes("<html>中文测试</html>"));
  assert.ok(parts[0].text.includes("untrusted data"));
  assert.equal(parts[1].type, "file"); assert.equal(parts[1].mime, "image/png");
  const huge = save("large.html", Buffer.alloc(MAX_TEXT_BYTES + 1, 65));
  const binary = save("binary.html", Buffer.from([0, 0xff, 1]));
  const zip = save("archive.zip", "PK fixture");
  for (const part of attachmentTextParts([huge, binary, zip], fs)) {
    assert.equal(part.type, "text"); assert.ok(part.text.includes("Content is not embedded"));
    assert.equal(part.text.includes("BEGIN ATTACHMENT CONTENT"), false);
  }
  const third = save("third.txt", "third-file-canary");
  const large = save("limit.txt", Buffer.alloc(MAX_TEXT_BYTES, 65));
  assert.ok(attachmentTextParts([large, large, third], fs)[2].text.includes("Content is not embedded"));
  const link = path.join(root, "symlink.html"); fs.symlinkSync(html.path, link);
  assert.throws(() => attachmentTextParts([{ ...html, path: link }], fs), { code: "RUNTIME_ATTACHMENT_INVALID" });
  assert.throws(() => attachmentTextParts([{ ...html, path: path.join(root, "missing") }], fs), { code: "RUNTIME_ATTACHMENT_INVALID" });
});

test("old file bytes are decoded only as bounded UTF-8 data, never fetched or evaluated", () => {
  const part = { filename: "page.html", mime: "application/octet-stream",
    url: "data:application/octet-stream;base64," + Buffer.from("<html>old-file-canary</html>").toString("base64") };
  assert.ok(legacyAttachmentText(part).includes("old-file-canary"));
  assert.equal(legacyAttachmentText(part).includes("base64"), false);
  for (const url of ["https://example.invalid/read-me", "file:///private/secret.html",
    "data:application/octet-stream;base64,AA==", "data:application/octet-stream;base64,/w==",
    "data:application/octet-stream;base64,!!!!", part.url + "A"]) {
    assert.ok(legacyAttachmentText({ ...part, url }).includes("Content is not embedded"));
  }
  assert.ok(legacyAttachmentText(part, 4).includes("Content is not embedded"));
});
