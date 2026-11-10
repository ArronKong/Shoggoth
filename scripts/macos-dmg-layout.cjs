"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// The two approved Figma background exports are artwork, without the draggable
// files. Finder renders the actual App and Applications link over this artwork.
const layout = Object.freeze({ width: 640, height: 400, titleBarHeight: 31, iconSize: 128, textSize: 13 });

function assertDmgBackgrounds(resources) {
  for (const [name, scale] of [["background.png", 1], ["background@2x.png", 2]]) {
    const data = fs.readFileSync(path.join(resources, name));
    assert.ok(data.length >= 33 && data.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
      && data.toString("ascii", 12, 16) === "IHDR", `${name} must be a PNG image`);
    assert.equal(data.readUInt32BE(16), layout.width * scale, `${name} has the wrong width`);
    assert.equal(data.readUInt32BE(20), layout.height * scale, `${name} has the wrong height`);
  }
}

function dmgBuildSettings({ root, app, arch }) {
  assert.ok(["arm64", "x64"].includes(arch), "Unsupported DMG architecture");
  const resources = path.join(root, "build", "dmg");
  assertDmgBackgrounds(resources);
  return {
    title: `Shoggoth ${arch}`,
    format: "UDZO",
    filesystem: "HFS+",
    background: path.join(resources, "background.png"),
    // dmgbuild combines the original 1x/2x PNGs into a 72/144 dpi TIFF.
    // Finder's saved bounds include its title bar. Reserve 31 points (verified
    // in Finder on macOS 26) so none of the 400-point artwork is cropped.
    window: {
      position: { x: 200, y: 200 },
      size: { width: layout.width, height: layout.height + layout.titleBarHeight },
    },
    "icon-size": layout.iconSize,
    "text-size": layout.textSize,
    contents: [
      { x: 160, y: 238, type: "file", path: app, name: "Shoggoth.app" },
      { x: 480, y: 238, type: "link", path: "/Applications", name: "Applications" },
    ],
  };
}

module.exports = { layout, assertDmgBackgrounds, dmgBuildSettings };
