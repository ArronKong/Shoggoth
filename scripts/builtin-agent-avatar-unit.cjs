"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const asar = require("@electron/asar");
const { createDefaultAgentAvatarPool } = require("../app/default-agent-avatar-pool");
const { resolveDesktopAssetPaths } = require("../app/desktop-assets");
const manifest = require("../app/assets/agent-avatars/manifest.json");

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-bundled-avatars-"));
const assetDir = path.resolve(__dirname, "../app/assets/agent-avatars");
const libraryDir = path.join(assetDir, "library");
const hash = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

(async () => {
  assert.equal(manifest.version, 1);
  assert.equal(manifest.entries.length, 150, "bundle the entire supplied JPG collection");
  assert.equal(fs.readdirSync(libraryDir).length, manifest.entries.length);
  for (const { file, sha256 } of manifest.entries) {
    assert.match(file, /\.jpg$/i);
    assert.equal(hash(path.join(libraryDir, file)), sha256, `source bytes changed: ${file}`);
  }
  const uniqueCount = new Set(manifest.entries.map((entry) => entry.sha256)).size;
  assert.equal(uniqueCount, 149, "one pair of supplied files has identical bytes");

  const paths = resolveDesktopAssetPaths({ homeDir: path.join(temporary, "home") });
  const pool = createDefaultAgentAvatarPool(paths, { choose: () => 0 });
  const assigned = new Map();
  for (let index = 0; index < uniqueCount; index += 1) {
    const id = `new-agent-${index}`;
    const file = pool.select(id);
    assert.equal(path.dirname(file), libraryDir);
    const digest = hash(file);
    assert.equal(assigned.has(digest), false, `image reused while another was free: ${id}`);
    assigned.set(digest, id);
    assert.equal(pool.select(id), file, "repeat reads keep the assigned image");
  }
  assert.equal(assigned.size, uniqueCount);
  const firstFile = pool.select("new-agent-0");
  const restarted = createDefaultAgentAvatarPool(paths, { choose: () => 0 });
  assert.equal(restarted.select("new-agent-0"), firstFile, "assignment survives restart");
  assert.equal(restarted.select("new-agent-148"), pool.select("new-agent-148"));

  const secondFile = restarted.select("new-agent-1");
  restarted.move("new-agent-1", "renamed-agent");
  assert.equal(restarted.select("renamed-agent"), secondFile, "renaming keeps the same picture");
  assert.equal(JSON.parse(fs.readFileSync(path.join(paths.avatarDir, ".default-selections.json"), "utf8"))
    .assignments["new-agent-1"], undefined, "renaming frees the old identity");

  restarted.release("new-agent-0");
  const replacement = restarted.select("replacement");
  assert.equal(hash(replacement), hash(firstFile), "released image returns to the available pool");
  assert.ok(assigned.has(hash(restarted.select("after-exhaustion"))),
    "reuse is allowed only after every distinct image has an assignment");
  assert.equal(restarted.select("../invalid"), null);

  const staging = path.join(temporary, "package");
  fs.cpSync(assetDir, path.join(staging, "app/assets/agent-avatars"), { recursive: true });
  const archive = path.join(temporary, "app.asar");
  await asar.createPackage(staging, archive);
  for (const { file } of manifest.entries) {
    assert.deepEqual(asar.extractFile(archive, `app/assets/agent-avatars/library/${file}`),
      fs.readFileSync(path.join(libraryDir, file)));
  }
  assert.deepEqual(asar.extractFile(archive, "app/assets/agent-avatars/manifest.json"),
    fs.readFileSync(path.join(assetDir, "manifest.json")));
  console.log("PASS bundled avatars: 150 exact JPGs, 149 unique assignments, restart, release, exhaustion, archive parity");
})().catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(() => fs.rmSync(temporary, { recursive: true, force: true }));
