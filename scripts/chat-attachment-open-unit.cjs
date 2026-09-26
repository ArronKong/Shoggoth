"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { test } = require("node:test");
const { startStaticServer } = require("../app/static-server");
const { createChatAttachmentOpener, validAttachmentName, MAX_OPEN_ATTACHMENT_BYTES } = require("../app/chat-attachment-open");

test("private attachment copies preserve bytes, separate same-name files, and clean up", async (t) => {
  const paths = [];
  const opener = createChatAttachmentOpener(async (file) => { paths.push(file); return ""; });
  t.after(() => opener.dispose());
  const bytes = Buffer.from([0, 255, 127, 42]);
  await opener.open("中文 附件.md", bytes);
  assert.deepEqual(fs.readFileSync(paths[0]), bytes);
  assert.equal(fs.statSync(paths[0]).mode & 0o777, 0o600);
  await opener.open("中文 附件.md", bytes);
  assert.equal(paths[1], paths[0], "repeated clicks reuse the same private file");
  await opener.open("中文 附件.md", Buffer.from("different"));
  assert.notEqual(paths[2], paths[0], "same names must not overwrite different attachments");
  for (const name of ["../bad.md", "..", "a/b", "a\\b", "bad\0.md", "", "文".repeat(100)]) {
    assert.equal(validAttachmentName(name), false);
    await assert.rejects(opener.open(name, bytes), /Invalid attachment/);
  }
  await assert.rejects(opener.open("large.bin", Buffer.alloc(MAX_OPEN_ATTACHMENT_BYTES + 1)), /Invalid attachment/);
  opener.dispose();
  assert.ok(paths.every((file) => !fs.existsSync(file)));
});

test("host attachment route opens exact bytes, reports failures, and retains origin protection", async (t) => {
  const opened = [];
  const server = await startStaticServer(0, { registry: {}, hostOps: {
    openPath: async (file) => { opened.push({ file, bytes: fs.readFileSync(file) }); return file.endsWith("failed.md") ? "OS could not open file" : ""; },
  } });
  t.after(() => server.close());
  const post = (name, body, headers = {}) => fetch(`${server.url}/__api/host/open-attachment?name=${encodeURIComponent(name)}`, {
    method: "POST", body, headers: { "Content-Type": "application/octet-stream", ...headers },
  });
  const bytes = Buffer.from("# 文档\n\0exact bytes");
  assert.equal((await post("需求.md", bytes)).status, 200);
  assert.deepEqual(opened[0].bytes, bytes);
  assert.equal((await post("../escaped.md", bytes)).status, 400);
  assert.equal((await post("需求.md", bytes, { Origin: "https://example.com" })).status, 403);
  const failed = await post("failed.md", bytes);
  assert.equal(failed.status, 500);
  assert.match((await failed.json()).error, /OS could not open file/);
  assert.equal(opened.length, 2);
  await server.close();
  assert.ok(opened.every(({ file }) => !fs.existsSync(file)));
});
