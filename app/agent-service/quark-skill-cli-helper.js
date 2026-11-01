"use strict";

// Fixed child entry. Authorization codes and page codes arrive on stdin, never
// in OS argv. The owning bridge checks the payload before starting this helper.
const fs = require("node:fs"), path = require("node:path");
const { assertPrivateDirectory } = require("./security");
const MAX_INPUT = 1024 * 1024;
async function main() {
  process.umask(0o077);
  const home = process.env.HOME;
  if (!path.isAbsolute(home || "") || path.basename(home) !== "home") throw Error("invalid home");
  assertPrivateDirectory(home);
  const chunks = []; let size = 0;
  for await (const chunk of process.stdin) { size += chunk.length; if (size > MAX_INPUT) throw Error("invalid input"); chunks.push(chunk); }
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const modulePath = path.join(path.dirname(home), "runtime", "quark-managed.cjs");
  const vendor = require(modulePath), platform = vendor.configure(home, input.operation === "status"), manager = platform.permissionManager;
  const output = data => process.stdout.write(JSON.stringify({ code: 0, type: "result", data }) + "\n");
  const check = value => { if (value?.status !== 0 || !value.data) throw Object.assign(Error("provider refused"), { providerCode: value?.errno, errorCode: -1 }); return value.data; };
  const context = () => ({ clientDeviceId: input.deviceId, deviceName: "Shoggoth", agentId: "shoggoth", workDir: "Shoggoth" });
  async function status() {
    if (!manager.getLocalAccount()?.accessToken) return { state: "signedOut" };
    const sdk = await vendor.sdk(), user = check(await sdk.oauth.getUserInfo(manager.getPersistedDeviceId()));
    return { state: "ready", userName: user.nickname || null };
  }
  async function bind(code) {
    const sdk = await vendor.sdk(), result = check(await sdk.oauth.getAgentAuthCode({ agentAuthCode: code, ...context() }));
    const deviceId = result.deviceId || manager.getPersistedDeviceId();
    if (!["confirmed", "second_confirmed", "install_confirmed"].includes(result.status) || !result.userId || !deviceId) throw Error("invalid authorization");
    const accessToken = result.accessToken || (result.status === "second_confirmed" && manager.getAccountByUserId(result.userId)?.accessToken);
    if (!accessToken) throw Error("missing token");
    manager.setAccessToken(accessToken); manager.setRefreshToken(result.refreshToken);
    const saved = await manager.saveLocalAccount({ accessToken, refreshToken: result.refreshToken, userId: result.userId }, deviceId);
    if (!saved.ok) throw Error("private authorization could not be saved");
    try { return await status(); } catch { return { state: "unknown" }; }
  }
  if (input.operation === "start") {
    const sdk = await vendor.sdk(), info = manager.getDynamicClientInfo();
    const data = check(await sdk.oauth.getAuthorizePageUrl({ ...context(), clientId: info.clientId, isCloudAgent: false, isUnsureAgent: false }));
    output({ ...data, authorizePageUrl: vendor.authorizeUrl(data.authorizePageUrl, info.clientId, "", {
      serverDeviceId: data.deviceId, clientDeviceId: input.deviceId, deviceName: "Shoggoth", agentId: "shoggoth" }) });
  } else if (input.operation === "poll") {
    const sdk = await vendor.sdk(), result = check(await sdk.oauth.getAacByPageCode({ pageCode: input.pageCode }));
    output(result.status === "success" && result.agentAuthCode ? await bind(result.agentAuthCode)
      : { state: ["expired", "denied", "rejected", "cancelled", "failed"].includes(result.status) ? "signedOut" : "authorizing" });
  } else if (input.operation === "bind") output(await bind(input.code));
  else if (input.operation === "status") output(await status());
  else if (input.operation === "command" && Array.isArray(input.args)) await vendor.command(input.args);
  else throw Error("invalid operation");
}
const finish = (code, value) => process.stdout.write(value ? JSON.stringify(value) + "\n" : "", () => process.exit(code));
if (require.main === module) main().then(() => finish(0), error => {
  if (error.code === "commander.helpDisplayed" || error.code === "commander.version" || error.code === "commander.help") { finish(0); return; }
  if (error.errorCode === -1609 && typeof error.data?.task_id === "string") {
    finish(0, { code: 0, type: "result", needsConfirmation: true, data: { task_id: error.data.task_id } }); return;
  }
  // No vendor error text, URL, stack or account data reaches an exception log.
  finish(1, { code: Number.isInteger(error.errorCode) ? error.errorCode : -1,
    providerCode: Number.isInteger(error.serverCode || error.providerCode) ? error.serverCode || error.providerCode : null,
    type: "result", data: {} });
});
module.exports = { main };
