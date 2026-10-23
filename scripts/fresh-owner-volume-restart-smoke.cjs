"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { createAgentService } = require("../app/agent-service/server");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { DEFAULT_AGENT_PROFILE_ID: profileId } = require("../app/agent-service/product-store");
const { MemoryDatabase } = require("../app/agent-service/shoggoth-memory/database.cjs");
const { atomicWritePrivateFile } = require("../app/agent-service/private-file");
const volumeA = "darwin-volume:11111111-1111-4111-8111-111111111111";
const volumeB = "darwin-volume:22222222-2222-4222-8222-222222222222";
const stable = value => Array.isArray(value) ? "[" + value.map(stable).join(",") + "]"
  : value && typeof value === "object" ? "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + stable(value[key])).join(",") + "}"
  : JSON.stringify(value);
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const safeStorage = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => Buffer.from(value).toString("utf8") };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sfn-volume-")); fs.chmodSync(root, 0o700);
  const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "s"), profileRoot: path.join(root, "p"), cacheRoot: path.join(root, "c") });
  const profile = path.join(paths.agentsDir, profileId), workspace = path.join(profile, "memory-workspace");
  const manifest = path.join(profile, "memory-native-initialization-v1", "owner.json");
  let service;
  const close = async () => { if (service) { await service.stop({ notify: false }); service = null; } };
  const create = (volume = volumeA) => {
    service = createAgentService({ paths, safeStorage, prewarmMcpAuth: false, version: "isolated-volume-restart",
      memoryCoreConfig: { memory: { search: { provider: "none", rememberAcrossConversations: false } },
        agents: { defaults: { compaction: { memoryFlush: { enabled: false } } } } } });
    service.memoryEngine.initialization.resolveVolumeIdentity = () => volume;
    return service;
  };
  const open = async volume => { const current = create(volume); await current.start(); return current; };
  const withDatabase = action => { const db = new MemoryDatabase({ paths }); db.open(); try { return action(db.db); } finally { db.close(); } };
  const makeLegacy = () => {
    const m = JSON.parse(fs.readFileSync(manifest, "utf8")); m.schemaVersion = 1; delete m.volumeIdentity;
    delete m.checksum; m.checksum = sha(stable(m));
    const body = Object.fromEntries(["schemaVersion", "type", "profileId", "ownerId", "owner", "upstreamRevision", "createdAt", "profileIdentity", "initialFiles"].map(key => [key, m[key]]));
    withDatabase(db => db.prepare("UPDATE memory_native_owners SET authority_hash=? WHERE profile_id=?").run(sha(stable(body)), profileId));
    atomicWritePrivateFile(manifest, stable(m) + "\n", { trustedRoot: root });
    return m;
  };
  t.after(async () => { await close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, paths, profile, workspace, manifest, create, open, close, withDatabase, makeLegacy };
}
// Model the previous boot's persisted device number. Live lstat/fstat must
// remain consistent: they still protect fd races within this process.
function previousBoot(f) {
  const m = JSON.parse(fs.readFileSync(f.manifest, "utf8"));
  m.profileIdentity.dev -= 2;
  if (m.workspaceIdentity) m.workspaceIdentity.dev -= 2;
  delete m.checksum; m.checksum = sha(stable(m));
  const keys = ["schemaVersion", "type", "profileId", "ownerId", "owner", "upstreamRevision", "createdAt", "profileIdentity", "initialFiles"];
  if (m.schemaVersion === 2) keys.push("volumeIdentity");
  const hash = sha(stable(Object.fromEntries(keys.map(key => [key, m[key]]))));
  f.withDatabase(db => db.prepare("UPDATE memory_native_owners SET authority_hash=? WHERE profile_id=?").run(hash, profileId));
  atomicWritePrivateFile(f.manifest, stable(m) + "\n", { trustedRoot: f.root });
}
const propose = service => service.memoryEngine.propose({ profileId, scope: "agent", type: "semantic", classification: "explicit",
  content: "The telescope retains its amber calibration after reboot.", sourceRefs: ["user-edit:volume-restart-fixture"] });

test("stable volume authority reopens after device renumbering without changing owners or facts", async t => {
  const f = fixture(t); let service = await f.open(); const item = await propose(service), revision = service.memoryStore.getRevision(profileId);
  await f.close(); previousBoot(f);
  const ownerBytes = fs.readFileSync(f.manifest), memoryBytes = fs.readFileSync(path.join(f.workspace, "MEMORY.md"));
  assert.equal(JSON.parse(ownerBytes).schemaVersion, 2);
  assert.notEqual(JSON.parse(ownerBytes).profileIdentity.dev, fs.lstatSync(f.profile).dev);
  service = await f.open(); assert.equal(service.memoryStore.get(profileId, item.id).content, item.content);
  assert.equal(service.memoryStore.getRevision(profileId), revision);
  assert.deepEqual(fs.readFileSync(f.manifest), ownerBytes); assert.deepEqual(fs.readFileSync(path.join(f.workspace, "MEMORY.md")), memoryBytes);
  await f.close();
});

test("a different volume is refused even when directory inodes and device numbers match", async t => {
  const f = fixture(t), service = await f.open(); await propose(service); await f.close();
  const bytes = fs.readFileSync(f.manifest);
  await assert.rejects(f.open(volumeB), { code: "MEMORY_NATIVE_OWNER_INVALID" }); await f.close();
  assert.deepEqual(fs.readFileSync(f.manifest), bytes);
});

test("an active v1 owner survives reboot, is sealed once, and preserves original authority bytes", async t => {
  const f = fixture(t); let service = await f.open(); const item = await propose(service); await f.close();
  const old = f.makeLegacy(); previousBoot(f); const ownerBytes = fs.readFileSync(f.manifest);
  const anchor = f.withDatabase(db => db.prepare("SELECT * FROM memory_native_owners WHERE profile_id=?").get(profileId));
  {
    service = await f.open(); assert.equal(service.memoryStore.get(profileId, item.id).content, item.content);
    assert.equal(service.memoryEngine.initialization.assertOwned(profileId).ownerId, old.ownerId); await f.close();
  }
  assert.deepEqual(fs.readFileSync(f.manifest), ownerBytes);
  assert.deepEqual(f.withDatabase(db => db.prepare("SELECT * FROM memory_native_owners WHERE profile_id=?").get(profileId)), anchor);
  const seal = f.withDatabase(db => db.prepare("SELECT * FROM memory_native_owner_volumes WHERE profile_id=?").get(profileId));
  assert.equal(seal.owner_id, old.ownerId); assert.equal(seal.authority_hash, anchor.authority_hash); assert.equal(seal.volume_identity, volumeA);
  await assert.rejects(f.open(volumeB), { code: "MEMORY_NATIVE_OWNER_INVALID" }); await f.close();
  assert.deepEqual(f.withDatabase(db => db.prepare("SELECT * FROM memory_native_owner_volumes WHERE profile_id=?").get(profileId)), seal);
  assert.deepEqual(fs.readFileSync(f.manifest), ownerBytes);
});

test("legacy reboot compatibility still rejects a replaced workspace before issuing a volume seal", async t => {
  const f = fixture(t); await f.open(); await f.close(); f.makeLegacy();
  fs.renameSync(f.workspace, f.workspace + "-retained"); fs.cpSync(f.workspace + "-retained", f.workspace, { recursive: true }); fs.chmodSync(f.workspace, 0o700);
  previousBoot(f); await assert.rejects(f.open(), { code: "MEMORY_NATIVE_OWNER_INVALID" }); await f.close();
  assert.equal(f.withDatabase(db => db.prepare("SELECT count(*) n FROM memory_native_owner_volumes WHERE profile_id=?").get(profileId).n), 0);
});

for (const legacy of [false, true]) test((legacy ? "unsealed prepared v1 refuses" : "prepared v2 recovers from") + " a reboot during initialization", async t => {
  const f = fixture(t), service = f.create(), interrupted = new Error("isolated interrupted initialization");
  service.memoryEngine.initialization.fault = phase => { if (phase === "after-staged") throw interrupted; };
  await assert.rejects(service.start(), error => error === interrupted); await f.close();
  const old = legacy ? f.makeLegacy() : JSON.parse(fs.readFileSync(f.manifest, "utf8"));
  previousBoot(f);
  {
    if (legacy) await assert.rejects(f.open(), { code: "MEMORY_NATIVE_OWNER_INVALID" });
    else { const resumed = await f.open(); assert.equal(resumed.memoryEngine.initialization.assertOwned(profileId).ownerId, old.ownerId); }
    await f.close();
  }
});
