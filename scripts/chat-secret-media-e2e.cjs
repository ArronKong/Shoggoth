"use strict";
// Uses the real Apple Vision/PDFKit helper and synthetic input only.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { TemporarySecretStore } = require("../app/agent-service/temporary-secret-store");
const { SecretMediaMediator, inspectMedia } = require("../app/agent-service/secret-media-mediator");
const { ComputerUseController } = require("../app/agent-service/computer-use-controller");
const { resolveServicePaths } = require("../app/agent-service/paths");
// Exercise the same native thumbnail encoder used by the Service. Plain Node
// has no nativeImage; silently replacing that encoder would miss its size and
// pixel transformations.
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  execFileSync(require("electron"), [__filename, ...process.argv.slice(2)], { env, stdio: "inherit", timeout: 120_000 });
  process.exit(0);
}
const { app, nativeImage } = require("electron");
const { createComputerImageTransformer } = require("../app/agent-service");
const root = fs.realpathSync(fs.mkdtempSync("/private/tmp/sg-secret-media-"));
app.setPath("userData", path.join(root, "electron-profile"));
const evidence = path.resolve(process.argv[2] || ".artifacts/chat-secret-continuation-20261029/local-media");
const binary = path.join(evidence, "shoggoth-secret-media");
const scope = { profileId: "synthetic-agent", sessionId: "synthetic-session" };
let secrets, desktop;
async function main() {
  const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "state"),
    profileRoot: path.join(root, "profile"), cacheRoot: path.join(root, "cache") });
  secrets = await new TemporarySecretStore({ paths,
    cryptoBroker: { encrypt: async bytes => Buffer.from(bytes).reverse(), decrypt: async bytes => Buffer.from(bytes).reverse() } }).open();
  const mediator = new SecretMediaMediator({ paths, secrets, binary });
  const results = [];
  for (const [extension, mimeType] of [["png", "image/png"], ["pdf", "application/pdf"]]) {
    const original = path.join(root, `original.${extension}`);
    fs.copyFileSync(path.join(evidence, `fixture.${extension}`), original); fs.chmodSync(original, 0o600);
    const before = fs.readFileSync(original);
    const attachment = { id: crypto.randomUUID(), name: `fixture.${extension}`, mimeType, size: before.length };
    const safe = await mediator.prepare(scope, attachment, { assertAvailable() {}, materialize: () => original });
    assert(!safe.extractedText.includes("123456")); assert(safe.extractedText.includes("Public receipt"));
    assert(safe.extractedText.includes("7654321"));
    assert.deepEqual(fs.readFileSync(original), before);
    let recognized;
    await inspectMedia({ binary, source: safe.path, mimeType: safe.mimeType, project: async value => {
      recognized = value.pages.flatMap(page => page.map(block => block.text)).join("\n");
      return { text: recognized, masks: value.pages.map(() => []) };
    } });
    assert(!recognized.includes("123456"), "redacted pixels must not retain the credential");
    assert(recognized.includes("Public receipt")); assert(recognized.includes("7654321"));
    fs.copyFileSync(safe.path, path.join(evidence, `safe.${extension}`));
    results.push({ mimeType, safeType: safe.mimeType, textProtected: true, pixelsProtected: true, publicTextPreserved: true });
  }
  const inline = await mediator.projectInline(scope, { mimeType: "image/png", data: fs.readFileSync(path.join(evidence, "fixture.png")).toString("base64") });
  assert.equal(inline.mimeType, "image/png"); assert(!inline.text.includes("123456"));
  const fixtureBytes = fs.readFileSync(path.join(evidence, "fixture.png"));
  const checkPixels = async (bytes, mimeType = "image/png") => {
    let recognized;
    await inspectMedia({ binary, data: bytes.toString("base64"), mimeType, project: async value => {
      recognized = value.pages.flatMap(page => page.map(block => block.text)).join("\n");
      return { text: recognized, masks: value.pages.map(() => []) };
    } });
    assert(!recognized.includes("123456")); assert(recognized.includes("Public receipt")); assert(recognized.includes("7654321"));
  };
  const mcp = await mediator.projectResult(scope, { content: [{ type: "image", mimeType: "image/png", data: fixtureBytes.toString("base64") },
    { type: "text", text: "Public receipt; password: 123456" }] }, { keys: true });
  assert.equal(mcp.content[0].type, "image"); await checkPixels(Buffer.from(mcp.content[0].data, "base64"));
  assert(!mcp.content[1].text.includes("123456"));
  const driver = { async metadata() { return { driverVersion: "0.22.0", contractVersion: "0.7.0", embedded: true, pid: 987 }; },
    async startSession() { return { active: true }; }, async endSession() { return { active: false }; }, async shutdown() {},
    async callTool(name, json) {
      const args = JSON.parse(json); let value = {}, images = [];
      if (name === "list_apps") value = { apps: [{ name: "Fixture", bundle_id: "com.example.fixture", pid: 42, running: true, active: false }] };
      if (name === "list_windows") value = { windows: [{ app_name: "Fixture", pid: 42, window_id: 7, title: "Fixture", bounds: { x: 0, y: 0, width: 1200, height: 400 }, is_on_screen: true }] };
      if (name === "get_window_state") {
        assert.equal(args.include_screenshot, true);
        value = { snapshot_id: "snapshot-fixture", tree_markdown: "Public receipt; password: 123456", elements: [] };
        images = [{ mimeType: "image/png", dataBase64: fixtureBytes.toString("base64") }];
      }
      return { isError: false, degraded: false, images, structuredJson: JSON.stringify(value), action: { effect: 0, route: 0 } };
    } };
  const factory = { new: value => value };
  desktop = new ComputerUseController({ paths, binaryPath: path.join(root, "fixture-driver"),
    binaryManifest: { version: "0.22.0", contractVersion: "0.7.0" }, verifyBinary: false,
    sdkLoader: async () => ({ CuaDriver: { createPrivateWorker: () => driver }, RuntimeAuthorizationOptions: factory,
      ConfiguredDriverOptions: factory, PrivateWorkerOptions: factory, EmbeddedEnvironmentVariable: factory,
      StartSessionInput: factory, EndSessionInput: factory, SessionPermissionMode: { Bounded: 1 },
      currentMacOsPermissionStatus: () => ({ accessibility: true, screenRecording: true }) }),
    isAuthorized: () => true, permissionStatus: () => ({ accessibility: true, screenRecording: true }),
    getSystemIdleTime: () => 100, isScreenLocked: () => false,
    imageTransformer: createComputerImageTransformer(nativeImage) });
  desktop.open();
  const session = await desktop.create({ profileId: scope.profileId, workRunId: "desktop-run", allowedApplications: ["com.example.fixture"] });
  const binding = { sessionId: session.id, profileId: scope.profileId, workRunId: "desktop-run", pid: 42, windowId: 7 };
  const snapshot = await desktop.snapshot(binding, { projectImage: value => mediator.projectInline(scope, value) });
  assert(snapshot.image); await checkPixels(Buffer.from(snapshot.image.thumbnail, "base64"), snapshot.image.thumbnailMimeType);
  await checkPixels(fs.readFileSync(path.join(paths.computerArtifactsDir, snapshot.image.artifact.storageKey)));
  const projected = await mediator.projectResult(scope, snapshot);
  assert(!projected.tree.includes("123456")); await checkPixels(Buffer.from(projected.image.thumbnail, "base64"));
  const fallback = await desktop.snapshot(binding, { projectImage: async () => { throw Error("unavailable fixture"); } });
  assert.equal(fallback.image, null); assert(fallback.tree.includes("Public receipt"));
  const files = fs.readdirSync(paths.computerArtifactsDir, { recursive: true }).filter(file => /\.(png|jpg)$/u.test(file));
  assert.equal(files.length, 1, "failed media processing cannot persist an unprocessed screenshot");
  await desktop.close(); desktop = null;
  const capabilities = JSON.parse(execFileSync(binary, [], { input: '{"action":"capabilities"}\n', encoding: "utf8" }));
  const result = { pass: true, helper: "real Apple Vision/PDFKit", results, inlineImage: true,
    mcpImagePixels: true, desktopSavedPixels: true, desktopModelPixels: true, desktopFailureTextFallback: true,
    speechAuthorized: capabilities.speechAuthorized, speechOnDevice: capabilities.speechOnDevice };
  fs.writeFileSync(path.join(evidence, "acceptance.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}
app.whenReady().then(() => { app.dock?.hide(); return main(); }).catch(error => { console.error(error.stack); process.exitCode = 1; })
  .finally(async () => { await desktop?.close(); await secrets?.close(); fs.rmSync(root, { recursive: true, force: true }); app.exit(process.exitCode || 0); });
