#!/usr/bin/env node
"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { DESKTOP_PRESETS, desktopPreset, validateDesktopPreset } = require("../app/agent-service/mcp-desktop-presets");
const { NativeMcpStore } = require("../app/agent-service/native-mcp-store");
const { resolveServicePaths } = require("../app/agent-service/paths");

test("desktop exception requires the exact MCP entry point, arguments and Apple publisher", () => {
  for (const preset of DESKTOP_PRESETS) {
    const calls = [];
    const options = { platform: "darwin", spawnSync: (...args) => { calls.push(args); return { status: 0 }; } };
    validateDesktopPreset(preset.command, preset.args, "/resolved/vendor-executable", options);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0][1], ["--verify", "--strict", "--test-requirement", `=anchor apple generic and certificate leaf[subject.OU] = "${preset.team}"`, "/resolved/vendor-executable"]);
    assert.equal(calls[0][0], "/usr/bin/codesign"); assert.equal(calls[0][2].timeout, 20000);
    for (const args of [[...preset.args, "--other"], ["-c", "anything"]]) {
      assert.equal(desktopPreset(preset.command, args), undefined);
      assert.throws(() => validateDesktopPreset(preset.command, args, preset.command, options), { code: "MCP_SERVER_PATH_INVALID" });
    }
    for (const result of [{ status: 1 }, { status: null }, { status: 0, error: Error("timeout") }, undefined]) {
      assert.throws(() => validateDesktopPreset(preset.command, preset.args, preset.command, { ...options, spawnSync: () => result }), { code: "MCP_SERVER_PATH_INVALID" });
    }
    assert.throws(() => validateDesktopPreset(preset.command, preset.args, preset.command, { ...options, platform: "linux" }), { code: "MCP_SERVER_PATH_INVALID" });
  }
  assert.equal(desktopPreset("/Applications/Other.app/Contents/MacOS/tool", []), undefined);
  assert.equal(desktopPreset("/usr/local/bin/dayone", []), undefined);
  for (const command of ["/opt/homebrew/bin/1password-mcp", "/Users/fixture/.local/bin/1password-mcp"]) {
    const preset = desktopPreset(command, []); assert.equal(preset.team, "2BUA8C4S2C");
    assert.throws(() => validateDesktopPreset(command, [], command, { platform: "darwin", spawnSync: () => ({ status: 1 }) }), { code: "MCP_SERVER_PATH_INVALID" });
    assert.equal(desktopPreset(command, ["--execute", "anything"]), undefined);
  }
  assert.equal(desktopPreset("1password-mcp", []), undefined, "PATH resolution must happen before validation");
  assert.equal(desktopPreset("/opt/homebrew/bin/1password", []), undefined);
});

test("store validates signed presets again at launch and retains other executable and working-directory boundaries", t => {
  const root = fs.mkdtempSync("/private/tmp/shoggoth-desktop-mcp-"); fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state"), profileRoot: path.join(root, "profile"), cacheRoot: path.join(root, "cache") });
  fs.mkdirSync(paths.defaultWorkspaceDir, { recursive: true, mode: 0o700 });
  let trusted = true, missing = false, real = "/vendor/FantasticalMCP", validations = 0;
  const known = value => DESKTOP_PRESETS.some(preset => preset.command === value);
  const fileSystem = { ...fs,
    statSync(value) { if (!known(value)) return fs.statSync(value); if (missing) throw Error("missing"); return { isFile: () => true }; },
    realpathSync(value) { return known(value) ? real : fs.realpathSync(value); },
    accessSync(value, mode) { if (!known(value)) fs.accessSync(value, mode); },
  };
  const store = new NativeMcpStore({ paths, fs: fileSystem, validateDesktopPreset() { validations++; if (!trusted) throw Object.assign(Error(), { code: "MCP_SERVER_PATH_INVALID" }); } }).open();
  t.after(() => store.close());
  const preset = DESKTOP_PRESETS[0];
  const spec = { id: "desktop-fixture", name: "Desktop", enabled: true, source: { kind: "custom" },
    transport: { kind: "stdio-command", command: preset.command, args: [...preset.args], cwd: paths.defaultWorkspaceDir },
    auth: { kind: "none" }, secretRef: null, setup: { requiredFields: [], configuredFields: [] }, status: "ready", lastCheck: null, disabledProfileIds: [] };
  const prepared = store.prepare(spec); assert.equal(validations, 1);
  store.prepareLaunch(prepared); assert.equal(validations, 2);
  trusted = false; assert.throws(() => store.prepareLaunch(prepared), { code: "MCP_SERVER_PATH_INVALID" });
  trusted = true; missing = true; assert.throws(() => store.prepareLaunch(prepared), { code: "MCP_SERVER_PATH_INVALID" }); missing = false;
  real = "/bin/sh"; assert.throws(() => store.prepareLaunch(prepared), { code: "MCP_SERVER_COMMAND_FORBIDDEN" }); real = "/vendor/FantasticalMCP";
  for (const transport of [
    { ...spec.transport, command: "/Applications/Unrelated.app/Contents/MacOS/tool" },
    { ...spec.transport, args: ["unexpected"] },
    { ...spec.transport, cwd: "/private/tmp" },
  ]) assert.throws(() => store.prepare({ ...spec, transport }), { code: "MCP_SERVER_PATH_INVALID" });
  const localCommand = path.join(root, "1password-mcp"); fs.writeFileSync(localCommand, "#!/usr/bin/env node\n", { mode: 0o700 });
  const beforeLocal = validations;
  store.prepare({ ...spec, transport: { ...spec.transport, command: localCommand, args: [] } });
  assert.equal(validations, beforeLocal, "executables entirely inside the trusted root retain the existing local-command policy");
});
