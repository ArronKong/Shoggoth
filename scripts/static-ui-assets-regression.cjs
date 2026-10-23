"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { spawnSync } = require("node:child_process");
const { UI_CONTENT_SECURITY_POLICY } = require("../app/ui-content-security");

const sourcePath = path.resolve(__dirname, "../app/static-server.js");
const assetName = "BackendTabIcon-Bf-JbzZp.js";
const assetBody = "export const icon = 'disk-full-regression';\n";
const htmlBody = '<!doctype html><div id="root">UI fixture</div>';

// Load the public server with an isolated __dirname so tests never modify the
// real UI build. All dependencies still resolve relative to the actual module.
function loadServer(appDirectory) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(sourcePath, "utf8"), {
    require: createRequire(sourcePath), module, exports: module.exports,
    __dirname: appDirectory, __filename: sourcePath,
    Buffer, URL, URLSearchParams, process, console, setTimeout, clearTimeout,
  }, { filename: sourcePath });
  return module.exports.startStaticServer;
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-ui-asset-read-"));
  const appDirectory = path.join(root, "app");
  const uiDirectory = path.join(appDirectory, "manage-ui/dist");
  const asset = path.join(uiDirectory, "assets", assetName);
  fs.mkdirSync(path.dirname(asset), { recursive: true });
  fs.writeFileSync(asset, assetBody);
  fs.writeFileSync(path.join(uiDirectory, "index.html"), htmlBody);
  return { root, appDirectory, uiDirectory, asset };
}

async function startFixture(t) {
  const fixture = createFixture();
  let server;
  t.after(async () => {
    await server?.close();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });
  server = await loadServer(fixture.appDirectory)(0, {
    homeDir: path.join(fixture.root, "home"),
    userDataRoot: path.join(fixture.root, "data"),
  });
  return { ...fixture, server };
}

async function read(base, route) {
  const response = await fetch(`${base}${route}`, { signal: AbortSignal.timeout(5000) });
  return { response, body: await response.text() };
}

async function electronFixture() {
  const { app } = require("electron");
  const root = process.argv[process.argv.indexOf("--asar-fixture") + 1];
  app.disableHardwareAcceleration();
  app.setPath("userData", path.join(root, "electron"));
  app.setPath("sessionData", path.join(root, "session"));
  const appDirectory = path.join(root, "ui.asar", "app");
  const asset = path.join(appDirectory, "manage-ui/dist/assets", assetName);
  let server;
  try {
    // The parent restricts only this process's file writes. Electron maps the
    // failed ASAR extraction to ENOENT even though stat/readFile still succeed.
    assert.equal(fs.statSync(asset).size, Buffer.byteLength(assetBody));
    const streamError = await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(asset);
      stream.on("error", resolve);
      stream.on("end", () => reject(new Error("Expected temporary extraction to fail")));
      stream.resume();
    });
    assert.equal(streamError.code, "ENOENT");
    assert.ok(streamError.message.includes(assetName));
    server = await loadServer(appDirectory)(0, {
      homeDir: path.join(root, "home"), userDataRoot: path.join(root, "data"),
    });
    const assetResult = await read(server.url, `/assets/${assetName}`);
    assert.equal(assetResult.response.status, 200);
    assert.equal(assetResult.body, assetBody);
    const pageResult = await read(server.url, "/agents");
    assert.equal(pageResult.body, htmlBody);
    assert.equal(pageResult.response.headers.get("content-security-policy"), UI_CONTENT_SECURITY_POLICY);
    console.log(JSON.stringify({ electron: process.versions.electron,
      temporaryExtractionError: streamError.code, assetStatus: assetResult.response.status,
      pageStatus: pageResult.response.status }));
  } finally {
    await server?.close();
  }
  app.exit(0);
}

if (process.versions.electron) {
  electronFixture().catch(error => { console.error(error); require("electron").app.exit(1); });
} else {
  const test = require("node:test");

  test("UI assets read without fs.open; MIME, SPA fallback and CSP are preserved", async t => {
    const f = await startFixture(t);
    const open = fs.open;
    let temporaryOpens = 0;
    fs.open = function (file, ...args) {
      if (file === f.asset) {
        temporaryOpens += 1;
        const error = Object.assign(new Error("Temporary ASAR extraction failed"), { code: "ENOENT" });
        process.nextTick(args.at(-1), error);
        return;
      }
      return open.call(this, file, ...args);
    };
    try {
      const { response, body } = await read(f.server.url, `/assets/${assetName}`);
      assert.equal(response.status, 200);
      assert.equal(body, assetBody);
      assert.equal(temporaryOpens, 0);
      assert.equal(response.headers.get("content-type"), "text/javascript; charset=utf-8");
      assert.equal(response.headers.get("content-length"), String(Buffer.byteLength(assetBody)));
      assert.equal(response.headers.get("cache-control"), "no-cache");
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      const fallback = await read(f.server.url, "/agents");
      assert.equal(fallback.response.status, 200);
      assert.equal(fallback.body, htmlBody);
      assert.equal(fallback.response.headers.get("content-security-policy"), UI_CONTENT_SECURITY_POLICY);
      assert.equal((await read(f.server.url, "/assets/missing.js")).response.status, 404);
    } finally {
      fs.open = open;
    }
  });

  for (const [code, status] of [["ENOENT", 404], ["ENOTDIR", 404], ["ENOSPC", 500], ["EIO", 500]]) {
    test(`UI read failure ${code} returns ${status} and the server stays available`, async t => {
      const f = await startFixture(t);
      const readFile = fs.readFile;
      fs.readFile = function (file, ...args) {
        if (file === f.asset) {
          process.nextTick(args.at(-1), Object.assign(new Error(`private path: ${file}`), { code }));
          return;
        }
        return readFile.call(this, file, ...args);
      };
      try {
        const failed = await read(f.server.url, `/assets/${assetName}`);
        assert.equal(failed.response.status, status);
        assert.equal(failed.response.headers.get("cache-control"), "no-store");
        assert.equal(failed.body, status === 404 ? "Not Found" : "Unable to read UI resource");
        assert.ok(!failed.body.includes(f.root));
      } finally {
        fs.readFile = readFile;
      }
      assert.equal((await read(f.server.url, `/assets/${assetName}`)).body, assetBody);
    });
  }

  test("Content-Length follows the bytes read when a file changes after stat", async t => {
    const f = await startFixture(t);
    const readFile = fs.readFile;
    const updated = `${assetBody}// replacement with a different length\n`;
    fs.readFile = function (file, ...args) {
      if (file === f.asset) fs.writeFileSync(file, updated);
      return readFile.call(this, file, ...args);
    };
    try {
      const { response, body } = await read(f.server.url, `/assets/${assetName}`);
      assert.equal(body, updated);
      assert.equal(response.headers.get("content-length"), String(Buffer.byteLength(updated)));
    } finally {
      fs.readFile = readFile;
    }
  });

  test("Electron serves packed UI when temporary ASAR extraction cannot write", {
    skip: process.platform !== "darwin", timeout: 20000,
  }, async () => {
    const f = createFixture();
    try {
      const asar = await import("@electron/asar");
      fs.mkdirSync(path.join(f.root, "electron"));
      fs.mkdirSync(path.join(f.root, "session"));
      await asar.createPackage(f.root, path.join(f.root, "ui.asar"));
      const electron = require("electron");
      const result = spawnSync("/bin/zsh", ["-c",
        'trap \'\' XFSZ\nulimit -f 0\nexec "$@"',
        "shoggoth-ui-read-test", electron, __filename, "--asar-fixture", f.root,
      ], { encoding: "utf8", timeout: 15000 });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const receipt = JSON.parse(result.stdout.trim().split("\n").at(-1));
      assert.equal(receipt.temporaryExtractionError, "ENOENT");
      assert.equal(receipt.assetStatus, 200);
      assert.equal(receipt.pageStatus, 200);
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });
}
