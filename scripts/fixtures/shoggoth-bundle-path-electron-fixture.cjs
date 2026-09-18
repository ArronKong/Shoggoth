"use strict";

const { app } = require("electron");

const modulePath = process.argv[2];
const config = JSON.parse(process.argv[3]);
const options = JSON.parse(process.argv[4]);

Promise.resolve().then(async () => {
  const { assertStableAppPaths } = require(modulePath);
  const value = assertStableAppPaths(config, options);
  process.stdout.write(`${JSON.stringify({ ok: true, value })}\n`);
  await app.whenReady();
  app.exit(0);
}).catch((error) => {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    code: typeof error?.code === "string" ? error.code : null,
    message: typeof error?.message === "string" ? error.message : null,
  })}\n`);
  app.exit(1);
});
