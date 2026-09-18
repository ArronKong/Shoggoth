"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");

const root = path.resolve(__dirname, "..");
const uiRequire = createRequire(path.join(root, "app/manage-ui/package.json"));
const ts = uiRequire("typescript");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-avatar-unit-"));
// Static-server captures only the avatar/media roots here; do not touch the real store.
const homedir = os.homedir;
let startStaticServer;
try {
  os.homedir = () => home;
  ({ startStaticServer } = require("../app/static-server"));
} finally { os.homedir = homedir; }
const ui = { exports: {} };
const source = path.join(root, "app/manage-ui/src/lib/avatar-background.ts");
vm.runInNewContext(ts.transpileModule(fs.readFileSync(source, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, {
  exports: ui.exports, module: ui,
  require: name => {
    assert.ok(name.endsWith(".webp"));
    assert.ok(fs.existsSync(path.resolve(path.dirname(source), name)));
    return name;
  },
});

(async () => {
  const server = await startStaticServer(0, { homeDir: home });
  try {
    const selected = new Set();
    for (const id of ["hermes-owl", "中文", "&test", ...Array.from({ length: 60 }, (_, i) => `agent-${i}`)]) {
      const response = await fetch(`${server.url}/avatar/${encodeURIComponent(id)}`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type"), /image\/svg\+xml/);
      const svg = await response.text();
      assert.doesNotMatch(svg, /clip-path|<clipPath|<circle/, "square agent cards must receive the full texture; round views crop it themselves");
      const encoded = svg.match(/href="data:image\/webp;base64,([A-Za-z0-9+/=]+)"/)[1];
      const image = ui.exports.agentAvatarStyle(id)["--ui-agent-avatar-bg"].match(/texture-\d+\.webp/)[0];
      selected.add(image);
      const asset = path.join(root, "app/manage-ui/src/assets/avatar-backgrounds", image);
      assert.deepEqual(Buffer.from(encoded, "base64"), fs.readFileSync(asset), "HTTP and UI must choose the same background");
      assert.equal(await (await fetch(`${server.url}/avatar/${encodeURIComponent(id)}?v=2`)).text(), svg,
        "refreshing an avatar must not reshuffle its texture");
      assert.match(svg, /fill="#ffffff"/);
      if (id === "&test") assert.match(svg, />&amp;<\/text>/);
      if (id === "hermes-owl") assert.match(svg, />O<\/text>/);
    }
    assert.equal(selected.size, 17, "the provided collection is fully available");
    const avatarDir = path.join(home, "Library/Application Support/Shoggoth/agent-avatars");
    fs.mkdirSync(avatarDir, { recursive: true });
    const photo = fs.readFileSync(path.join(root, "app/manage-ui/src/assets/avatar-backgrounds/texture-01.webp"));
    fs.writeFileSync(path.join(avatarDir, "uploaded.webp"), photo);
    const response = await fetch(`${server.url}/avatar/uploaded`);
    assert.equal(response.headers.get("content-type"), "image/webp");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), photo, "uploaded images must be served unchanged");
    assert.equal((await fetch(`${server.url}/avatar/invalid%2Fid`)).status, 404);
    console.log("PASS default avatars: 17 square textures, HTTP/UI parity, stable reloads, escaped initials, uploaded images unchanged");
  } finally { await server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => fs.rmSync(home, { recursive: true, force: true }));
