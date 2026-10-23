"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { readSessionImage, imageReferences, MAX_IMAGE_BYTES } = require("../app/core/session-image-media");
const { startStaticServer } = require("../app/static-server");
const { nativeAgentImages, PNG } = require("./fixtures/native-agent-images.cjs");

function fixture(t, runtime) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-agent-images-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, ...nativeAgentImages(root, runtime) };
}

test("native backends read exact image bytes from delivered local, URL, relative and home paths", async t => {
  for (const runtime of ["codex", "claude-code", "pi", "grok-build", "antigravity", "deepseek-harness", "shoggoth"]) {
    const f = fixture(t, runtime);
    for (const ref of [f.imagePath, `file://${encodeURI(f.imagePath)}`, "./relative.png"]) {
      const image = await f.backend.readSessionImage(f.key, ref);
      assert.equal(image?.mimeType, "image/png", runtime);
      assert.deepEqual(image.bytes, PNG);
    }
    f.history[1].content[0].text = "![居家](~/relative.png)";
    assert.deepEqual((await f.backend.readSessionImage(f.key, "~/relative.png")).bytes, PNG);
    f.history[1].content[0].text = `![编码](<${encodeURI(f.imagePath)}>)`;
    assert.deepEqual((await f.backend.readSessionImage(f.key, f.imagePath)).bytes, PNG);
    assert.equal(await f.backend.readSessionImage(f.otherKey, f.imagePath), null, "same workspace does not authorize another session");
    await assert.rejects(f.backend.readSessionImage(f.key.replace(f.agentId, "foreign-agent"), f.imagePath), { code: "CHAT_SESSION_INVALID" });
  }
});

test("only explicit assistant deliveries authorize reads; code, user input, tools and plain paths do not", async t => {
  const f = fixture(t);
  const read = content => readSessionImage({ messages: content, ref: f.imagePath, workspace: f.root, runtimeHome: f.root });
  for (const message of [
    { role: "user", content: f.text },
    { role: "toolResult", content: f.text },
    { role: "assistant", content: f.imagePath },
    { role: "assistant", content: `\`\`\`md\n![example](<${f.imagePath}>)\n\`\`\`` },
    { role: "assistant", content: `\`![example](<${f.imagePath}>)\`` },
    { role: "assistant", content: `\`\`\`md\n![example](<${f.imagePath}>)` },
    { role: "assistant", content: `    ![example](<${f.imagePath}>)` },
    { role: "assistant", content: [{ type: "toolCall", arguments: { image: f.imagePath } }] },
  ]) assert.equal(await read([message]), null);
  assert.deepEqual(imageReferences("![caption](./image(1).png \"title\")"), ["./image(1).png"]);
  assert.deepEqual(imageReferences("![caption][Image]\n\n[image]: <./with spaces.png>"), ["./with spaces.png"]);
  f.history[1].content[0].text = `![图片][image]\n\n[image]: <${f.imagePath}>`;
  assert.deepEqual((await f.backend.readSessionImage(f.key, f.imagePath)).bytes, PNG);
});

test("missing, non-image, fake-image, directory, symlink and oversized files stay closed", async t => {
  const f = fixture(t);
  const fake = path.join(f.root, "fake.png");
  const directory = path.join(f.root, "folder.png");
  const symlink = path.join(f.root, "symlink.png");
  const large = path.join(f.root, "oversized.png");
  fs.writeFileSync(fake, "private text is not an image");
  fs.mkdirSync(directory);
  fs.symlinkSync(f.imagePath, symlink);
  fs.writeFileSync(large, PNG); fs.truncateSync(large, MAX_IMAGE_BYTES + 1);
  for (const ref of [fake, directory, symlink, large, path.join(f.root, "missing.png"), path.join(f.root, "secret.json")]) {
    f.history[1].content[0].text = `![invalid](<${ref}>)`;
    assert.equal(await f.backend.readSessionImage(f.key, ref), null, ref);
  }
  assert.equal(await f.backend.readSessionImage(f.key, "file://evil.test/a.png"), null);
  assert.equal(await f.backend.readSessionImage(f.key, "javascript:alert(1).png"), null);
  const svgPath = path.join(f.root, "chart.svg");
  const svg = '<?xml version="1.0"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n<svg xmlns="http://www.w3.org/2000/svg"/>';
  fs.writeFileSync(svgPath, svg);
  f.history[1].content[0].text = `![图表](<${svgPath}>)`;
  const image = await f.backend.readSessionImage(f.key, svgPath);
  assert.equal(image.mimeType, "image/svg+xml");
  assert.equal(image.bytes.toString(), svg);
});

test("parallel image requests share history work, revalidate changes, and discard failed history reads", async t => {
  const f = fixture(t);
  const original = f.backend._getHistoryItems;
  let calls = 0;
  f.backend._getHistoryItems = async key => { calls++; await new Promise(resolve => setTimeout(resolve, 10)); return original(key); };
  await Promise.all([f.backend.readSessionImage(f.key, f.imagePath), f.backend.readSessionImage(f.key, "./relative.png")]);
  assert.equal(calls, 1);
  f.history[1].content = [];
  assert.equal(await f.backend.readSessionImage(f.key, f.imagePath), null);
  assert.equal(calls, 2, "completed history must not cache a stale authorization");
  f.backend._getHistoryItems = async () => { throw Error("offline"); };
  await assert.rejects(f.backend.readSessionImage(f.key, f.imagePath), /offline/);
  assert.equal(f.backend._sessionImageHistory.size, 0);
  f.history[1].content = [{ type: "text", text: f.text }];
  f.backend._getHistoryItems = async key => {
    const items = await original(key);
    f.backend._sessionTarget(key).session.runtimeBindingId = "changed-during-read";
    return items;
  };
  assert.equal(await f.backend.readSessionImage(f.key, f.imagePath), null, "a binding change during history loading invalidates the read");
});

test("home references follow the session's active runtime binding", async t => {
  const f = fixture(t);
  const bindingHome = path.join(f.root, "pi-home");
  fs.mkdirSync(bindingHome);
  fs.writeFileSync(path.join(bindingHome, "binding.png"), PNG);
  f.history[1].content[0].text = "![绑定图片](~/binding.png)";
  const session = f.backend._sessionTarget(f.key).session;
  session.runtimeBindingId = "pi-binding";
  f.backend._bindingsByProfile = new Map([[session.profileId, [{ id: "pi-binding", runtime: "pi", runtimeAccountId: "pi-account" }]]]);
  f.backend.runtimeCliAuth.set("pi-account", { runtime: "pi", processHome: bindingHome });
  assert.deepEqual((await f.backend.readSessionImage(f.key, "~/binding.png")).bytes, PNG);
});

test("real HTTP media route returns binary images and enforces session, backend, method and origin guards", async t => {
  const f = fixture(t);
  const server = await startStaticServer(0, { registry: { getBackend: id => id === "shoggoth" ? f.backend : null },
    homeDir: f.root, userDataRoot: path.join(f.root, "app-data") });
  t.after(() => server.close());
  const url = (key = f.key, backend = "shoggoth", ref = f.imagePath) => `${server.url}/__api/sessions/image?${new URLSearchParams({ backend, key, ref })}`;
  const response = await fetch(url());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), PNG);
  assert.equal((await fetch(url(f.otherKey))).status, 404);
  assert.equal((await fetch(url(f.key, "other-backend"))).status, 404);
  assert.equal((await fetch(url(), { method: "POST" })).status, 405);
  assert.equal((await fetch(url(), { headers: { Origin: "https://evil.test" } })).status, 403);
  assert.equal((await fetch(url(), { headers: { "Sec-Fetch-Site": "cross-site" } })).status, 403);
  assert.equal((await fetch(`${server.url}/__api/sessions/image`)).status, 400);
});
