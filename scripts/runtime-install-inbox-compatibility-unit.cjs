"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createPackage } = require("@electron/asar");
const { assertInboxReaderCompatibility } = require("./runtime-install-inbox-compatibility.cjs");

const v1 = `const PENDING_COMMAND_INBOX_VERSION = 1;
function validateEnvelope(value) {
  if (!exactObject(value, ["version", "revision", "ciphertext"])
    || value.version !== PENDING_COMMAND_INBOX_VERSION
    || !Number.isSafeInteger(value.revision)) throw Error();
}`;
const v2 = `const PENDING_COMMAND_INBOX_VERSION = 1;
const RECOVERABLE_PENDING_COMMAND_INBOX_VERSION = 2;
function envelopeFields(value) {
  if (!exactObject(value, ["version", "revision", "ciphertext"])
    || ![PENDING_COMMAND_INBOX_VERSION, RECOVERABLE_PENDING_COMMAND_INBOX_VERSION].includes(value.version)
    || !Number.isSafeInteger(value.revision)) throw Error();
  return value;
}
function validateEnvelope(value) {
  const envelope = envelopeFields(value);
  return envelope;
}`;

test("verified install requires the audited Inbox reader regardless of package or wire version", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-install-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  async function bundle(name, version, protocol, reader) {
    const src = path.join(root, name);
    const service = path.join(src, "app", "agent-service");
    fs.mkdirSync(service, { recursive: true });
    fs.writeFileSync(path.join(src, "package.json"), JSON.stringify({ version }));
    fs.writeFileSync(path.join(service, "service-protocol-version.js"), `const SERVICE_PROTOCOL_VERSION = ${protocol};`);
    fs.writeFileSync(path.join(service, "pending-command-inbox.js"), `${reader}\nthrow new Error("must never execute candidate code");\n`);
    const archive = path.join(root, `${name}.asar`);
    await createPackage(src, archive);
    return archive;
  }
  const old32 = await bundle("old-wire", "0.8.319", 32, v1);
  const old34 = await bundle("same-wire", "0.8.320", 34, v1);
  const renamedOld34 = await bundle("same-version", "0.8.321", 34, v1);
  const forward = await bundle("forward", "0.8.321", 34, v2);
  const declaredOnly = await bundle("declared-only", "0.8.321", 34, `${v1}\nconst RECOVERABLE_PENDING_COMMAND_INBOX_VERSION = 2;`);
  const unknown = await bundle("unknown", "0.8.321", 34, "const PENDING_COMMAND_INBOX_VERSION = 1;");
  const currentReader = fs.readFileSync(path.join(__dirname, "../app/agent-service/pending-command-inbox.js"), "utf8");
  const current = await bundle("current-product-reader", "0.8.321", 34, currentReader);
  for (const archive of [old32, old34, renamedOld34, forward, declaredOnly, unknown]) {
    assert.doesNotThrow(() => assertInboxReaderCompatibility(archive, null));
    assert.throws(() => assertInboxReaderCompatibility(archive, undefined), { code: "INSTALL_INBOX_FORMAT_UNVERIFIED" });
    assert.throws(() => assertInboxReaderCompatibility(archive, { version: 3, revision: 1 }), { code: "INSTALL_INBOX_FORMAT_UNVERIFIED" });
  }
  for (const archive of [old32, old34, renamedOld34, declaredOnly]) {
    assert.doesNotThrow(() => assertInboxReaderCompatibility(archive, { version: 1, revision: 33 }));
    assert.throws(() => assertInboxReaderCompatibility(archive, { version: 2, revision: 34 }), { code: "INSTALL_INBOX_READER_INCOMPATIBLE" });
  }
  assert.doesNotThrow(() => assertInboxReaderCompatibility(forward, { version: 1, revision: 11 }));
  assert.doesNotThrow(() => assertInboxReaderCompatibility(forward, { version: 2, revision: 42 }));
  assert.doesNotThrow(() => assertInboxReaderCompatibility(current, { version: 1, revision: 41 }));
  assert.doesNotThrow(() => assertInboxReaderCompatibility(current, { version: 2, revision: 42 }));
  assert.throws(() => assertInboxReaderCompatibility(unknown, { version: 1, revision: 11 }), { code: "INSTALL_INBOX_READER_INCOMPATIBLE" });
  assert.throws(() => assertInboxReaderCompatibility(path.join(root, "missing.asar"), { version: 2, revision: 42 }),
    { code: "INSTALL_INBOX_READER_INCOMPATIBLE" });
});
