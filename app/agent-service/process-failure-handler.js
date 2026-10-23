"use strict";

const { recordServiceProcessFailure } = require("../bootstrap-diagnostics");

function installServiceProcessFailureHandler(options = {}) {
  const emitter = options.emitter || process;
  const exit = options.exit || ((code) => process.exit(code));
  const record = options.record || recordServiceProcessFailure;
  let failed = false;
  const fail = (error, origin) => {
    if (failed) return;
    failed = true;
    try {
      record(error, { paths: options.paths, origin });
    } catch {
      // Diagnostics must never prevent the fatal exit (including disk-full).
    } finally {
      // Electron's default handler opens a blocking error dialog when it is
      // the only uncaughtException listener. A background Service must exit
      // instead, leaving durable operation recovery to its next owner.
      exit(1);
    }
  };
  const onException = (error, origin) => fail(error,
    origin === "unhandledRejection" ? origin : "uncaughtException");
  const onRejection = (error) => fail(error, "unhandledRejection");
  emitter.on("uncaughtException", onException);
  emitter.on("unhandledRejection", onRejection);
  return () => {
    emitter.off("uncaughtException", onException);
    emitter.off("unhandledRejection", onRejection);
  };
}

module.exports = { installServiceProcessFailureHandler };
