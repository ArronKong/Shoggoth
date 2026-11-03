"use strict";

// Settings → App icon: config schema, Dock + Finder application, packaged assets.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { normalizeConfig, createConfigStore, APP_ICON_IDS, DEFAULT_APP_ICON } = require("../app/core/config-store");
const { createAppIconController, appIconImagePath, appBundlePath } = require("../app/desktop-app-icon");

const root = path.resolve(__dirname, "..");
const BUNDLE = "/Applications/Shoggoth.app";

function harness({ packaged = true, hasCustom = false, platform = "darwin", emptyImage = false, setOk = true } = {}) {
  const dock = [];
  const finder = [];
  const warnings = [];
  const state = { hasCustom };
  const app = {
    isPackaged: packaged,
    getPath: name => (name === "exe" ? `${BUNDLE}/Contents/MacOS/Shoggoth` : ""),
    dock: { setIcon: image => dock.push(image.path) },
  };
  const nativeImage = { createFromPath: file => ({ path: file, isEmpty: () => emptyImage }) };
  const controller = createAppIconController({
    app, nativeImage, platform,
    fsImpl: { existsSync: file => file === path.join(BUNDLE, "Icon\r") && state.hasCustom },
    setBundleIcon: async (bundle, image) => { finder.push([bundle, image]); return setOk; },
    logger: { warn: message => warnings.push(message) },
  });
  return { controller, dock, finder, warnings, state };
}

test("config: appIcon defaults to Shoggoth IP and rejects unknown values", () => {
  assert.deepEqual(APP_ICON_IDS, ["shoggoth-ip", "shoggoth-logo"]);
  assert.equal(DEFAULT_APP_ICON, "shoggoth-ip");
  assert.equal(normalizeConfig({}).appIcon, "shoggoth-ip");
  assert.equal(normalizeConfig({ appIcon: "shoggoth-logo" }).appIcon, "shoggoth-logo");
  for (const bad of ["", "logo", null, 1, ["shoggoth-logo"]]) assert.equal(normalizeConfig({ appIcon: bad }).appIcon, "shoggoth-ip");
});

test("config: appIcon round-trips through a partial write", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "app-icon-"));
  try {
    const store = createConfigStore(path.join(dir, "config.json"));
    store.ensure();
    assert.equal(store.write({ appIcon: "shoggoth-logo" }).appIcon, "shoggoth-logo");
    assert.equal(store.read().appIcon, "shoggoth-logo");
    assert.equal(store.write({ locale: "en" }).appIcon, "shoggoth-logo");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("paths: images resolve outside app.asar and the bundle comes from the executable", () => {
  assert.equal(appIconImagePath("shoggoth-logo", "/A/Shoggoth.app/Contents/Resources/app.asar/app"),
    "/A/Shoggoth.app/Contents/Resources/app.asar.unpacked/app/assets/app-icons/shoggoth-logo.png");
  assert.equal(appIconImagePath("shoggoth-ip", "/repo/app"), "/repo/app/assets/app-icons/shoggoth-ip.png");
  assert.equal(appBundlePath(`${BUNDLE}/Contents/MacOS/Shoggoth`), BUNDLE);
  assert.equal(appBundlePath("/repo/node_modules/.bin/electron"), null);
});

test("dock: sets the chosen icon once per change and retries an unreadable image", async () => {
  const h = harness();
  await h.controller.apply("shoggoth-logo");
  await h.controller.apply("shoggoth-logo");
  await h.controller.apply("shoggoth-ip");
  assert.deepEqual(h.dock.map(file => path.basename(file)), ["shoggoth-logo.png", "shoggoth-ip.png"]);

  const empty = harness({ emptyImage: true });
  await empty.controller.apply("shoggoth-logo");
  assert.deepEqual(empty.dock, []);
});

test("non-macOS and unknown ids do nothing", async () => {
  const linux = harness({ platform: "linux" });
  await linux.controller.apply("shoggoth-logo");
  const unknown = harness();
  await unknown.controller.apply("evil/../icon");
  assert.deepEqual([linux.dock, linux.finder, unknown.dock, unknown.finder], [[], [], [], []]);
});

test("finder: unpackaged runs never touch the Electron.app bundle", async () => {
  const h = harness({ packaged: false });
  await h.controller.apply("shoggoth-logo");
  assert.equal(h.dock.length, 1);
  assert.deepEqual(h.finder, []);
});

test("finder: startup only restores a missing non-default icon", async () => {
  const defaultIcon = harness({ hasCustom: true });
  await defaultIcon.controller.apply("shoggoth-ip"); // a user's own Finder icon stays
  assert.deepEqual(defaultIcon.finder, []);

  const present = harness({ hasCustom: true });
  await present.controller.apply("shoggoth-logo");
  assert.deepEqual(present.finder, []);

  const replacedByUpdate = harness({ hasCustom: false });
  await replacedByUpdate.controller.apply("shoggoth-logo");
  assert.deepEqual(replacedByUpdate.finder, [[BUNDLE, appIconImagePath("shoggoth-logo")]]);
});

test("finder: switching sets the custom icon or removes it for the default", async () => {
  const h = harness();
  await h.controller.apply("shoggoth-ip"); // startup, nothing to do
  await h.controller.apply("shoggoth-logo");
  h.state.hasCustom = true;
  await h.controller.apply("shoggoth-logo"); // unchanged
  await h.controller.apply("shoggoth-ip");
  h.state.hasCustom = false;
  await h.controller.apply("shoggoth-logo");
  await h.controller.apply("shoggoth-ip"); // no Icon\r on disk: nothing to remove
  assert.deepEqual(h.finder, [
    [BUNDLE, appIconImagePath("shoggoth-logo")],
    [BUNDLE, ""],
    [BUNDLE, appIconImagePath("shoggoth-logo")],
  ]);
});

test("finder: a failed update warns and keeps the Dock icon", async () => {
  const h = harness({ setOk: false });
  await h.controller.apply("shoggoth-logo");
  assert.equal(h.dock.length, 1);
  assert.equal(h.warnings.length, 1);
});

test("assets: every icon has a Dock/Finder image and a Settings thumbnail; packaging matches", () => {
  for (const id of APP_ICON_IDS) {
    assert.ok(fs.statSync(path.join(root, "app/assets/app-icons", `${id}.png`)).size > 0, id);
    assert.ok(fs.statSync(path.join(root, "app/manage-ui/src/assets/app-icons", `${id}.png`)).size > 0, id);
  }
  const builder = fs.readFileSync(path.join(root, "electron-builder.yml"), "utf8");
  assert.match(builder, /^\s+icon: build\/shoggoth-ip\.icon$/mu, "the bundle icon is the default choice");
  assert.match(builder, /^\s+- app\/assets\/app-icons\/\*\*\/\*$/mu, "Finder reads the images from app.asar.unpacked");
  assert.ok(fs.existsSync(path.join(root, "build/shoggoth-ip.icon/icon.json")));
  assert.ok(fs.existsSync(path.join(root, "build/shoggothappicon.icon/icon.json")));
});
