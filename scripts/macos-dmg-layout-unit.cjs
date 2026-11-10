"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { layout, assertDmgBackgrounds, dmgBuildSettings } = require("./macos-dmg-layout.cjs");

const root = path.resolve(__dirname, "..");

test("approved backgrounds have complementary 1x/2x resolutions", () => {
  assertDmgBackgrounds(path.join(root, "build/dmg"));
});

test("both architectures produce independent images from the already signed App", () => {
  const app = path.join(os.tmpdir(), "DMG fixture with spaces", "Shoggoth.app");
  const settings = ["arm64", "x64"].map(arch => dmgBuildSettings({ root, app, arch }));
  assert.notEqual(settings[0].title, settings[1].title);
  for (const config of settings) {
    assert.equal(config.window.size.width, layout.width);
    assert.equal(config.window.size.height - layout.titleBarHeight, layout.height,
      "Finder title bar must not crop the artwork");
    assert.deepEqual(config.contents, [
      { x: 160, y: 238, type: "file", path: app, name: "Shoggoth.app" },
      { x: 480, y: 238, type: "link", path: "/Applications", name: "Applications" },
    ]);
  }
  assert.throws(() => dmgBuildSettings({ root, arch: "universal" }), /Unsupported DMG architecture/u);
});

test("missing, invalid or incorrectly sized artwork stops the image build", () => {
  const resources = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-dmg-artwork-"));
  try {
    assert.throws(() => assertDmgBackgrounds(resources), /ENOENT/u);
    fs.writeFileSync(path.join(resources, "background.png"), "not an image");
    assert.throws(() => assertDmgBackgrounds(resources), /must be a PNG/u);
    for (const name of ["background.png", "background@2x.png"]) {
      fs.copyFileSync(path.join(root, "build/dmg", name), path.join(resources, name));
    }
    const retina = fs.readFileSync(path.join(resources, "background@2x.png"));
    retina.writeUInt32BE(640, 16);
    fs.writeFileSync(path.join(resources, "background@2x.png"), retina);
    assert.throws(() => assertDmgBackgrounds(resources), /wrong width/u);
  } finally {
    fs.rmSync(resources, { recursive: true, force: true });
  }
});
