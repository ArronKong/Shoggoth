#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { GogGmailRuntime, verifiedGogBinary, gogPayloadDigest, readSelectedDesktopClient } =
  require("../app/agent-service/plugin-gogcli-gmail-runtime");
const { READ_TOOLS, ORDINARY_WRITE_TOOLS, SEND_TOOLS, DELETE_TOOLS } =
  require("../app/agent-service/plugin-gogcli-gmail-sidecar");
const { verifyPackagedGogSource, verifySignedPackagedGog } =
  require("./adhoc-sign.cjs");

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-gmail-unit-"));
  try {
    const calls = [];
    const runtime = new GogGmailRuntime({ paths: { trustedRoot: root,
      pluginsDir: path.join(root, "plugins") }, repoRoot: path.join(__dirname, ".."),
      run: async (binary, args, options) => { calls.push({ binary, args, options }); return "{}"; } });
    assert.equal(runtime.status().runtimeAvailable, true);
    assert.equal(runtime.status().configured, false);
    assert.deepEqual([...runtime.allowedTools()], READ_TOOLS);
    assert.throws(() => runtime.launch("test@example.com"), { code: "GMAIL_AUTH_INVALID" });

    const web = path.join(root, "web.json");
    fs.writeFileSync(web, JSON.stringify({ web: { client_id: "bad" } }), { mode: 0o600 });
    assert.throws(() => readSelectedDesktopClient(web), { code: "GMAIL_REGISTRATION_INVALID" });
    const desktop = path.join(root, "desktop.json");
    fs.writeFileSync(desktop, JSON.stringify({ installed: {
      client_id: "unit.apps.googleusercontent.com", client_secret: "unit-secret",
      redirect_uris: ["http://localhost"],
    } }), { mode: 0o600 });
    let finishImport;
    runtime.run = async (binary, args, options) => {
      calls.push({ binary, args, options });
      return new Promise(resolve => { finishImport = resolve; });
    };
    const firstImport = runtime.configure({ credentialsPath: desktop });
    assert.equal(typeof finishImport, "function");
    await assert.rejects(runtime.configure({ credentialsPath: desktop }),
      { code: "GMAIL_REGISTRATION_CONFLICT" });
    finishImport("{}");
    await firstImport;
    runtime.run = async (binary, args, options) => {
      calls.push({ binary, args, options });
      if (args.includes("auth") && args.includes("list")) return JSON.stringify({ accounts: [] });
      return args.includes("auth") && args.includes("add")
        ? JSON.stringify({ stored: true, email: "test@example.com",
          services: ["gmail"], client: "shoggoth" }) : "{}";
    };
    assert.equal(runtime.status().configured, true);
    assert.equal(runtime.status().restartRequired, false);
    assert(calls[0].args.includes("--client=shoggoth"));
    assert.deepEqual(calls[0].args.slice(-4), ["auth", "credentials", "set", "-"]);
    assert.equal(calls[0].options.input.toString("utf8"), fs.readFileSync(desktop, "utf8"));
    await assert.rejects(runtime.configure({ credentialsPath: desktop }), { code: "GMAIL_REGISTRATION_CONFLICT" });

    await runtime.authorize("test@example.com");
    assert(calls[1].args.includes("--json"));
    assert.deepEqual(calls[1].args.slice(-2), ["auth", "list"]);
    assert(calls[2].args.includes("--services=gmail"));
    assert(calls[2].args.includes("--gmail-scope=full"));
    assert.deepEqual(calls[3].args.slice(-3), ["gmail", "labels", "list"]);
    assert.equal(runtime.hasPendingAuthorization(), true);
    assert.deepEqual(runtime.pendingAuthorization(), { email: "test@example.com", client: "shoggoth" });
    assert.throws(() => runtime.launch("test@example.com"),
      { code: "GMAIL_AUTH_RECOVERY_REQUIRED" });
    runtime.commitAuthorization("test@example.com");
    assert.equal(runtime.hasPendingAuthorization(), false);
    assert.equal(runtime.pendingAuthorization(), null);
    assert.throws(() => runtime.configureCapabilities({ expectedRevision: 1,
      writeEnabled: false, sendEnabled: true }), { code: "GMAIL_CAPABILITIES_INVALID" });

    const listTools = () => {
      const plan = runtime.launch("test@example.com");
      const result = spawnSync(plan.command, [...plan.args, "--list-tools"], {
        cwd: plan.cwd, encoding: "utf8", timeout: 5_000,
        env: { HOME: process.env.HOME || "", PATH: "/usr/bin:/bin" },
      });
      assert.equal(result.status, 0, result.stderr);
      return { plan, names: JSON.parse(result.stdout).tools.map(tool => tool.name) };
    };
    const read = listTools();
    assert.deepEqual(new Set(read.names), new Set(READ_TOOLS));
    assert(read.plan.args.includes("--readonly"));
    assert(read.plan.args.includes("--gmail-no-send"));
    assert(!read.plan.args.includes("--allow-write"));
    assert(!read.plan.args.includes("--allow-gmail-delete"));

    const write = runtime.configureCapabilities({ expectedRevision: 1,
      writeEnabled: true, sendEnabled: false });
    assert.equal(write.revision, 2);
    const writeTools = listTools();
    assert.deepEqual(new Set(writeTools.names), new Set([...READ_TOOLS, ...ORDINARY_WRITE_TOOLS]));
    assert(writeTools.plan.args.includes("--allow-write"));
    assert(!writeTools.plan.args.includes("--allow-gmail-send"));
    assert.throws(() => runtime.configureCapabilities({ expectedRevision: 1,
      writeEnabled: false, sendEnabled: false }), { code: "REVISION_CONFLICT" });

    runtime.configureCapabilities({ expectedRevision: 2, writeEnabled: true, sendEnabled: true });
    const sendTools = listTools();
    assert.deepEqual(new Set(sendTools.names), new Set([...READ_TOOLS, ...ORDINARY_WRITE_TOOLS,
      ...SEND_TOOLS]));
    assert(sendTools.plan.args.includes("--allow-gmail-send"));
    assert(DELETE_TOOLS.every(name => !sendTools.names.includes(name)));

    // auth add can commit a refresh token before labels verification. Keep the
    // no-token recovery marker across every failure and across Service restart.
    const authFixture = async (name, initialAccounts = []) => {
      const trustedRoot = path.join(root, name);
      fs.mkdirSync(trustedRoot, { mode: 0o700 });
      const paths = { trustedRoot, pluginsDir: path.join(trustedRoot, "plugins") };
      const fixture = { accounts: [...initialAccounts], calls: [], addCalls: 0,
        listOutput: null, addOutput: null, labelsError: null };
      fixture.run = async (_binary, args) => {
        fixture.calls.push(args);
        if (args.includes("credentials")) return "{}";
        if (args.includes("auth") && args.includes("list")) {
          return fixture.listOutput ?? JSON.stringify({ accounts: fixture.accounts });
        }
        if (args.includes("auth") && args.includes("add")) {
          assert.equal(fs.existsSync(fixture.runtime.pendingAuthFile), true,
            "durable recovery marker must precede auth add");
          fixture.addCalls += 1;
          fixture.accounts.push({ email: "test@example.com", client: "shoggoth" });
          return fixture.addOutput ?? JSON.stringify({ stored: true, email: "test@example.com",
            services: ["gmail"], client: "shoggoth" });
        }
        if (args.includes("labels")) {
          if (fixture.labelsError) throw fixture.labelsError;
          return "{}";
        }
        throw new Error(`unexpected gog operation: ${args.join(" ")}`);
      };
      fixture.runtime = new GogGmailRuntime({ paths, repoRoot: path.join(__dirname, ".."),
        run: fixture.run });
      await fixture.runtime.configure({ credentialsPath: desktop });
      fixture.restart = () => new GogGmailRuntime({ paths,
        repoRoot: path.join(__dirname, ".."), run: fixture.run });
      return fixture;
    };
    const preexisting = await authFixture("preexisting", [
      { email: "test@example.com", client: "shoggoth" },
    ]);
    await assert.rejects(preexisting.runtime.authorize("test@example.com"),
      { code: "GMAIL_AUTH_RECOVERY_REQUIRED" });
    assert.equal(preexisting.addCalls, 0, "an existing token must not be overwritten");
    assert.equal(preexisting.runtime.hasPendingAuthorization(), false);
    const otherClient = await authFixture("other-client", [
      { email: "test@example.com", client: "other" },
    ]);
    await otherClient.runtime.authorize("test@example.com");
    otherClient.runtime.commitAuthorization("test@example.com");
    assert.equal(otherClient.addCalls, 1, "another client bucket is independent");

    const malformed = await authFixture("malformed-list");
    malformed.listOutput = JSON.stringify({ accounts: [{ email: "test@example.com" }] });
    await assert.rejects(malformed.runtime.authorize("test@example.com"),
      { code: "GMAIL_AUTH_RECOVERY_REQUIRED" });
    malformed.listOutput = JSON.stringify({ accounts: [
      { email: "test@example.com", client: "other" },
      { email: "TEST@example.com", client: "other" },
    ] });
    await assert.rejects(malformed.runtime.authorize("test@example.com"),
      { code: "GMAIL_AUTH_RECOVERY_REQUIRED" });
    assert.equal(malformed.addCalls, 0, "an uncertain account list must block auth add");

    const failedProbe = await authFixture("failed-probe");
    failedProbe.labelsError = Object.assign(new Error("labels unavailable"),
      { code: "GMAIL_AUTH_FAILED" });
    await assert.rejects(failedProbe.runtime.authorize("test@example.com"),
      { code: "GMAIL_AUTH_FAILED" });
    assert.equal(failedProbe.runtime.hasPendingAuthorization(), true);
    const marker = fs.readFileSync(failedProbe.runtime.pendingAuthFile, "utf8");
    assert.deepEqual(JSON.parse(marker), { version: 1, client: "shoggoth",
      email: "test@example.com" });
    assert.equal(fs.statSync(failedProbe.runtime.pendingAuthFile).mode & 0o077, 0);
    assert.throws(() => failedProbe.runtime.launch("test@example.com"),
      { code: "GMAIL_AUTH_RECOVERY_REQUIRED" });
    const restarted = failedProbe.restart();
    await assert.rejects(restarted.authorize("test@example.com"),
      { code: "GMAIL_AUTH_RECOVERY_REQUIRED" });
    assert.equal(failedProbe.addCalls, 1, "restart must not overwrite the residual token");
    await assert.rejects(restarted.reconcilePendingAuthorization("test@example.com"),
      { code: "GMAIL_AUTH_RECOVERY_REQUIRED" });
    // Simulate a human removing the exact test token outside the app. The next
    // explicit reconcile proves absence and permits a fresh authorization attempt.
    failedProbe.accounts.length = 0;
    failedProbe.labelsError = null;
    await assert.rejects(restarted.authorize("test@example.com"),
      { code: "GMAIL_AUTH_RECOVERY_REQUIRED" });
    assert.deepEqual(await restarted.reconcilePendingAuthorization("test@example.com"),
      { recovered: true });
    assert.deepEqual(await restarted.reconcilePendingAuthorization("test@example.com"),
      { recovered: false });
    await restarted.authorize("test@example.com");
    assert.equal(failedProbe.addCalls, 2);
    restarted.commitAuthorization("test@example.com");
    assert.equal(restarted.hasPendingAuthorization(), false);
    assert(failedProbe.calls.every(args => !args.includes("remove")),
      "the app must never auto-remove Keychain credentials");

    const mismatched = await authFixture("mismatched-subject");
    mismatched.addOutput = JSON.stringify({ stored: true, email: "wrong@example.com",
      services: ["gmail"], client: "shoggoth" });
    await assert.rejects(mismatched.runtime.authorize("test@example.com"),
      { code: "GMAIL_AUTH_FAILED" });
    assert.equal(mismatched.runtime.hasPendingAuthorization(), true);

    const concurrent = await authFixture("concurrent");
    const originalRun = concurrent.run;
    let finishList;
    concurrent.runtime.run = async (binary, args, options) => args.includes("auth")
      && args.includes("list") ? new Promise(resolve => { finishList = resolve; })
      : originalRun(binary, args, options);
    const firstAuthorization = concurrent.runtime.authorize("test@example.com");
    assert.equal(typeof finishList, "function");
    await assert.rejects(concurrent.runtime.authorize("test@example.com"),
      { code: "GMAIL_AUTH_CONFLICT" });
    finishList(JSON.stringify({ accounts: [] }));
    await firstAuthorization;
    concurrent.runtime.commitAuthorization("test@example.com");
    assert.equal(concurrent.addCalls, 1);

    // afterPack re-signs the upstream Mach-O. The signed file changes its full
    // SHA256, while the pinned executable payload remains byte-for-byte equal.
    if (process.arch === "arm64" && process.platform === "darwin") {
      const appPath = path.join(root, "Mock.app");
      const resources = path.join(appPath, "Contents", "Resources");
      const packaged = path.join(resources, "gogcli", "gog");
      fs.mkdirSync(path.dirname(packaged), { recursive: true });
      fs.copyFileSync(runtime.binary(), packaged);
      assert.equal(verifyPackagedGogSource(appPath, "arm64"), packaged);
      const signed = spawnSync("codesign", ["--force", "--options", "runtime",
        "--timestamp=none", "--sign", "-", packaged], { encoding: "utf8" });
      assert.equal(signed.status, 0, signed.stderr);
      assert.notEqual(fs.statSync(packaged).size, fs.statSync(runtime.binary()).size);
      assert.equal(gogPayloadDigest(fs.readFileSync(packaged), "arm64"),
        gogPayloadDigest(fs.readFileSync(runtime.binary()), "arm64"));
      assert.equal(verifiedGogBinary({ packaged: true, resourcesPath: resources }), packaged);
      assert.equal(verifySignedPackagedGog(appPath, "arm64"), packaged);
      const macos = path.join(appPath, "Contents", "MacOS");
      fs.mkdirSync(macos, { recursive: true });
      fs.copyFileSync("/usr/bin/true", path.join(macos, "Mock"));
      fs.writeFileSync(path.join(appPath, "Contents", "Info.plist"),
        '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>'
        + '<key>CFBundleExecutable</key><string>Mock</string>'
        + '<key>CFBundleIdentifier</key><string>com.example.Mock</string>'
        + '<key>CFBundleName</key><string>Mock</string>'
        + '<key>CFBundlePackageType</key><string>APPL</string></dict></plist>');
      const sha = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
      const beforeAppSign = sha(packaged);
      const outerSign = spawnSync("codesign", ["--force", "--deep", "--options", "runtime",
        "--timestamp=none", "--entitlements", path.join(__dirname, "..", "build", "entitlements.mac.plist"),
        "--sign", "-", appPath], { encoding: "utf8" });
      assert.equal(outerSign.status, 0, outerSign.stderr);
      assert.equal(sha(packaged), beforeAppSign);
      assert.equal(verifySignedPackagedGog(appPath, "arm64"), packaged);
      const signedBytes = fs.readFileSync(packaged);
      let commandOffset = 32, signatureOffset = null;
      for (let index = 0; index < signedBytes.readUInt32LE(16); index += 1) {
        if (signedBytes.readUInt32LE(commandOffset) === 0x1d) {
          signatureOffset = signedBytes.readUInt32LE(commandOffset + 8);
        }
        commandOffset += signedBytes.readUInt32LE(commandOffset + 4);
      }
      assert(Number.isSafeInteger(signatureOffset));
      const fd = fs.openSync(packaged, "r+");
      try {
        const byte = Buffer.alloc(1);
        fs.readSync(fd, byte, 0, 1, signatureOffset + 20);
        byte[0] ^= 0xff;
        fs.writeSync(fd, byte, 0, 1, signatureOffset + 20);
      }
      finally { fs.closeSync(fd); }
      assert.throws(() => verifiedGogBinary({ packaged: true, resourcesPath: resources }),
        { code: "GMAIL_RUNTIME_UNAVAILABLE" });
    }
    if (process.platform === "darwin") {
      const appPath = path.join(root, "X64Mock.app");
      const resources = path.join(appPath, "Contents", "Resources");
      const packaged = path.join(resources, "gogcli", "gog");
      fs.mkdirSync(path.dirname(packaged), { recursive: true });
      const source = verifiedGogBinary({ repoRoot: path.join(__dirname, ".."), arch: "x64" });
      fs.copyFileSync(source, packaged);
      assert.equal(verifyPackagedGogSource(appPath, "x64"), packaged);
      assert.equal(gogPayloadDigest(fs.readFileSync(source), "x64"),
        "ce415e234bfd3f15b0a3817e221f57be5686e05516dc21b1943e20836eb1f66e");
      const sign = spawnSync("codesign", ["--force", "--options", "runtime",
        "--timestamp=none", "--sign", "-", packaged], { encoding: "utf8" });
      assert.equal(sign.status, 0, sign.stderr);
      assert.equal(gogPayloadDigest(fs.readFileSync(packaged), "x64"),
        "ce415e234bfd3f15b0a3817e221f57be5686e05516dc21b1943e20836eb1f66e");
      assert.equal(verifySignedPackagedGog(appPath, "x64"), packaged);
    }
    console.log("gogcli Gmail runtime, fixed tool list and policy: PASS");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
