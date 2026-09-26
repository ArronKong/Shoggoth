"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AgentDefinitionStore } = require("../app/agent-service/agent-definition-store");
const { resolveServicePaths } = require("../app/agent-service/paths");

function makeStore(root, faultInjector = null) {
  const paths = resolveServicePaths({
    stateRoot: path.join(root, "state"),
    profileRoot: path.join(root, "profile"),
    cacheRoot: path.join(root, "cache"),
    trustedRoot: root,
  });
  let uuid = 0;
  return new AgentDefinitionStore({
    paths,
    now: () => 1000 + uuid,
    randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}`,
    faultInjector,
  });
}

for (const checkpoint of ["revision-ready", "revision-installed", "manifest-committed"]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-definition-crash-"));
  fs.chmodSync(root, 0o700);
  try {
    const bootstrap = makeStore(root);
    bootstrap.open();
    bootstrap.ensureProfile({ profileId: "profile-1" });
    bootstrap.close();

    const crashing = makeStore(root, (name) => {
      if (name === checkpoint) throw new Error(`crash:${checkpoint}`);
    });
    crashing.open();
    assert.throws(() => crashing.update({
      profileId: "profile-1",
      expectedRevision: 1,
      actor: "user",
      documents: { SOUL: `# ${checkpoint}\n` },
    }), new RegExp(`crash:${checkpoint}`));
    crashing.close();

    const recovered = makeStore(root);
    recovered.open();
    const current = recovered.get("profile-1");
    const expectedRevision = checkpoint === "manifest-committed" ? 2 : 1;
    assert.equal(current.manifest.revision, expectedRevision);
    if (expectedRevision === 2) assert.equal(current.documents.SOUL, `# ${checkpoint}\n`);
    recovered.close();
    console.log(`ok - ${checkpoint} 后 manifest 只指向完整 revision ${expectedRevision}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

console.log("3 definition atomicity regressions passed");
