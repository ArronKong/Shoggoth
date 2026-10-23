import assert from "node:assert/strict";
import vm from "node:vm";
import { createRequire } from "node:module";
const require = createRequire(new URL("../app/manage-ui/package.json", import.meta.url));
const { build } = require("esbuild");
const { outputFiles } = await build({ entryPoints: [new URL("../app/manage-ui/src/lib/chatMessageVisibility.ts", import.meta.url).pathname],
  bundle: true, write: false, platform: "node", format: "cjs" });
const module = { exports: {} };
vm.runInNewContext(outputFiles[0].text, { module, exports: module.exports });
const { isScheduledCronUserMessage: hidden } = module.exports;
const user = { role: "user" }, task = "Please prepare the report.";
assert.equal(hidden({ ...user, automation: "cron" }, task), true);
assert.equal(hidden({ ...user, provenance: { kind: "internal_system", sourceTool: "cron" } }, task), true);
assert.equal(hidden(user, "[IMPORTANT: You are running as a scheduled cron job. DELIVERY: fixture] " + task), true);
assert.equal(hidden(user, "[cron:fixture Scheduled report] " + task), true);
assert.equal(hidden(user, "A scheduled reminder has been triggered. The reminder content is:\n\n" + task), true);
assert.equal(hidden(user, "A scheduled cron event was triggered, but no event content was found. Reply NO_REPLY."), true);
assert.equal(hidden({ ...user, provenance: { kind: "internal_system", sourceTool: "exec" } }, task), false,
  "async command completions are not Cron inputs");
assert.equal(hidden({ ...user, provenance: { kind: "external_user", sourceTool: "cron" } }, task), false,
  "a human source is not reclassified by sourceTool alone");
assert.equal(hidden(user, task), false, "ordinary follow-ups keep the same task words visible");
assert.equal(hidden(user, "Explain [cron:fixture] in this report."), false, "quoted markers inside human text are not scheduler envelopes");
assert.equal(hidden({ ...user, local: true, automation: "cron" }, task), false, "local command feedback stays visible");
assert.equal(hidden({ role: "assistant", automation: "cron" }, task), false, "scheduled assistant output stays visible");
assert.equal(hidden({ ...user, provenance: { kind: "inter_session" } }, task), false, "other producer types retain their own visibility rule");
console.log("PASS scheduled input visibility: Cron provenance and legacy envelopes, ordinary follow-ups, quoted markers, local feedback and assistant output");
