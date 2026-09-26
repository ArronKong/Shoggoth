#!/usr/bin/env node

import assert from "node:assert/strict";
import path from "node:path";
import { build } from "../app/manage-ui/node_modules/esbuild/lib/main.js";

const result = await build({
  entryPoints: [path.resolve(import.meta.dirname, "../app/manage-ui/src/pages/models/endpoint-mutation-state.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
});
const { endpointMutationNotice } = await import(
  `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`
);

const blocked = {
  operationId: "endpoint-save",
  status: "blocked",
  code: "session_enumeration_incomplete",
  stage: "preflight",
  sync: "pending",
  steps: [{ operationId: "endpoint-save:delete:0", status: "blocked", stage: "preflight" }],
};
assert.equal(endpointMutationNotice(blocked), "preflightBlocked");
assert.equal(endpointMutationNotice({ ...blocked, sync: "synced" }), "preflightBlocked");
assert.equal(endpointMutationNotice({
  ...blocked,
  steps: [{ operationId: "endpoint-save:provider", status: "applied" }, ...blocked.steps],
}), "partiallyApplied", "凭据步骤已完成但删除模型被阻塞时，不得声称全部已保存或零写入");
assert.equal(endpointMutationNotice({
  ...blocked, status: "partial", code: "response_lost", stage: "request", steps: [],
}), "writeUnconfirmed");
assert.equal(endpointMutationNotice({
  ...blocked, status: "needs_secret", stage: "config-write", steps: [],
}), "writeUnconfirmed");
assert.equal(endpointMutationNotice({
  ...blocked, status: "applied", stage: "catalog-sync", steps: [],
}), "syncPending");
console.log("endpoint recovery notice: 6 checks passed");
