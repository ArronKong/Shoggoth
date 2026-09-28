#!/usr/bin/env node
"use strict";
const { parse, execute } = require("./shoggoth-memory-live-acceptance.cjs");
Promise.resolve().then(async () => {
  const options = { ...parse(process.argv.slice(2)), suite: "p4" };
  const result = await execute(options);
  console.log(JSON.stringify(result.mode === "plan" ? result : {
    status: result.status, p4: result.p4?.status, stage: result.stage,
    errorCode: result.errorCode, output: options.output,
  }));
  if (result.status === "failed") process.exitCode = 1;
}).catch(error => {
  console.error(/^MEMORY_LIVE_[A-Z0-9_]+$/u.test(error?.code || "") ? error.code : "MEMORY_LIVE_LOCAL_FAILED");
  process.exitCode = 1;
});
