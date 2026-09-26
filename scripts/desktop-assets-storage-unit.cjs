"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  resolveDesktopAssetPaths, migrateLegacyDesktopAssets,
} = require("../app/desktop-assets");
const { startStaticServer } = require("../app/static-server");

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-desktop-assets-"));
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/5ZkAAAAASUVORK5CYII=", "base64");
const uploadedPng = Buffer.concat([png, Buffer.from("new upload")]);
function put(directory, name, body, time) {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, name);
  fs.writeFileSync(file, body);
  if (time) fs.utimesSync(file, time, time);
  return file;
}
async function bytes(url, options) {
  const response = await fetch(url, options);
  return { response, body: Buffer.from(await response.arrayBuffer()) };
}

(async () => {
  const homeDir = path.join(temporary, "legacy-home");
  const userDataRoot = path.join(temporary, "custom Shoggoth data");
  const paths = resolveDesktopAssetPaths({ homeDir, userDataRoot });
  assert.equal(resolveDesktopAssetPaths({ homeDir }).avatarDir,
    path.join(homeDir, "Library/Application Support/Shoggoth/agent-avatars"));
  const legacyAvatar = put(paths.legacyAvatarDir, "main.png", png);
  put(paths.legacyAvatarDir, "main.jpeg", "old alternate");
  put(paths.legacyAvatarDir, "current.png", "legacy should not win");
  put(paths.avatarDir, "current.webp", "current custom photo");
  put(paths.legacyAvatarDir, "provider:hermes:中文.jpeg", "legacy JPEG");
  put(paths.legacyAvatarDir, "not-an-asset.json", "do not copy");
  put(paths.legacyImmersiveBgDir, "idle.mp4", "0123456789", new Date("2024-01-02T00:00:00Z"));
  put(paths.legacyImmersiveBgDir, "idle.png", png, new Date("2024-01-01T00:00:00Z"));
  put(paths.legacyImmersiveBgDir, "thinking.mp4", "newer legacy", new Date("2024-02-01T00:00:00Z"));
  put(paths.immersiveBgDir, "thinking.png", png, new Date("2023-01-01T00:00:00Z"));
  put(paths.legacyImmersiveBgDir, "not-a-state.mp4", "not a background");
  const outside = put(temporary, "outside.png", png);
  fs.symlinkSync(outside, path.join(paths.legacyAvatarDir, "escape.png"));
  fs.symlinkSync(outside, path.join(paths.legacyImmersiveBgDir, "error.png"));

  let server = await startStaticServer(0, { homeDir, userDataRoot });
  try {
    // The actual HTTP route performs the migration, including across custom roots.
    assert.deepEqual((await bytes(`${server.url}/avatar/main`)).body, png);
    assert.deepEqual(fs.readFileSync(path.join(paths.avatarDir, "main.png")), png);
    assert.deepEqual(fs.readFileSync(legacyAvatar), png, "migration must preserve its source");
    assert.equal((await (await fetch(`${server.url}/avatar/current`)).text()), "current custom photo");
    assert.equal(fs.existsSync(path.join(paths.avatarDir, "current.png")), false,
      "a legacy PNG must not outrank a current WebP");
    assert.equal(await (await fetch(`${server.url}/avatar/${encodeURIComponent("provider:hermes:中文")}`)).text(), "legacy JPEG");
    assert.equal(fs.existsSync(path.join(paths.avatarDir, "not-an-asset.json")), false);
    assert.equal(fs.existsSync(path.join(paths.avatarDir, "escape.png")), false);
    assert.equal((await fetch(`${server.url}/avatar/escape`)).headers.get("content-type"), "image/jpeg");
    assert.equal((await fetch(`${server.url}/avatar/invalid%2Fid`)).status, 404);
    assert.equal((await fetch(`${server.url}/avatar/invalid%00id`)).status, 404);

    const manifest = await (await fetch(`${server.url}/__immersive/bg-manifest`)).json();
    assert.equal(manifest.idle.file, "idle.mp4", "migration must preserve mtime selection");
    assert.equal(manifest.idle.mtime, new Date("2024-01-02T00:00:00Z").getTime());
    assert.equal(manifest.thinking.file, "thinking.png", "a current background wins across extensions and mtimes");
    assert.equal(manifest.error, undefined, "symlink backgrounds must not be published");
    assert.equal(fs.existsSync(path.join(paths.immersiveBgDir, "not-a-state.mp4")), false);
    const range = await bytes(`${server.url}/__immersive/bg/idle.mp4`, { headers: { Range: "bytes=2-5" } });
    assert.equal(range.response.status, 206);
    assert.equal(range.response.headers.get("content-range"), "bytes 2-5/10");
    assert.equal(range.body.toString(), "2345");
    assert.equal((await fetch(`${server.url}/__immersive/bg/error.png`)).status, 404);
    assert.equal((await fetch(`${server.url}/__immersive/bg/%2e%2e%2foutside.png`)).status, 404);

    const upload = await fetch(`${server.url}/avatar/main`, { method: "PUT", body: uploadedPng });
    assert.equal(upload.status, 200);
    assert.deepEqual(fs.readFileSync(path.join(paths.avatarDir, "main.png")), uploadedPng);
    assert.deepEqual(fs.readFileSync(legacyAvatar), png, "upload must never write to the backend directory");
    assert.equal(fs.existsSync(path.join(paths.avatarDir, "main.jpeg")), false);
    assert.equal(fs.readFileSync(path.join(paths.legacyAvatarDir, "main.jpeg"), "utf8"), "old alternate");
    assert.equal((await fetch(`${server.url}/avatar/main`, { method: "PUT", body: "invalid" })).status, 415);
    assert.deepEqual((await bytes(`${server.url}/avatar/main`)).body, uploadedPng);
    assert.equal((await fetch(`${server.url}/avatar/invalid%2Fid`, { method: "PUT", body: png })).status, 400);

    await server.close();
    server = await startStaticServer(0, { homeDir, userDataRoot });
    assert.deepEqual((await bytes(`${server.url}/avatar/main`)).body, uploadedPng, "restart must not restore the old photo");
    assert.equal(fs.existsSync(path.join(paths.avatarDir, "main.jpeg")), false, "restart must not resurrect stale variants");
    assert.equal(fs.readdirSync(paths.avatarDir).some(name => name.endsWith(".tmp")), false);
    const repeat = migrateLegacyDesktopAssets(paths);
    assert.equal(repeat.copied, 0);
    assert.equal(repeat.errors, 0);
  } finally { await server.close(); }
  console.log("PASS legacy migration: avatars, Unicode IDs, background mtimes, Range, new-store precedence, restart, source preservation");

  // A fresh install never creates an OpenClaw directory, and simultaneous servers
  // use their own storage roots rather than a module-global home directory.
  const freshHome = path.join(temporary, "fresh-home");
  const isolatedHome = path.join(temporary, "isolated-home");
  const fresh = await startStaticServer(0, { homeDir: freshHome });
  const isolated = await startStaticServer(0, { homeDir: isolatedHome });
  try {
    assert.equal((await fetch(`${fresh.url}/avatar/main`, { method: "PUT", body: png })).status, 200);
    assert.deepEqual(fs.readFileSync(resolveDesktopAssetPaths({ homeDir: freshHome }).avatarDir + "/main.png"), png);
    assert.equal(fs.existsSync(path.join(freshHome, ".openclaw")), false);
    assert.equal((await fetch(`${isolated.url}/avatar/main`)).headers.get("content-type"), "image/jpeg");
    assert.equal(fs.existsSync(isolatedHome), true, "default selections persist in the isolated user data");
  } finally { await fresh.close(); await isolated.close(); }
  console.log("PASS fresh install: Shoggoth-only writes and independent server roots");

  // Destination failures retain legacy visibility, and a symlink directory is
  // neither written nor used to serve outside files.
  const blockedHome = path.join(temporary, "blocked-home");
  const blockedRoot = path.join(temporary, "blocked-data");
  const blockedPaths = resolveDesktopAssetPaths({ homeDir: blockedHome, userDataRoot: blockedRoot });
  put(blockedPaths.legacyAvatarDir, "main.png", png);
  fs.mkdirSync(blockedRoot, { recursive: true });
  fs.symlinkSync(temporary, blockedPaths.avatarDir);
  const warnings = [];
  assert.equal(migrateLegacyDesktopAssets(blockedPaths, { warn: message => warnings.push(message) }).errors, 1);
  assert.equal(warnings.length, 1);
  const blocked = await startStaticServer(0, { homeDir: blockedHome, userDataRoot: blockedRoot });
  try {
    assert.deepEqual((await bytes(`${blocked.url}/avatar/main`)).body, png);
    assert.equal((await fetch(`${blocked.url}/avatar/new`, { method: "PUT", body: png })).status, 500);
    assert.equal(fs.existsSync(path.join(temporary, "new.png")), false);
  } finally { await blocked.close(); }
  console.log("PASS migration failure: legacy fallback, no symlink escape, no backend writes");

  // Simulate a disk filling mid-copy: no partial file may be published, and a
  // lower-priority image must not replace the active background during retry.
  const partialPaths = resolveDesktopAssetPaths({ homeDir: path.join(temporary, "partial-home") });
  put(partialPaths.legacyAvatarDir, "main.png", png);
  put(partialPaths.legacyAvatarDir, "main.jpeg", "old alternate");
  put(partialPaths.legacyImmersiveBgDir, "idle.mp4", "latest video", new Date("2024-01-02T00:00:00Z"));
  put(partialPaths.legacyImmersiveBgDir, "idle.png", png, new Date("2024-01-01T00:00:00Z"));
  const copyFileSync = fs.copyFileSync;
  try {
    fs.copyFileSync = (input, output) => {
      fs.writeFileSync(output, "partial");
      throw Object.assign(new Error("simulated full disk"), { code: "ENOSPC" });
    };
    const failed = migrateLegacyDesktopAssets(partialPaths, { warn: () => {} });
    assert.equal(failed.errors, 2);
    assert.deepEqual(fs.readdirSync(partialPaths.avatarDir), []);
    assert.deepEqual(fs.readdirSync(partialPaths.immersiveBgDir), []);
  } finally { fs.copyFileSync = copyFileSync; }
  assert.deepEqual(migrateLegacyDesktopAssets(partialPaths), { copied: 4, skipped: 0, errors: 0 });
  assert.deepEqual(fs.readFileSync(path.join(partialPaths.avatarDir, "main.png")), png);
  assert.equal(fs.readFileSync(path.join(partialPaths.immersiveBgDir, "idle.mp4"), "utf8"), "latest video");
  console.log("PASS interrupted copy: atomic publication, no partial files, clean retry");
})().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => fs.rmSync(temporary, { recursive: true, force: true }));
