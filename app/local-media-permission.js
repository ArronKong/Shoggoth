"use strict";
const { spawn } = require("node:child_process");
// Called only from the trusted desktop IPC. No media, credentials or provider
// configuration is passed to this permission/status helper.
function localMediaPermission(binary, request = false, spawnImpl = spawn) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(binary, [], { stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "en_US.UTF-8" } });
    let text = "", failed = false;
    const fail = () => { failed = true; child.kill("SIGKILL"); };
    const timer = setTimeout(fail, request ? 120000 : 15000); timer.unref?.();
    child.on("error", () => { failed = true; }); child.stdin.on("error", fail); child.stderr.on("data", () => {});
    child.stdout.on("data", chunk => { text += chunk; if (Buffer.byteLength(text) > 4096) fail(); });
    child.on("close", code => {
      clearTimeout(timer);
      try {
        const value = JSON.parse(text);
        if (failed || code !== 0 || value.version !== 1 || typeof value.speechAuthorized !== "boolean"
          || typeof value.speechOnDevice !== "boolean" || !["authorized", "denied", "restricted", "not-determined", "unavailable"].includes(value.speechStatus)) throw Error();
        resolve({ authorized: value.speechAuthorized, onDevice: value.speechOnDevice, status: value.speechStatus });
      } catch { reject(Object.assign(new Error("暂时无法检查本机语音识别，请稍后重试"), { code: "SECRET_MEDIA_SPEECH_UNAVAILABLE" })); }
    });
    child.stdin.end(JSON.stringify({ action: request ? "requestSpeechPermission" : "capabilities" }) + "\n");
  });
}
module.exports = { localMediaPermission };
