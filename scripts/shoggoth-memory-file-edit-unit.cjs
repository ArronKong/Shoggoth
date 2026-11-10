"use strict";
// USER.md and MEMORY.md are the file-memory source. Editing their text through
// the settings-page protocol must keep memory recall, saving and forgetting working.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { createAgentService } = require("../app/agent-service/server");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { DEFAULT_AGENT_PROFILE_ID: profileId } = require("../app/agent-service/product-store");
const { validateAgentHarnessParams, validateAgentHarnessResult, mapAgentHarnessError } = require("../app/agent-service/agent-harness-service-protocol");
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const safeStorage = { isEncryptionAvailable: () => true, encryptString: v => Buffer.from(v), decryptString: v => Buffer.from(v).toString("utf8") };

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "smf-")); fs.chmodSync(root, 0o700);
  const paths = resolveServicePaths({ trustedRoot: root, stateRoot: path.join(root, "s"), profileRoot: path.join(root, "p"), cacheRoot: path.join(root, "c") });
  const service = createAgentService({ paths, safeStorage, prewarmMcpAuth: false, version: "memory-file-edit",
    memoryCoreConfig: { memory: { search: { provider: "none", rememberAcrossConversations: false } },
      agents: { defaults: { compaction: { memoryFlush: { enabled: false } } } } } });
  await service.start();
  t.after(async () => { await service.stop({ notify: false }); fs.rmSync(root, { recursive: true, force: true }); });
  // The same validation the Service applies to settings-page requests.
  const call = async (method, params) => {
    validateAgentHarnessParams(method, params);
    try {
      const result = await service.agentHarnessServiceController.handle(method, params);
      validateAgentHarnessResult(method, result, params);
      return result;
    } catch (error) { throw Object.assign(new Error(error.message), { code: mapAgentHarnessError(error).code }); }
  };
  const read = kind => call("harness.definition.read", { profileId, kind, revision: null });
  const write = (kind, content, expectedRevision) => call("harness.memory.document.write", { profileId, kind, content, expectedRevision });
  const active = () => service.memoryStore.list(profileId, { status: "active" });
  const propose = content => service.memoryEngine.propose({ profileId, scope: "agent", type: "semantic", classification: "explicit",
    content, sourceRefs: ["user-edit:memory-file-edit"] });
  return { service, call, read, write, active, propose };
}
const rejects = (fn, code) => assert.rejects(fn, error => error.code === code);

test("settings page edits MEMORY.md and USER.md text without breaking recall, save or forget", async t => {
  const f = await fixture(t);
  const meta = await f.call("harness.definition.meta", { profileId });
  assert.deepEqual(Object.fromEntries(meta.files.map(file => [file.kind, file.readOnly])),
    { IDENTITY: false, SOUL: false, USER: false, AGENTS: false, TOOLS: true, MEMORY: false });

  const saved = await f.propose("The telescope uses an amber calibration plate.");
  let memory = await f.read("MEMORY");
  assert.equal(memory.readOnly, false);
  assert.equal(memory.revision, sha(memory.content));
  assert.match(memory.content, /amber calibration plate/u);

  // Change an entry's text and add hand-written text outside entries.
  const edited = memory.content.replace("amber calibration plate", "violet calibration plate")
    + "\nThe lab printer is on the third floor.\n";
  const result = await f.write("MEMORY", edited, memory.revision);
  assert.equal(result.revision, sha(edited));
  memory = await f.read("MEMORY");
  assert.equal(memory.content, edited);
  const item = f.service.memoryStore.get(profileId, saved.id);
  assert.equal(item.status, "active");
  assert.equal(item.content, "The telescope uses an violet calibration plate.");
  assert.ok(f.active().some(value => value.content.includes("third floor")));
  const search = await f.service.memoryEngine.searchMemory({ profileId, query: "lab printer third floor", minScore: 0,
    maxSensitivity: "private", record: false });
  assert.ok(search.items.some(value => value.content.includes("third floor")), "hand-written text is recalled");

  // Ordinary memory saving still appends to the edited file.
  await f.propose("The observatory closes at nine.");
  memory = await f.read("MEMORY");
  assert.match(memory.content, /third floor/u);
  assert.match(memory.content, /closes at nine/u);

  // Removing a whole entry block forgets that memory.
  const block = memory.content.match(new RegExp(`<!-- shoggoth-memory-entry:${saved.id} -->[\\s\\S]*?<!-- /shoggoth-memory-entry -->\\n?`, "u"))[0];
  await f.write("MEMORY", memory.content.replace(block, ""), memory.revision);
  assert.equal(f.service.memoryStore.get(profileId, saved.id).status, "deleted");
  memory = await f.read("MEMORY");

  // Hand edits never break reads: a copied block and an unpaired marker stay readable text.
  const nine = f.active().find(value => value.content.includes("closes at nine"));
  const original = memory.content.match(new RegExp(`<!-- shoggoth-memory-entry:${nine.id} -->[\\s\\S]*?<!-- /shoggoth-memory-entry -->`, "u"))[0];
  const copied = memory.content + "\n" + original.replace("closes at nine", "closes at ten") + "\n"
    + "<!-- shoggoth-memory-entry:unpaired-marker -->\n- The roof hatch sticks in winter.\n";
  await f.write("MEMORY", copied, memory.revision);
  assert.equal(f.service.memoryStore.get(profileId, nine.id).content, "The observatory closes at nine.");
  assert.ok(f.active().some(value => value.id !== nine.id && value.content.includes("closes at ten")), "copy is hand-written memory");
  assert.ok(f.active().some(value => value.content.includes("roof hatch")), "unpaired marker text is hand-written memory");
  // Forgetting the original does not let the copy take over its ID.
  await f.service.memoryEngine.delete({ profileId, id: nine.id, reason: "forgotten", operationId: "file-edit-forget" });
  assert.equal(f.service.memoryStore.get(profileId, nine.id).status, "deleted");
  assert.ok(f.active().some(value => value.content.includes("closes at ten")));
  memory = await f.read("MEMORY");
  assert.equal(memory.content.includes(`<!-- shoggoth-memory-entry:${nine.id} -->`), false);
  // An external editor writing a duplicate straight to disk does not break reads either.
  const dome = await f.propose("The dome motor needs oil every spring.");
  memory = await f.read("MEMORY");
  const domeBlock = memory.content.match(new RegExp(`<!-- shoggoth-memory-entry:${dome.id} -->[\\s\\S]*?<!-- /shoggoth-memory-entry -->`, "u"))[0];
  const workspace = f.service.memoryStore.workspace(profileId);
  fs.writeFileSync(path.join(workspace, "USER.md"), fs.readFileSync(path.join(workspace, "USER.md"), "utf8") + "\n" + domeBlock + "\n");
  assert.equal(f.service.memoryStore.get(profileId, dome.id).memoryPath, "MEMORY.md");
  await f.service.memoryEngine.update({ profileId, id: dome.id, content: "The dome motor needs oil every autumn." });
  assert.ok(f.active().some(value => value.content.includes("every autumn")));
  assert.equal((await f.read("USER")).content.includes(`<!-- shoggoth-memory-entry:${dome.id} -->`), false, "copy unmarked");
  memory = await f.read("MEMORY");

  await rejects(() => f.write("MEMORY", memory.content + "\npassword=fixture-password-value\n", memory.revision), "MEMORY_SECRET_REJECTED");
  await rejects(() => f.write("MEMORY", memory.content + "\nstale\n", sha("old")), "HARNESS_REVISION_CONFLICT");
  assert.equal((await f.read("MEMORY")).content, memory.content);
  assert.throws(() => validateAgentHarnessParams("harness.memory.document.write",
    { profileId, kind: "MEMORY", content: "x", expectedRevision: 3 }));
  assert.throws(() => validateAgentHarnessParams("harness.memory.document.write",
    { profileId, kind: "TOOLS", content: "x", expectedRevision: memory.revision }));

  // USER.md text is recalled as user-scope memory.
  const user = await f.read("USER");
  assert.equal(user.readOnly, false);
  await f.write("USER", user.content + "\nPrefers metric units.\n", user.revision);
  assert.ok(f.active().some(value => value.scope === "user" && value.content.includes("metric units")));
});
