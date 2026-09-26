"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startStaticServer } = require("../app/static-server");
const { resolveDesktopAssetPaths } = require("../app/desktop-assets");

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-avatar-http-"));
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/5ZkAAAAASUVORK5CYII=", "base64");
const bytes = async (url, init) => {
  const response = await fetch(url, init);
  return { response, body: Buffer.from(await response.arrayBuffer()) };
};

(async () => {
  const homeDir = path.join(temporary, "home");
  const paths = resolveDesktopAssetPaths({ homeDir });
  let server = await startStaticServer(0, { homeDir });
  try {
    const first = await bytes(`${server.url}/avatar/shoggoth-codex`);
    const second = await bytes(`${server.url}/avatar/shoggoth-pi`);
    assert.equal(first.response.headers.get("content-type"), "image/jpeg");
    assert.equal(second.response.headers.get("content-type"), "image/jpeg");
    assert.notDeepEqual(first.body, second.body, "native Agents draw unused images");
    assert.deepEqual((await bytes(`${server.url}/avatar/shoggoth-codex?v=2`)).body, first.body,
      "version refresh must not reshuffle the default image");
    assert.equal((await fetch(`${server.url}/avatar/invalid%2Fid`)).status, 404);

    const selectionsPath = path.join(paths.avatarDir, ".default-selections.json");
    assert.equal(Object.keys(JSON.parse(fs.readFileSync(selectionsPath, "utf8")).assignments).length, 2);
    const upload = await fetch(`${server.url}/avatar/shoggoth-codex`, { method: "PUT", body: png });
    assert.equal(upload.status, 200);
    assert.deepEqual((await bytes(`${server.url}/avatar/shoggoth-codex`)).body, png,
      "custom avatar keeps priority");
    assert.equal(JSON.parse(fs.readFileSync(selectionsPath, "utf8")).assignments["shoggoth-codex"], undefined,
      "custom upload frees the bundled slot");
    await server.close();
    server = await startStaticServer(0, { homeDir });
    assert.deepEqual((await bytes(`${server.url}/avatar/shoggoth-pi`)).body, second.body,
      "default avatar survives service restart");
    assert.deepEqual((await bytes(`${server.url}/avatar/shoggoth-codex`)).body, png,
      "custom image survives service restart");
    fs.unlinkSync(path.join(paths.avatarDir, "shoggoth-codex.png"));
    assert.equal((await fetch(`${server.url}/avatar/shoggoth-codex`)).headers.get("content-type"), "image/jpeg",
      "removing a custom image returns to the bundled library");

    await server.close();
    const backend = {
      createAgent: async () => ({ id: "new-native-agent" }),
    };
    const registry = { getBackend: (id) => id === "shoggoth" ? backend : null };
    server = await startStaticServer(0, { homeDir, registry });
    const created = await fetch(`${server.url}/__api/agents?backend=shoggoth`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: server.url },
      body: JSON.stringify({ name: "New" }),
    });
    assert.equal(created.status, 200);
    assert.ok(JSON.parse(fs.readFileSync(selectionsPath, "utf8")).assignments["new-native-agent"],
      "creating an Agent reserves an unused image before its card loads");
    console.log("PASS avatar HTTP: random unused JPGs, stable URLs/restart, custom priority/release, invalid IDs");
  } finally { await server.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(() => fs.rmSync(temporary, { recursive: true, force: true }));
