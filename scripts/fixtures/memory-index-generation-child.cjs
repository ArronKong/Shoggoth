"use strict";

const path = require("node:path");
const { MemoryDatabase } = require("../../app/agent-service/shoggoth-memory/database.cjs");
const { ShoggothMemoryHost, core } = require("../../app/agent-service/shoggoth-memory/host.cjs");

async function main() {
  const [root, kind] = process.argv.slice(2);
  if (!root || !path.basename(root).startsWith("shoggoth-memory-generation-") || !["read", "publish"].includes(kind)) throw new Error("Invalid generation fixture scope");
  const paths = { trustedRoot: root, stateDir: path.join(root, "state") }, workspace = path.join(root, "one");
  const database = new MemoryDatabase({ paths }); database.open();
  const lifetime = new AbortController();
  const host = new ShoggothMemoryHost({ database, paths, profileId: "one", workspaceDir: workspace,
    roster: () => [{ id: "one", workspace }], assertCurrent: () => lifetime.signal.throwIfAborted() });
  let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  const open = host.openNodeSqliteDatabase.bind(host);
  host.openNodeSqliteDatabase = (...args) => {
    const db = open(...args);
    if (args[0].endsWith(".generation-lock.sqlite")) process.send?.({ phase: "generation-requested" });
    return db;
  };
  process.on("message", message => { if (message === "release") finish(); });
  process.once("disconnect", () => { lifetime.abort(new Error("Fixture parent disconnected")); finish(); });
  try {
    await host.run(() => core.withMemoryEmbeddingExecution({ signal: lifetime.signal, assertCurrent: () => host.assertCurrent() }, async () => {
      const hold = async () => { process.send?.({ phase: "acquired" }); await gate; };
      if (kind === "publish") await core.withMemoryIndexPublishGeneration(database.path, hold);
      else {
        const release = await core.acquireMemoryIndexReadGeneration(database.path, lifetime.signal);
        try { await hold(); } finally { await release(); }
      }
    }));
    if (host.coordinationDatabases?.size) throw new Error("Fixture leaked coordination connections");
  } finally { database.close(); }
  process.disconnect?.();
}

main().catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; process.disconnect?.(); });
