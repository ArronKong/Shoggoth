"use strict";

// Exercise native image decoding and a real macOS status item from source and
// app.asar, using temporary profiles, in-memory preferences and no Agent service.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

if (!process.versions.electron) {
  const { spawnSync } = require("node:child_process");
  const { createPackage } = require("@electron/asar");
  const source = path.resolve(__dirname, "../app");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-tray-smoke-"));
  (async () => {
    try {
      const bundledApp = path.join(root, "bundle/app");
      fs.mkdirSync(path.join(bundledApp, "assets/tray"), { recursive: true });
      for (const file of ["desktop-inspiration-controller.js", "desktop-inspiration-shortcut.js",
        "assets/tray/shoggoth.png", "assets/tray/shoggoth@2x.png"]) {
        fs.copyFileSync(path.join(source, file), path.join(bundledApp, file));
      }
      const archive = path.join(root, "app.asar");
      await createPackage(path.join(root, "bundle"), archive);
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      for (const [phase, appDir] of [["source", source], ["packaged", path.join(archive, "app")]]) {
        const child = spawnSync(require("electron"), [__filename, "--fixture", path.join(root, phase), appDir], {
          env, encoding: "utf8", timeout: 20_000,
        });
        if (child.stdout) process.stdout.write(child.stdout);
        assert.equal(child.status, 0, `${phase}: ${child.stderr || child.error || child.signal}`);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  })().catch(error => { console.error(error); process.exitCode = 1; });
} else {
  const { app, BrowserWindow, Tray, Menu, nativeImage, screen, ipcMain } = require("electron");
  const at = process.argv.indexOf("--fixture");
  const profile = process.argv[at + 1], appDir = process.argv[at + 2];
  assert.ok(at > 0 && profile && appDir);
  app.setPath("userData", profile);
  app.setName("Shoggoth tray isolated test");
  app.on("window-all-closed", () => {});
  const { createDesktopInspirationController } = require(path.join(appDir, "desktop-inspiration-controller.js"));
  app.whenReady().then(async () => {
    let controller, main, tray;
    const shortcuts = new Map();
    try {
      main = new BrowserWindow({ show: false });
      controller = createDesktopInspirationController({ BrowserWindow,
        Tray: class extends Tray {
          constructor(image) {
            assert.equal(image.isEmpty(), false, "the menu bar image must decode in the packaged app");
            assert.deepEqual(image.getSize(), { width: 14, height: 14 });
            assert.equal(image.isTemplateImage(), false, "macOS must preserve the white artwork");
            assert.deepEqual(image.getScaleFactors(), [1, 2], "load crisp 1x and Retina artwork");
            for (const scaleFactor of image.getScaleFactors()) {
              const pixels = image.toBitmap({ scaleFactor });
              const alpha = pixels.filter((_, index) => index % 4 === 3);
              assert.ok(Math.abs(Math.max(...alpha) - 255 * 0.9) < 1, "white artwork has 90% opacity");
              assert.ok(alpha.filter(value => value === 0).length > alpha.length / 4, "the background is transparent");
              assert.equal(alpha[0], 0, "the top-left corner has no white square");
              for (let index = 0; index < pixels.length; index += 4) {
                // Native bitmaps are premultiplied BGRA; white has RGB = alpha.
                assert.equal(pixels[index], pixels[index + 3]);
                assert.equal(pixels[index + 1], pixels[index + 3]);
                assert.equal(pixels[index + 2], pixels[index + 3]);
              }
            }
            super(image);
            tray = this;
          }
        },
        Menu, nativeImage, screen, ipcMain,
        globalShortcut: { isRegistered: key => shortcuts.has(key), unregister: key => shortcuts.delete(key),
          register: (key, callback) => { shortcuts.set(key, callback); return true; } },
        configStore: { read: () => ({ inspirationShortcut: "Alt+S" }) },
        getMainWindow: () => main, showMainWindow: () => {
          if (main.isDestroyed()) main = new BrowserWindow({ show: false });
          if (main.isMinimized()) main.restore();
          main.show(); main.focus();
        },
        getUiOrigin: () => "http://127.0.0.1:18799", getLocale: () => "zh-CN", quit: () => app.quit(), stopBackend: async () => {},
      });
      await new Promise(resolve => setTimeout(resolve, 150));
      if (process.platform === "darwin") {
        const bounds = controller.getTrayBounds();
        assert.ok(bounds.width > 0 && bounds.height > 0, "macOS must allocate a menu bar status item");
      }
      tray.emit("click");
      assert.equal(main.isVisible(), true, "tray click shows the real main window");
      assert.equal(controller.getWindow(), null, "tray click must not create the printer");
      main.destroy();
      assert.equal(tray.isDestroyed(), false, "closing the main window keeps the menu bar entry available");
      tray.emit("click");
      assert.equal(main.isVisible(), true, "tray click reopens a closed main window");
      assert.equal(controller.getWindow(), null);
      controller.dispose(); controller = null;
      assert.equal(tray.isDestroyed(), true);
      assert.equal(shortcuts.size, 0);
      console.log(`PASS desktop inspiration tray (${path.basename(profile)}): 14pt transparent white 90% icon, Retina, status item, main-window reopen and cleanup`);
      app.quit();
    } finally {
      controller?.dispose();
      if (main && !main.isDestroyed()) main.destroy();
    }
  }).catch(error => { console.error(error); app.exit(1); });
}
