"use strict";

// Renders the selectable App icons (Settings → App icon) from their Icon Composer
// sources. Run by hand only when an icon source changes; the PNGs are committed.
//
// macOS shows a runtime Dock icon and a Finder custom icon exactly as given (no
// system mask), so the PNGs must already be the finished system rendering. actool
// compiles each .icon the same way electron-builder does, then AppKit draws the
// compiled asset in the light appearance.
//
//   node scripts/render-app-icons.cjs

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

if (process.platform !== "darwin") throw new Error("Rendering App icons requires macOS with Xcode 26+");
const root = path.resolve(__dirname, "..");
const ICONS = [
  { id: "shoggoth-ip", source: "build/shoggoth-ip.icon" },
  { id: "shoggoth-logo", source: "build/shoggothappicon.icon" },
];
const OUTPUTS = [
  { dir: "app/assets/app-icons", size: 1024 }, // Dock and Finder
  { dir: "app/manage-ui/src/assets/app-icons", size: 128 }, // Settings thumbnails
];

const RENDER_SWIFT = `
import AppKit
let args = CommandLine.arguments
guard let image = Bundle(path: args[1])?.image(forResource: "Icon") else { exit(2) }
for spec in args.dropFirst(2) {
  let parts = spec.split(separator: ":", maxSplits: 1)
  let size = Int(parts[0])!
  let ctx = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
    space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  NSAppearance(named: .aqua)!.performAsCurrentDrawingAppearance {
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: false)
    image.draw(in: NSRect(x: 0, y: 0, width: size, height: size))
    NSGraphicsContext.restoreGraphicsState()
  }
  let png = NSBitmapImageRep(cgImage: ctx.makeImage()!).representation(using: .png, properties: [:])!
  try! png.write(to: URL(fileURLWithPath: String(parts[1])))
}
`;

const work = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-app-icons-"));
try {
  const swiftFile = path.join(work, "render.swift");
  fs.writeFileSync(swiftFile, RENDER_SWIFT);
  for (const output of OUTPUTS) fs.mkdirSync(path.join(root, output.dir), { recursive: true });
  for (const icon of ICONS) {
    const dir = path.join(work, icon.id);
    const compiled = path.join(dir, "out");
    fs.mkdirSync(compiled, { recursive: true });
    fs.cpSync(path.join(root, icon.source), path.join(dir, "Icon.icon"), { recursive: true });
    // Same actool arguments as electron-builder's Icon Composer path.
    execFileSync("/usr/bin/xcrun", ["actool", path.join(dir, "Icon.icon"), "--compile", compiled,
      "--output-format", "human-readable-text", "--notices", "--warnings",
      "--output-partial-info-plist", path.join(compiled, "partial.plist"), "--app-icon", "Icon",
      "--include-all-app-icons", "--enable-on-demand-resources", "NO", "--development-region", "en",
      "--target-device", "mac", "--minimum-deployment-target", "26.0", "--platform", "macosx"], { stdio: "ignore" });
    const bundle = path.join(dir, "Render.app");
    fs.mkdirSync(path.join(bundle, "Contents/Resources"), { recursive: true });
    fs.copyFileSync(path.join(compiled, "Assets.car"), path.join(bundle, "Contents/Resources/Assets.car"));
    // NSBundle only reads the asset catalog of a bundle that has an Info.plist.
    fs.writeFileSync(path.join(bundle, "Contents/Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>ai.shoggoth.icon-render.${icon.id}</string>
<key>CFBundleIconName</key><string>Icon</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>
`);
    execFileSync("/usr/bin/swift", [swiftFile, bundle,
      ...OUTPUTS.map(output => `${output.size}:${path.join(root, output.dir, `${icon.id}.png`)}`)], { stdio: "inherit" });
    console.log(`rendered ${icon.id}`);
  }
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
