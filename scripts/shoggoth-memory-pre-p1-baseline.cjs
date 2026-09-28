"use strict";

// Re-run the frozen A/B memory corpus against the unmodified pre-P1 engine.
// Loading the two Git blobs in place keeps relative dependencies identical to
// the product while avoiding a second checkout or a copy of private app data.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const REF = "d622d117";
const FIXTURE_PATH = path.join(__dirname, "fixtures/shoggoth-memory-evaluation-v1.json");
const FIXTURE_SHA256 = "a926172548441dd59f3aac6e5152590e3b8da2526f57de2631db64429ca745c6";
const fixtureBytes = fs.readFileSync(FIXTURE_PATH);
assert.equal(crypto.createHash("sha256").update(fixtureBytes).digest("hex"), FIXTURE_SHA256,
  "frozen evaluation fixture changed");
const fixture = JSON.parse(fixtureBytes);
const { resolveServicePaths } = require("../app/agent-service/paths");
const { AgentDefinitionStore } = require("../app/agent-service/agent-definition-store");

function loadGitModule(relativePath) {
  const filename = path.join(ROOT, relativePath);
  const source = execFileSync("git", ["show", `${REF}:${relativePath}`], {
    cwd: ROOT, encoding: "utf8", maxBuffer: 4 * 1024 * 1024,
  });
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded._compile(source, filename);
  return loaded.exports;
}

function evaluate(label, MemoryStore, MemoryEngine) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-memory-pre-p1-"));
  fs.chmodSync(root, 0o700);
  const paths = resolveServicePaths({ stateRoot: path.join(root, "state"),
    profileRoot: path.join(root, "profile"), cacheRoot: path.join(root, "cache"), trustedRoot: root });
  let clock = 1_000;
  let sequence = 0;
  const now = () => clock++;
  const randomUUID = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
  const definitions = new AgentDefinitionStore({ paths, now, randomUUID });
  const store = new MemoryStore({ paths });
  const engine = new MemoryEngine({ store, definitionStore: definitions, now, randomUUID });
  try {
    definitions.open();
    definitions.ensureProfile({ profileId: "profile-1" });
    store.open();
    engine.open(["profile-1"]);
    for (const item of fixture.memoryItems) engine.propose({ id: item.id,
      profileId: "profile-1", scope: "user", type: "semantic", content: item.content,
      sourceRefs: [`synthetic-${item.id}`], classification: "explicit" });
    const groups = {};
    for (const group of ["A", "B"]) {
      const rows = fixture.memoryQueries[group].map((sample) => {
        const found = engine.search({ profileId: "profile-1", query: sample.query,
          scopes: ["user"], maxSensitivity: "normal", limit: 5,
          maxBytes: 16 * 1024, now: 10_000 }).items.map((item) => item.id);
        return { id: sample.id, probe: sample.probe, relevant: sample.relevant, found,
          hits: sample.relevant.filter((id) => found.includes(id)) };
      });
      const hits = rows.reduce((sum, row) => sum + row.hits.length, 0);
      const relevant = rows.reduce((sum, row) => sum + row.relevant.length, 0);
      groups[group] = { recallAt5: hits / relevant,
        precisionAt5: rows.reduce((sum, row) => sum + row.hits.length / 5, 0) / rows.length,
        rows };
    }
    return { label, groups };
  } finally {
    try { engine.close(); } catch {}
    try { store.close(); } catch {}
    try { definitions.close(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const previous = evaluate(REF,
  loadGitModule("app/agent-service/memory-store.js").MemoryStore,
  loadGitModule("app/agent-service/memory-engine.js").MemoryEngine);
const current = evaluate("working-tree",
  require("../app/agent-service/memory-store").MemoryStore,
  require("../app/agent-service/memory-engine").MemoryEngine);
assert.ok(current.groups.A.recallAt5 >= previous.groups.A.recallAt5,
  "A group Recall@5 regressed from pre-P1 baseline");
assert.ok(current.groups.A.precisionAt5 >= previous.groups.A.precisionAt5,
  "A group Precision@5 regressed from pre-P1 baseline");
for (const row of previous.groups.A.rows) {
  if (!["A02", "A07"].includes(row.id)) continue;
  const now = current.groups.A.rows.find((item) => item.id === row.id);
  assert.ok(now.hits.length >= row.hits.length, `${row.id}: two-character recall regressed`);
}
process.stdout.write(`${JSON.stringify({ fixtureSha256: FIXTURE_SHA256,
  preP1Ref: REF, previous: previous.groups, current: current.groups }, null, 2)}\n`);
