"use strict";

// node scripts/generate-tray-icon.cjs
// Rasterize the supplied vector with Chromium so nativeImage can load it from
// both source and app.asar without needing an SVG decoder or a UI build.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

if (!process.versions.electron) {
  const { spawnSync } = require("node:child_process");
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-tray-artwork-"));
  try {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = spawnSync(require("electron"), [__filename, profile], { env, stdio: "inherit", timeout: 20_000 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Tray artwork generation failed: ${result.signal || result.status}`);
  } finally { fs.rmSync(profile, { recursive: true, force: true }); }
} else {
  const { app, BrowserWindow } = require("electron");
  app.setPath("userData", process.argv[2]);
  app.whenReady().then(async () => {
    const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
    try {
      const directory = path.resolve(__dirname, "../app/assets/tray");
      const svg = fs.readFileSync(path.join(directory, "shoggoth.svg"), "utf8");
      await window.loadURL("about:blank");
      for (const scale of [1, 2]) {
        const dataUrl = await window.webContents.executeJavaScript(`(async () => {
          const image = new Image();
          image.src = ${JSON.stringify(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`)};
          await image.decode();
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = ${14 * scale};
          canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
          return canvas.toDataURL("image/png");
        })()`);
        const file = path.join(directory, scale === 1 ? "shoggoth.png" : "shoggoth@2x.png");
        fs.writeFileSync(file, Buffer.from(dataUrl.split(",")[1], "base64"));
        console.log(`Generated ${path.basename(file)} (${14 * scale}px)`);
      }
    } finally { window.destroy(); }
    app.quit();
  }).catch(error => { console.error(error); app.exit(1); });
}
