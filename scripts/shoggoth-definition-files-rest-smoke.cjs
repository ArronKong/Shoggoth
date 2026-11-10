"use strict";

// Real App REST -> Backend -> Service -> fixed files and native file memory.
// All state, fake Runtime homes and edits belong to this temporary fixture.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { startInspirationFixture } = require("./fixtures/inspiration-service-fixture.cjs");
const { DEFAULT_AGENT_PROFILE_ID } = require("../app/agent-service/product-store");

async function main() {
  const f = await startInspirationFixture({ isolatedHome: true, serviceOptions: {
    prewarmMcpAuth: false, memoryCoreConfig: { memory: { search: { provider: "none" } } },
  } });
  try {
    const profile = f.service.productStore.getAgentProfile(DEFAULT_AGENT_PROFILE_ID);
    const agentRoot = path.join(f.paths.agentsDir, profile.id);
    const request = async (suffix, method = "GET", body) => {
      const response = await fetch(`${f.url}/__api/agents/${encodeURIComponent(profile.agentId)}/${suffix}${suffix.includes("?") ? "&" : "?"}backend=shoggoth`, {
        method, ...(body ? { headers: { Origin: f.url, "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
      });
      return { status: response.status, data: await response.json() };
    };
    const read = async kind => {
      const result = await request(`file?file=${kind}.md`);
      assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data.file;
    };
    const save = async (kind, content, expectedRevision) => {
      const result = await request(`file?file=${kind}.md`, "PUT", { content, expectedRevision });
      assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data.result;
    };
    const userBefore = await read("USER"), memoryBefore = await read("MEMORY");
    for (const kind of ["IDENTITY", "SOUL", "AGENTS"]) {
      const file = await read(kind), content = file.content + `\nApp file editor ${kind} marker.\n`;
      await save(kind, content, file.revision);
      assert.equal((await read(kind)).content, content);
      assert.equal((await read(kind)).localDirectory, agentRoot);
      assert.equal(fs.readFileSync(path.join(agentRoot, `${kind}.md`), "utf8"), content);
    }
    for (let i = 0; i < 5; i++) await save("SOUL", `App saved personality ${i}.\n`, (await read("SOUL")).revision);
    const meta = (await request("definition")).data.definition;
    assert.equal(meta.history.length, 4);
    assert.equal(fs.readdirSync(path.join(agentRoot, "definition/backups")).length, 3);
    assert.equal(meta.historyHasMore, false);
    const stale = await read("SOUL");
    fs.writeFileSync(path.join(agentRoot, "SOUL.md"), "External editor kept this text.\n");
    const rejected = await request("file?file=SOUL.md", "PUT", { content: "stale draft", expectedRevision: stale.revision });
    assert.notEqual(rejected.status, 200);
    const external = await read("SOUL"); assert.equal(external.content, "External editor kept this text.\n");
    const restored = await request("definition", "POST", { action: "restore", revision: stale.revision, expectedRevision: external.revision });
    assert.equal(restored.status, 200, JSON.stringify(restored.data));
    assert.equal((await read("SOUL")).content, stale.content);
    assert.equal((await read("USER")).content, userBefore.content);
    assert.equal((await read("MEMORY")).content, memoryBefore.content);
    console.log("PASS App core file read/edit/reopen, external edit conflicts, restore and three-backup retention");

    const additions = { USER: "用户希望被称呼为松桥测试员。", MEMORY: "琥珀望远镜每天傍晚校准。" };
    for (const [kind, line] of Object.entries(additions)) {
      const file = await read(kind), content = file.content + `\n${line}\n`;
      const result = await save(kind, content, file.revision);
      assert.equal(typeof result.fileRevision, "string");
      const saved = await read(kind);
      assert.equal(saved.content, content);
      assert.equal(saved.readOnly, false);
      assert.equal(fs.readFileSync(path.join(saved.localDirectory, `${kind}.md`), "utf8"), content);
    }
    const items = (await request("memories?status=active&cursor=0&limit=100")).data.memories.items;
    for (const line of Object.values(additions)) assert.ok(items.some(item => item.content.includes(line)), line);
    const memory = await read("MEMORY");
    await save("MEMORY", memory.content.replace(additions.MEMORY, "琥珀望远镜改为每天早晨校准。"), memory.revision);
    const corrected = (await request("memories?status=active&cursor=0&limit=100")).data.memories.items;
    assert.ok(corrected.some(item => item.content.includes("每天早晨校准")));
    assert.equal(corrected.some(item => item.content.includes("每天傍晚校准")), false);
    assert.equal(fs.readdirSync(path.join(agentRoot, "definition/backups")).length, 3);
    assert.equal(fs.readFileSync(path.join(agentRoot, "SOUL.md"), "utf8"), stale.content);
    console.log("PASS App USER/MEMORY edits, active memory projection and correction remain independent of definition backups");
  } finally { await f.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
