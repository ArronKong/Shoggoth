#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { SystemHostController } = require("../app/agent-service/system-host-controller");

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function appBundle(root, directory, bundleId, name) {
  const target = path.join(root, directory);
  const contents = path.join(target, "Contents");
  fs.mkdirSync(contents, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(contents, "Info.plist"), JSON.stringify({
    CFBundleIdentifier: bundleId,
    CFBundleDisplayName: name,
  }), { mode: 0o600 });
  return target;
}

function localizedAppName(applicationPath, locale, name) {
  const directory = path.join(applicationPath, "Contents", "Resources", `${locale}.lproj`);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(directory, "InfoPlist.strings"), JSON.stringify({
    CFBundleDisplayName: name,
    CFBundleName: name,
  }), { mode: 0o600 });
}

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-system-host-")));
  fs.chmodSync(root, 0o700);
  const home = path.join(root, "home");
  const userApplications = path.join(home, "Applications");
  const systemApplications = path.join(root, "SystemApplications");
  fs.mkdirSync(userApplications, { recursive: true, mode: 0o700 });
  fs.mkdirSync(systemApplications, { recursive: true, mode: 0o700 });
  const calls = [];
  const host = {
    async openPath(target) { calls.push(["openPath", target]); return ""; },
    async openExternal(target) { calls.push(["openExternal", target]); return true; },
    async showItemInFolder(target) { calls.push(["showItemInFolder", target]); return true; },
  };
  const controller = new SystemHostController({
    host,
    platform: "darwin",
    homeDirectory: home,
    applicationRoots: [userApplications, systemApplications],
    folderRoots: [home],
    readPlist: (target) => JSON.parse(fs.readFileSync(target, "utf8")),
  });
  return {
    root, home, userApplications, systemApplications, calls, host, controller,
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); },
  };
}

test("应用搜索只返回受信任根中的规范 bundle，并稳定排序", () => {
  const value = fixture();
  try {
    appBundle(value.systemApplications, "Safari.app", "com.apple.Safari", "Safari");
    appBundle(value.userApplications, "Safari Technology Preview.app", "com.apple.SafariTechnologyPreview", "Safari Technology Preview");
    fs.symlinkSync(path.join(value.systemApplications, "Safari.app"), path.join(value.userApplications, "Linked.app"));
    assert.deepEqual(value.controller.search({ query: "safari", limit: 10 }), {
      applications: [
        { name: "Safari", bundleId: "com.apple.Safari", path: path.join(value.systemApplications, "Safari.app") },
        {
          name: "Safari Technology Preview",
          bundleId: "com.apple.SafariTechnologyPreview",
          path: path.join(value.userApplications, "Safari Technology Preview.app"),
        },
      ],
    });
  } finally { value.cleanup(); }
});

test("应用搜索匹配安全读取的本地化名称但仍返回规范 bundle 身份", () => {
  const value = fixture();
  try {
    const quark = appBundle(value.userApplications, "Quark.app", "com.quark.desktop", "Quark");
    localizedAppName(quark, "zh_CN", "夸克");
    const originalReadPlist = value.controller.readPlist;
    let readCount = 0;
    value.controller.readPlist = (target) => {
      readCount += 1;
      return originalReadPlist(target);
    };
    assert.deepEqual(value.controller.search({ query: "夸克", limit: 10 }), {
      applications: [{
        name: "Quark",
        bundleId: "com.quark.desktop",
        path: quark,
      }],
    });
    const firstReadCount = readCount;
    assert.equal(value.controller.search({ query: "Quark", limit: 10 }).applications.length, 1);
    assert.equal(readCount, firstReadCount, "短 TTL 内搜索必须复用只读 catalog");
  } finally { value.cleanup(); }
});

test("应用搜索不跟随本地化资源 symlink 或读取 hardlink", () => {
  const value = fixture();
  try {
    const quark = appBundle(value.userApplications, "Quark.app", "com.quark.desktop", "Quark");
    const outside = path.join(value.root, "outside-localized.plist");
    fs.writeFileSync(outside, JSON.stringify({ CFBundleDisplayName: "伪夸克" }), { mode: 0o600 });
    const linkedLocale = path.join(quark, "Contents", "Resources", "zh_CN.lproj");
    const hardlinkedLocale = path.join(quark, "Contents", "Resources", "zh_TW.lproj");
    fs.mkdirSync(linkedLocale, { recursive: true, mode: 0o700 });
    fs.mkdirSync(hardlinkedLocale, { recursive: true, mode: 0o700 });
    fs.symlinkSync(outside, path.join(linkedLocale, "InfoPlist.strings"));
    fs.linkSync(outside, path.join(hardlinkedLocale, "InfoPlist.strings"));
    assert.deepEqual(value.controller.search({ query: "伪夸克", limit: 10 }), { applications: [] });
    assert.equal(value.controller.search({ query: "Quark", limit: 10 }).applications.length, 1);
  } finally { value.cleanup(); }
});

test("应用启动支持精确 bundle/path，同一 bundle 多副本固定拒绝猜测", async () => {
  const value = fixture();
  try {
    const safari = appBundle(value.systemApplications, "Safari.app", "com.apple.Safari", "Safari");
    assert.equal((await value.controller.launch({ bundleId: "com.apple.Safari" })).launched, true);
    assert.equal((await value.controller.launch({ applicationPath: safari })).application.path, safari);
    assert.deepEqual(value.calls, [["openPath", safari], ["openPath", safari]]);
    appBundle(value.userApplications, "Safari Copy.app", "com.apple.Safari", "Safari Copy");
    await assert.rejects(
      () => value.controller.launch({ bundleId: "com.apple.Safari" }),
      (error) => error.code === "SYSTEM_APPLICATION_AMBIGUOUS",
    );
  } finally { value.cleanup(); }
});

test("URL 只允许无凭据 HTTP(S)，危险协议和宿主失败不伪报成功", async () => {
  const value = fixture();
  try {
    assert.deepEqual(await value.controller.openUrl({ url: "https://example.com/a?q=1" }), {
      url: "https://example.com/a?q=1",
      opened: true,
    });
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "https://user:pass@example.com/"]) {
      await assert.rejects(() => value.controller.openUrl({ url }),
        (error) => error.code === "SYSTEM_URL_FORBIDDEN");
    }
    value.host.openExternal = async () => "Launch Services rejected the URL";
    await assert.rejects(() => value.controller.openUrl({ url: "https://example.com/" }),
      (error) => error.code === "SYSTEM_HOST_FAILED");
  } finally { value.cleanup(); }
});

test("Finder 支持 ~/目录和直接子项选择，拒绝越界、symlink 与 hardlink", async () => {
  const value = fixture();
  try {
    const downloads = path.join(value.home, "Downloads");
    fs.mkdirSync(downloads, { mode: 0o700 });
    const selected = path.join(downloads, "report.txt");
    fs.writeFileSync(selected, "report", { mode: 0o600 });
    assert.deepEqual(await value.controller.openFolder({ path: "~/Downloads", select: "report.txt" }), {
      path: downloads,
      selected,
      opened: true,
    });
    assert.deepEqual(value.calls, [["openPath", downloads], ["showItemInFolder", selected]]);
    const outside = path.join(value.root, "outside");
    fs.mkdirSync(outside, { mode: 0o700 });
    await assert.rejects(() => value.controller.openFolder({ path: outside, select: null }),
      (error) => error.code === "SYSTEM_HOST_PATH_INVALID");
    fs.symlinkSync(outside, path.join(value.home, "escape"));
    await assert.rejects(() => value.controller.openFolder({ path: path.join(value.home, "escape"), select: null }),
      (error) => error.code === "UNSAFE_SYMLINK");
    fs.linkSync(selected, path.join(downloads, "linked.txt"));
    await assert.rejects(() => value.controller.openFolder({ path: downloads, select: "linked.txt" }),
      (error) => error.code === "UNSAFE_HARDLINK");
  } finally { value.cleanup(); }
});

test("非 macOS 平台固定 unavailable，不触碰 Host Adapter", async () => {
  const value = fixture();
  try {
    const controller = new SystemHostController({
      host: value.host,
      platform: "linux",
      homeDirectory: value.home,
      applicationRoots: [value.userApplications],
      folderRoots: [value.home],
      readPlist: () => ({}),
    });
    assert.throws(() => controller.search({ query: "Safari", limit: 10 }),
      (error) => error.code === "SYSTEM_HOST_UNSUPPORTED");
    assert.deepEqual(value.calls, []);
  } finally { value.cleanup(); }
});

test("真实 macOS Applications/Cryptex 根可只读发现 Safari", () => {
  if (process.platform !== "darwin") return;
  const controller = new SystemHostController({
    platform: "darwin",
    host: { openPath: async () => "", openExternal: async () => true, showItemInFolder: async () => true },
  });
  const result = controller.search({ query: "com.apple.Safari", limit: 5 });
  assert.equal(result.applications.some((application) => (
    application.bundleId === "com.apple.Safari" && path.isAbsolute(application.path)
  )), true);
});

(async () => {
  for (const { name, fn } of tests) {
    await fn();
    console.log(`PASS ${name}`);
  }
  console.log(`PASS shoggoth system host controller unit (${tests.length})`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
