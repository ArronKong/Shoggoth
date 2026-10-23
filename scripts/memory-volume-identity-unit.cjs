"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createMemoryVolumeIdentityResolver, isVolumeIdentity } = require("../app/agent-service/shoggoth-memory/memory-volume-identity.cjs");
const uuid = "70da663d-64e9-42ea-8cc9-010fc82e4922";
function fixture({ device = "/dev/disk3s5", result = uuid, changeDuringRead = false, throws = false } = {}) {
  let dev = 17; const calls = [];
  const resolve = createMemoryVolumeIdentityResolver({ platform: "darwin",
    fs: { lstatSync: () => ({ dev }) },
    execFileSync(command, args, options) {
      calls.push({ command, args, options });
      if (throws) throw new Error("private diagnostic data");
      if (command === "/bin/df") return "Filesystem 1024-blocks Used Available Capacity Mounted on\n" + device + " 100 40 60 40% /Volumes/Volume With Spaces\n";
      if (command === "/usr/sbin/diskutil") return "<plist>volume</plist>";
      if (changeDuringRead) dev++;
      return result;
    } });
  return { resolve, calls, changeDevice: () => { dev++; } };
}
test("macOS resolves UUID using fixed commands and caches only the live device", () => {
  const f = fixture();
  assert.equal(f.resolve("/private/path with spaces"), "darwin-volume:" + uuid.toUpperCase());
  assert.equal(f.resolve("/private/other"), "darwin-volume:" + uuid.toUpperCase());
  assert.equal(f.calls.length, 3);
  assert.deepEqual(f.calls[0].args, ["-P", "/private/path with spaces"]);
  assert.deepEqual(f.calls[1].args, ["info", "-plist", "/dev/disk3s5"]);
  assert.equal(f.calls[2].options.input, "<plist>volume</plist>");
  assert.ok(f.calls.every(call => call.options.timeout === 2000 && call.options.maxBuffer === 65536));
  f.changeDevice(); f.resolve("/private/other"); assert.equal(f.calls.length, 6);
});
for (const [name, options] of Object.entries({
  "foreign filesystem": { device: "host:/export" }, "malformed UUID": { result: "not-a-volume" },
  "mount changed during lookup": { changeDuringRead: true }, "command failure": { throws: true }
})) test("volume lookup fails closed on " + name, () => {
  const f = fixture(options);
  assert.throws(() => f.resolve("/private/test"), error => error.code === "MEMORY_VOLUME_IDENTITY_UNAVAILABLE"
    && !error.message.includes("private diagnostic data"));
});
test("non-macOS retains strict live-device identity without invoking a command", () => {
  const resolve = createMemoryVolumeIdentityResolver({ platform: "linux", fs: { lstatSync: () => ({ dev: 71 }) },
    execFileSync() { assert.fail("unexpected command"); } });
  assert.equal(resolve("/private/test"), "device:71");
  for (const value of ["device:71", "darwin-volume:" + uuid.toUpperCase()]) assert.equal(isVolumeIdentity(value), true);
  for (const value of [null, {}, "darwin-volume:not-a-volume", "device:-1", "device:71extra", "darwin-volume:" + uuid]) {
    assert.equal(isVolumeIdentity(value), false);
  }
});
