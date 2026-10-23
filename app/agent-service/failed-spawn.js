"use strict";

// spawn() can return a ChildProcess without a PID before emitting its OS error
// on the next tick. The caller already rejects this startup with a scoped code;
// retain an error listener until physical close so it cannot crash the Service.
function retireFailedSpawn(child) {
  if (typeof child?.on !== "function" || typeof child?.once !== "function") return;
  const onError = () => {};
  child.on("error", onError);
  child.once("close", () => child.removeListener("error", onError));
}

// Before the deferred spawn error, Node still has a process handle with PID 0.
// ChildProcess.kill() can then signal the caller's whole process group on POSIX.
function killStartedChild(child, signal) {
  if (!Number.isSafeInteger(child?.pid) || child.pid <= 1 || child.pid === process.pid
    || typeof child.kill !== "function") return false;
  return child.kill(signal);
}

module.exports = { retireFailedSpawn, killStartedChild };
