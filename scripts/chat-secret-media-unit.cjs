"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { TemporarySecretStore } = require("../app/agent-service/temporary-secret-store");
const { SecretMediaMediator, replacedRanges, inspectMedia } = require("../app/agent-service/secret-media-mediator");
const SCOPE = { profileId: "fixture-agent", sessionId: "fixture-session" };
const REF = "{{SHOGGOTH_SECRET_0123456789abcdef0123456789abcdef}}";
test("pixel ranges include cross-line values and fail closed for unalignable projections", () => {
  assert.deepEqual(replacedRanges("Password:\n123456\nreceipt", `Password:\n${REF}\nreceipt`), [{ start: 10, end: 16 }]);
  assert.deepEqual(replacedRanges("prefix raw tail", "unexpected transformation"), [{ start: 0, end: 15 }]);
  assert.deepEqual(replacedRanges("same", "same"), []);
});
async function fixture(action) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-media-unit-"));
  const paths = { stateDir: path.join(root, "state"), trustedRoot: root };
  const key = crypto.randomBytes(32); let now = new Date(2026, 9, 29, 12).getTime();
  const broker = { encrypt: async raw => { const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const bytes = Buffer.concat([cipher.update(raw), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), bytes]); },
  decrypt: async raw => { const cipher = crypto.createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12)); cipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([cipher.update(raw.subarray(28)), cipher.final()]); } };
  const secrets = await new TemporarySecretStore({ paths, cryptoBroker: broker, now: () => now }).open();
  const file = path.join(root, "original.txt"); fs.writeFileSync(file, "Password: 123456\nPublic receipt remains"); fs.chmodSync(file, 0o600);
  const attachment = { id: crypto.randomUUID(), name: "original.txt", mimeType: "text/plain", size: fs.statSync(file).size };
  const media = { assertAvailable: () => {}, materialize: () => file };
  try { await action({ paths, secrets, file, media, attachment, setNow: value => { now = value; } }); }
  finally { await secrets.close(); fs.rmSync(root, { recursive: true, force: true }); }
}
test("text copies and retries are scoped, preserve originals and cannot resurrect expired credentials", async () => fixture(async ({ paths, secrets, file, media, attachment, setNow }) => {
  const mediator = new SecretMediaMediator({ paths, secrets });
  const original = fs.readFileSync(file);
  const safe = await mediator.prepare(SCOPE, attachment, media);
  assert(!fs.readFileSync(safe.path, "utf8").includes("123456")); assert(safe.extractedText.includes("Public receipt remains"));
  assert.deepEqual(fs.readFileSync(file), original);
  const other = await mediator.prepare({ ...SCOPE, sessionId: "another" }, attachment, media);
  assert.notEqual(other.path, safe.path); assert.notEqual(other.extractedText, safe.extractedText);
  const records = secrets.list(SCOPE); assert.equal(records.length, 1);
  setNow(records[0].expiresAt + 1); await secrets.expire();
  assert.deepEqual(await mediator.prepare(SCOPE, attachment, media), safe);
  assert.equal(secrets.list(SCOPE).length, 0);
}));
test("changed descriptors, tampered copies and processing failure never return original paths", async () => fixture(async ({ paths, secrets, media, attachment }) => {
  const mediator = new SecretMediaMediator({ paths, secrets });
  const safe = await mediator.prepare(SCOPE, attachment, media);
  assert.throws(() => mediator.read(SCOPE, { ...attachment, name: "changed.txt" }), { code: "SECRET_MEDIA_UNAVAILABLE" });
  fs.writeFileSync(safe.path, "tampered");
  assert.throws(() => mediator.read(SCOPE, attachment), { code: "SECRET_MEDIA_UNAVAILABLE" });
  await assert.rejects(mediator.prepare(SCOPE, { ...attachment, id: crypto.randomUUID(), name: "photo.png", mimeType: "image/png" }, media), { code: "SECRET_MEDIA_UNAVAILABLE" });
}));
test("a newly known value permanently retires the older cached copy across revocation and restart", async () => fixture(async ({ paths, secrets, media, attachment, file }) => {
  fs.writeFileSync(file, "Public opaque-value here"); attachment.size = fs.statSync(file).size;
  const mediator = new SecretMediaMediator({ paths, secrets });
  const first = await mediator.prepare(SCOPE, attachment, media); assert(first.extractedText.includes("opaque-value"));
  await secrets.prepare({ scope: SCOPE, operationId: "later", text: "password: opaque-value" });
  const next = mediator.read(SCOPE, attachment);
  assert(!fs.readFileSync(next.path, "utf8").includes("opaque-value")); assert.notEqual(first.path, next.path);
  assert.equal(fs.existsSync(first.path), false);
  await secrets.revoke(SCOPE); await secrets.close(); await secrets.open();
  const restored = new SecretMediaMediator({ paths, secrets }).read(SCOPE, attachment);
  assert.deepEqual(restored, next); assert(!fs.readFileSync(restored.path, "utf8").includes("opaque-value"));
  assert(fs.readFileSync(file, "utf8").includes("opaque-value"), "the user-owned original is preserved");
  // Simulate a crash after the safe receipt committed but before old-copy removal.
  fs.writeFileSync(first.path, "Public opaque-value here", { mode: 0o600 });
  assert.deepEqual(mediator.read(SCOPE, attachment), next); assert.equal(fs.existsSync(first.path), false);
}));
test("image projection uses full-input offsets even when a credential has already expired after interrupted rendering", async () => fixture(async ({ paths, secrets, media, attachment, setNow }) => {
  const image = { ...attachment, name: "fixture.png", mimeType: "image/png" };
  await secrets.prepare({ scope: SCOPE, operationId: `attachment-v1:${image.id}`, text: "Password:\n123456\nReceipt remains\n" });
  const expiresAt = secrets.list(SCOPE)[0].expiresAt; setNow(expiresAt + 1); await secrets.expire();
  let masks;
  const mediator = new SecretMediaMediator({ paths, secrets, binary: "/fixture/helper", inspect: async ({ project }) => {
    const result = await project({ pages: [["Password:", "123456", "Receipt remains"].map(text => ({ text }))], transcript: "" });
    masks = result.masks; return { text: result.text, mimeType: "text/plain", data: Buffer.alloc(0) };
  } });
  const safe = await mediator.prepare(SCOPE, image, media);
  assert.deepEqual(masks, [[1]]); assert(!safe.extractedText.includes("123456")); assert.equal(secrets.list(SCOPE).length, 0);
}));
test("missing native processor is a local failure with no raw content in diagnostics", async () => {
  assert.equal(new SecretMediaMediator({ binary: "/nonexistent/shoggoth-media-fixture" }).supportsImages(), false);
  assert.equal(new SecretMediaMediator({ binary: process.execPath }).supportsImages(), true);
  await assert.rejects(inspectMedia({ binary: "/nonexistent/shoggoth-media-fixture", source: "/fixture-secret-source",
    mimeType: "image/png", project: () => { throw new Error("must not run"); } }), { code: "SECRET_MEDIA_UNAVAILABLE" });
});
