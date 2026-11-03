"use strict";

// Settings → App icon. macOS has no switchable App icon like iOS alternate icons,
// so the choice is applied in two places:
//   - Dock and ⌘Tab while running: app.dock.setIcon (reverts when the App quits).
//   - Finder, Launchpad and the Dock while quit: NSWorkspace.setIcon on the .app.
//     It writes an `Icon\r` file plus FinderInfo into the bundle root. The code
//     signature hash is unchanged (TCC grants survive), but `codesign --strict`
//     reports the extra file, and an update replaces the bundle, so startup
//     restores a non-default choice.
// The default icon is the bundle's own icon, so choosing it removes the custom icon.
// macOS shows both icons as given, without the system mask: the PNGs are finished
// renderings from scripts/render-app-icons.cjs.

const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { APP_ICON_IDS, DEFAULT_APP_ICON } = require("./core/config-store");

const CUSTOM_ICON_FILE = "Icon\r";
// JXA bridges `undefined` to nil (clears the custom icon); `null` would become NSNull.
const SET_ICON_JXA = `function run(argv) {
  ObjC.import("AppKit");
  var image = undefined;
  if (argv[1]) {
    image = $.NSImage.alloc.initWithContentsOfFile(argv[1]);
    if (image.isNil()) return "missing-image";
  }
  return $.NSWorkspace.sharedWorkspace.setIconForFileOptions(image, argv[0], 0) ? "ok" : "failed";
}`;

// Packaged builds unpack these PNGs (electron-builder asarUnpack): NSWorkspace
// cannot read a file inside app.asar.
function appIconImagePath(iconId, baseDir = __dirname) {
  return path.join(baseDir, "assets", "app-icons", `${iconId}.png`)
    .replace(/([\\/])app\.asar([\\/])/u, "$1app.asar.unpacked$2");
}

// .../Shoggoth.app/Contents/MacOS/Shoggoth → .../Shoggoth.app
function appBundlePath(exePath) {
  const macos = path.dirname(exePath);
  const contents = path.dirname(macos);
  const bundle = path.dirname(contents);
  return path.basename(macos) === "MacOS" && path.basename(contents) === "Contents" && bundle.endsWith(".app")
    ? bundle : null;
}

function setBundleIconWithOsascript(bundle, imagePath) {
  return new Promise(resolve => {
    execFile("/usr/bin/osascript", ["-l", "JavaScript", "-e", SET_ICON_JXA, bundle, imagePath || ""],
      { timeout: 15000 }, (error, stdout) => resolve(!error && String(stdout).trim() === "ok"));
  });
}

function createAppIconController({ app, nativeImage, platform = process.platform,
  setBundleIcon = setBundleIconWithOsascript, fsImpl = fs, logger = console }) {
  let dockIcon = null;
  let finderIcon = null; // null until the first apply at startup
  let finderQueue = Promise.resolve();

  function applyDock(iconId) {
    if (dockIcon === iconId || typeof app.dock?.setIcon !== "function") return;
    const image = nativeImage.createFromPath(appIconImagePath(iconId));
    if (image.isEmpty()) return;
    app.dock.setIcon(image);
    dockIcon = iconId;
  }

  function applyFinder(iconId) {
    // Unpackaged runs use node_modules/electron's Electron.app: never touch it.
    const bundle = app.isPackaged ? appBundlePath(app.getPath("exe")) : null;
    if (!bundle || finderIcon === iconId) return finderQueue;
    const startup = finderIcon === null;
    finderIcon = iconId;
    const custom = iconId !== DEFAULT_APP_ICON;
    finderQueue = finderQueue.then(async () => {
      const hasCustom = fsImpl.existsSync(path.join(bundle, CUSTOM_ICON_FILE));
      // At startup only restore a missing non-default icon (an update replaced the
      // bundle); never strip a custom icon the user set in Finder themselves.
      if (startup ? !custom || hasCustom : !custom && !hasCustom) return;
      if (!await setBundleIcon(bundle, custom ? appIconImagePath(iconId) : "")) {
        logger.warn("[app-icon] Finder icon update failed; the Dock icon still follows the setting");
      }
    });
    return finderQueue;
  }

  function apply(iconId) {
    if (platform !== "darwin" || !APP_ICON_IDS.includes(iconId)) return Promise.resolve();
    applyDock(iconId);
    return applyFinder(iconId);
  }

  return { apply };
}

module.exports = { createAppIconController, appIconImagePath, appBundlePath, setBundleIconWithOsascript };
