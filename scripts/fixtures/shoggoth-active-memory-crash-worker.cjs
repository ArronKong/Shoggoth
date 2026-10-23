"use strict";

// The parent owns this isolated root and kills this process only after a real
// native recall has committed its scratch session / first tool transcript.
const path = require("node:path");
const { MemoryDatabase } = require("../../app/agent-service/shoggoth-memory/database.cjs");
const { ShoggothMemoryHost, core } = require("../../app/agent-service/shoggoth-memory/host.cjs");
const { ActiveMemoryRuntime } = require("../../app/agent-service/shoggoth-memory/active-memory-runtime.cjs");
const [root, phase] = process.argv.slice(2);
if (!process.send || !["created", "tool"].includes(phase)) throw new Error("Isolated crash fixture requires IPC and a phase");
const paths = { trustedRoot: root, stateDir: path.join(root, "state") };
const database = new MemoryDatabase({ paths, databasePath: path.join(paths.stateDir, "one.sqlite") }); database.open();
const workspace = path.join(root, "one");
const host = new ShoggothMemoryHost({ database, paths, profileId: "one", workspaceDir: workspace,
  roster: () => [{ id: "one", workspace }], sessions: {} });
const keepAlive = setInterval(() => {}, 1000);
let calls = 0;
const runtime = new ActiveMemoryRuntime({ host, input: { profile: { id: "one" }, run: { id: `crash-${phase}`, profileId: "one" } },
  config: core.normalizeActiveMemoryConfig({ mode: "always" }, {}, ["memory_search", "memory_get"]), runtimeConfig: {},
  signal: new AbortController().signal, check() {}, logger: { warn() {}, debug() {} },
  complete: async () => {
    if (phase === "tool" && ++calls === 1) return { text: '{"tool":"memory_get","arguments":{"path":"MEMORY.md"}}' };
    process.send({ ready: true, phase });
    return new Promise(() => {});
  },
  callTool: async () => ({ path: "MEMORY.md", text: "Isolated recovery fixture: amber telescope." }),
});
runtime.run({ query: "Recall fixture telescope", searchQuery: "fixture telescope" }).catch(error => {
  process.send({ error: error.code || "FIXTURE_FAILED" }); clearInterval(keepAlive); database.close(); process.exitCode = 1;
});
