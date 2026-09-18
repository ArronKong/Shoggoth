"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveServicePaths } = require("../../app/agent-service/paths");
const { AgentDefinitionStore } = require("../../app/agent-service/agent-definition-store");
const { MemoryStore } = require("../../app/agent-service/memory-store");
const { MemoryEngine } = require("../../app/agent-service/memory-engine");

function memoryFixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-memory-"));
  fs.chmodSync(root, 0o700);
  const paths = resolveServicePaths({
    stateRoot: path.join(root, "state"), profileRoot: path.join(root, "profile"),
    cacheRoot: path.join(root, "cache"), trustedRoot: root,
  });
  let clock = options.now ?? 1_000;
  let id = 0;
  const now = () => clock++;
  const randomUUID = () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`;
  const definitions = new AgentDefinitionStore({ paths, now, randomUUID });
  definitions.open();
  definitions.ensureProfile({ profileId: "profile-1" });
  const store = new MemoryStore({ paths });
  store.open();
  const engine = new MemoryEngine({ store, definitionStore: definitions, now, randomUUID });
  engine.open(["profile-1"]);
  return {
    root, paths, definitions, store, engine,
    setNow(value) { clock = value; },
    close() { engine.close(); store.close(); definitions.close(); },
    cleanup() { try { this.close(); } catch {} fs.rmSync(root, { recursive: true, force: true }); },
  };
}

module.exports = { memoryFixture };
