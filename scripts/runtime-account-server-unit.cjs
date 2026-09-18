#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { requestService, readClientToken } = require("../app/agent-service/client");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { createAgentService, PROTOCOL_VERSION } = require("../app/agent-service/server");

function safeStorageFixture() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`fixture:${value}`, "utf8"),
    decryptString: (value) => Buffer.from(value).toString("utf8").slice("fixture:".length),
  };
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-account-server-"));
  const paths = resolveServicePaths({
    stateRoot: path.join(root, "state"),
    profileRoot: path.join(root, "profile"),
    cacheRoot: path.join(root, "cache"),
    trustedRoot: root,
  });
  const calls = [];
  let opened = 0;
  let closed = 0;
  const runtimeAccountServiceController = {
    open() { opened += 1; },
    close() { closed += 1; },
    handle(method, params) {
      calls.push([method, params]);
      return {
        accounts: [{
          id: "native-grok-build-default-v1",
          runtime: "grok-build",
          kind: "native-user",
          installationKind: "system",
          homeKind: "system-default",
          isDefault: true,
          sharedAgentCount: 2,
          admission: {
            generation: 1,
            active: 0,
            maxActive: 1,
            mutationActive: false,
            backoffUntil: null,
          },
        }],
        nextCursor: null,
        hasMore: false,
      };
    },
  };
  const service = createAgentService({
    paths,
    version: "runtime-account-server-test",
    safeStorage: safeStorageFixture(),
    runtimeAccountServiceController,
  });
  try {
    await service.start();
    assert.equal(opened, 1);
    const token = readClientToken(paths);
    const result = await requestService(paths, {
      method: "runtime.account.list",
      token,
      version: PROTOCOL_VERSION,
      params: { cursor: null, limit: 100 },
    });
    assert.equal(result.accounts[0].runtime, "grok-build");
    assert.deepEqual(calls, [[
      "runtime.account.list",
      { cursor: null, limit: 100 },
    ]]);
    await assert.rejects(
      requestService(paths, {
        method: "runtime.account.legacyHomes.cleanup.commit",
        token,
        version: PROTOCOL_VERSION,
        params: { planId: "f".repeat(64), path: "/tmp/forged" },
      }),
      (error) => error.code === "INVALID_PARAMS"
        && !String(error.message).includes("/tmp/forged"),
    );
    assert.equal(calls.length, 1, "invalid cleanup request is rejected before controller dispatch");
    process.stdout.write("PASS RuntimeAccount Service dispatch + lifecycle + exact cleanup params\n");
  } finally {
    await service.stop({ notify: false }).catch(() => {});
    assert.equal(closed, opened);
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
