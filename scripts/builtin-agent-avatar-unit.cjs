"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const asar = require("@electron/asar");
const { startStaticServer } = require("../app/static-server");
const { resolveDesktopAssetPaths, resolveBuiltinAgentAvatarFile } = require("../app/desktop-assets");
const { BUILTIN_CLI_AGENT_PROFILES } = require("../app/agent-service/builtin-cli-profiles");
const { defaultAgentProfile } = require("../app/agent-service/product-store");
const manifest = require("../app/assets/agent-avatars/manifest.json");

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-builtin-avatars-"));
const assetDir = path.resolve(__dirname, "../app/assets/agent-avatars");
const homeDir = path.join(temporary, "clean-home");
const paths = resolveDesktopAssetPaths({ homeDir });
const expected = {
  [defaultAgentProfile(0).agentId]: "shoggoth.png",
  "shoggoth-codex": "codex.png",
  "shoggoth-grok": "grok.png",
  "shoggoth-antigravity": "antigravity.png",
  "shoggoth-pi": "pi.png",
  "shoggoth-claude-code": "claude-code.png",
  "shoggoth-deepseek-harness": "deepseek-harness.png",
};

(async () => {
  assert.deepEqual(manifest, expected, "user-provided pictures must map to the intended native identities");
  assert.deepEqual(Object.keys(manifest).sort(), [defaultAgentProfile(0).agentId,
    ...BUILTIN_CLI_AGENT_PROFILES.map(profile => profile.agentId)].sort(),
  "every fixed native Agent must have a bundled avatar, including disabled runtimes");

  let server = await startStaticServer(0, { homeDir });
  try {
    for (const [agentId, file] of Object.entries(expected)) {
      const source = fs.readFileSync(path.join(assetDir, file));
      assert.equal(source.subarray(1, 4).toString(), "PNG");
      const imageSize = file === "shoggoth.png" ? 1254 : 768;
      assert.equal(source.readUInt32BE(16), imageSize);
      assert.equal(source.readUInt32BE(20), imageSize);
      assert.equal(resolveBuiltinAgentAvatarFile(agentId), path.join(assetDir, file));
      const response = await fetch(`${server.url}/avatar/${agentId}`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "image/png");
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), source,
        `${agentId} must render the supplied image without any user files or backend`);
      assert.deepEqual(Buffer.from(await (await fetch(`${server.url}/avatar/${agentId}?v=2`)).arrayBuffer()), source);
    }
    assert.equal(fs.existsSync(homeDir), false, "bundled defaults must not be seeded into user/backend directories");
    for (const agentId of ["shoggoth-custom-agent", "codex", "constructor", "__proto__"]) {
      assert.equal(resolveBuiltinAgentAvatarFile(agentId), null);
      assert.match((await fetch(`${server.url}/avatar/${agentId}`)).headers.get("content-type"), /image\/svg/);
    }

    const original = fs.readFileSync(path.join(assetDir, "codex.png"));
    const custom = fs.readFileSync(path.join(assetDir, "pi.png"));
    assert.equal((await fetch(`${server.url}/avatar/shoggoth-codex`, { method: "PUT", body: custom })).status, 200);
    assert.deepEqual(fs.readFileSync(path.join(paths.avatarDir, "shoggoth-codex.png")), custom);
    assert.deepEqual(fs.readFileSync(path.join(assetDir, "codex.png")), original, "custom uploads never alter package assets");
    await server.close();
    server = await startStaticServer(0, { homeDir });
    assert.deepEqual(Buffer.from(await (await fetch(`${server.url}/avatar/shoggoth-codex`)).arrayBuffer()), custom,
      "custom avatars must keep priority after restart");
    fs.unlinkSync(path.join(paths.avatarDir, "shoggoth-codex.png"));
    assert.deepEqual(Buffer.from(await (await fetch(`${server.url}/avatar/shoggoth-codex`)).arrayBuffer()), original,
      "removing a custom image must reveal the bundled default");
    assert.equal(fs.existsSync(path.join(homeDir, ".openclaw")), false);
  } finally { await server.close(); }
  console.log("PASS built-in avatars: all 7 native IDs, exact PNGs, clean home, offline reads, custom override, restart, default recovery");

  const legacyHome = path.join(temporary, "legacy-home");
  const legacyPaths = resolveDesktopAssetPaths({ homeDir: legacyHome });
  fs.mkdirSync(legacyPaths.legacyAvatarDir, { recursive: true });
  const legacyImage = fs.readFileSync(path.join(assetDir, "shoggoth.png"));
  fs.writeFileSync(path.join(legacyPaths.legacyAvatarDir, "shoggoth-codex.png"), legacyImage);
  const legacy = await startStaticServer(0, { homeDir: legacyHome });
  try {
    assert.deepEqual(Buffer.from(await (await fetch(`${legacy.url}/avatar/shoggoth-codex`)).arrayBuffer()), legacyImage);
    assert.deepEqual(fs.readFileSync(path.join(legacyPaths.avatarDir, "shoggoth-codex.png")), legacyImage,
      "bundled defaults must not suppress migration of a previous custom avatar");
  } finally { await legacy.close(); }
  console.log("PASS built-in compatibility: previous custom avatars still migrate and win");

  // Exercise the same archive format used by electron-builder without rebuilding
  // or installing the user's current App. Preserve the package-relative layout.
  const staging = path.join(temporary, "package");
  fs.cpSync(assetDir, path.join(staging, "app/assets/agent-avatars"), { recursive: true });
  const archive = path.join(temporary, "app.asar");
  await asar.createPackage(staging, archive);
  for (const file of [...Object.values(manifest), "manifest.json"]) {
    assert.deepEqual(asar.extractFile(archive, `app/assets/agent-avatars/${file}`), fs.readFileSync(path.join(assetDir, file)));
  }
  console.log("PASS archive parity: all 7 images and their manifest survive app.asar packaging unchanged");
})().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => fs.rmSync(temporary, { recursive: true, force: true }));
