"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { test } = require("node:test");
const { memoryFixture } = require("./fixtures/shoggoth-memory-fixture.cjs");
const { createAuthorityBackup, verifyAuthorityBackup, restoreAuthorityBackup } = require("../app/agent-service/authority-backup");
const { resolveServicePaths } = require("../app/agent-service/paths");
const { MemoryStore } = require("../app/agent-service/memory-store");
const { MemoryEngine } = require("../app/agent-service/memory-engine");
const { AgentDefinitionStore } = require("../app/agent-service/agent-definition-store");

test("authority backup excludes vectors and restore preserves explicit forgetting", () => {
  const f = memoryFixture(), stores = [];
  try {
    const target = f.engine.propose({ profileId:"profile-1",scope:"user",type:"semantic",
      content:"我的测试茶壶容量为六百毫升。",sourceRefs:["synthetic-teapot"],classification:"explicit" });
    f.engine.delete({profileId:"profile-1",id:target.id,reason:"forgotten"});
    f.close();
    for(const suffix of ["","-wal","-shm","-journal"]) fs.writeFileSync(
      path.join(f.paths.agentsDir,"profile-1","native-memory-semantic.sqlite"+suffix),"disposable",{mode:0o600});
    createAuthorityBackup({paths:f.paths,backupId:"native-e5-backup"});
    const verified=verifyAuthorityBackup({paths:f.paths,backupId:"native-e5-backup"});
    assert.ok(!verified.manifest.entries.some(entry=>/native-memory-semantic\.sqlite/u.test(entry.path)));
    const destination=path.join(f.root,"restored-state");
    restoreAuthorityBackup({paths:f.paths,backupId:"native-e5-backup",destinationStateDir:destination});
    const paths=resolveServicePaths({trustedRoot:f.root,stateRoot:destination,
      cacheRoot:path.join(f.root,"restored-cache"),profileRoot:path.join(f.root,"restored-profile")});
    const definitions=new AgentDefinitionStore({paths}); definitions.open(); stores.push(definitions);
    const store=new MemoryStore({paths});store.open();stores.push(store);
    const engine=new MemoryEngine({store,definitionStore:definitions});engine.open(["profile-1"]);stores.push(engine);
    assert.equal(store.get("profile-1",target.id).status,"deleted");
    assert.equal(engine.search({profileId:"profile-1",query:"茶壶容量"}).items.length,0);
    assert.equal(engine.semanticDocuments("profile-1").length,0);
    assert.ok(!fs.existsSync(path.join(paths.agentsDir,"profile-1","native-memory-semantic.sqlite")));
  } finally { for(const store of stores.reverse()) store.close(); f.cleanup(); }
});
