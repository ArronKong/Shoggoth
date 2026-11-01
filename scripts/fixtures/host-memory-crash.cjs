"use strict";
const { openHandoffFixture } = require("./runtime-handoff-service.cjs");
(async () => {
  const f = await openHandoffFixture({ serviceOptions: { memoryCore: true, prewarmMcpAuth: false,
    memoryCoreConfig: { memory: { search: { provider: "none", rememberAcrossConversations: false }, textModel: { source: "local" } },
      plugins: { entries: { "active-memory": { enabled: false }, "memory-core": { config: { dreaming: { enabled: false } } } } } } } });
  f.service.runtimeManager.acquire = async () => { throw new Error("No native Runtime in crash fixture"); };
  const session = f.createSession(), commands = f.service.workRunCoordinator.hostMemoryCommands;
  const write = commands.conversation.write.bind(commands.conversation);
  commands.conversation.write = async (...args) => {
    const result = await write(...args);
    // Exit without closing Service: the parent must recover actual dead-process
    // leases and a prepared receipt after the durable file transaction.
    process.stdout.write(JSON.stringify({ root: f.root, runId: args[3].binding.runId, memoryId: result.item.id }), () => process.exit(0));
    return new Promise(() => {});
  };
  await f.service.workRunCoordinator.send({ sessionKey: session.sessionKey, operationId: "crash-host", prompt: "记住：恢复测试偏好琥珀色。" });
})().catch(error => { process.stderr.write(String(error.stack)); process.exit(1); });
