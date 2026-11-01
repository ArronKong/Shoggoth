"use strict";
// Test only: intercept Node's HTTP boundary, preserving the real CLI, SDK,
// signing, authorization injection and response conversion. No socket is used.
const fs = require("node:fs"), path = require("node:path"), { Writable, Readable } = require("node:stream");
function response(options, body) {
  const url = new URL(`https://${options.hostname}${options.path}`), apiPath = url.pathname;
  if (url.origin !== "https://open-api-drive.quark.cn") throw Error("Unexpected offline network origin: " + url.origin);
  if (options.headers["X-Agent-ID"] !== "shoggoth") throw Error("Incorrect provider identity");
  fs.appendFileSync(path.join(process.env.HOME, "offline-requests.jsonl"), JSON.stringify({ path: apiPath, body, hasSessionInput: JSON.stringify(body).includes("session-input") }) + "\n", { mode: 0o600 });
  let data;
  const expire = path.join(process.env.HOME, "offline-expire-user-info");
  if (apiPath === "/open/v1/user/info" && fs.existsSync(expire)
    || apiPath === "/open/v1/dir" && fs.existsSync(path.join(process.env.HOME, "offline-reject-write"))) return Buffer.from(JSON.stringify({ status: -1, errno: 11001, error_info: "offline expired token" }));
  switch (apiPath) {
    case "/agent/v1/get_authorize_page_url":
      if (body.agent_id !== "shoggoth" || body.device_name !== "Shoggoth") throw Error("Incorrect authorization identity");
      data = { authorize_page_url: "https://pan.quark.cn/agent-oauth?offline=1", page_code: "offline-private-page", device_id: "offline-device" }; break;
    case "/agent/v1/oauth/get_aac_by_pagecode": data = fs.existsSync(path.join(process.env.HOME, "offline-denied-consent")) ? { status: "denied" } : { status: "success", agent_auth_code: "offline-private-auth-code" }; break;
    case "/agent/v1/oauth/agent_auth_code":
      if (url.searchParams.get("agent_id") !== "shoggoth") throw Error("Incorrect exchange identity");
      data = { status: "confirmed", access_token: "offline-access-private-canary", refresh_token: "offline-refresh-private-canary", user_id: "offline-user", device_id: "offline-device" }; break;
    case "/open/v1/user/info": data = { user_id: "offline-user", nickname: "Offline account" }; break;
    case "/agent/v1/oauth/access_token/rotate":
      if (fs.existsSync(expire)) fs.unlinkSync(expire);
      data = { access_token: "offline-rotated-access-canary", refresh_token: "offline-rotated-refresh-canary" }; break;
    case "/open/v1/user/get_vip_info": data = { vip_type: "NORMAL", used: 1, capacity: 1024 }; break;
    case "/agent/v1/file/search": data = { file_list: [], total: 0, has_more: false }; break;
    case "/open/v1/file/list": data = { file_list: [{ fid: "offline-fid", file_name: "report.txt", file_type: 1, category: 4, size: 5, created_at: 0, updated_at: 0 }], last_page: true }; break;
    case "/open/v1/dir": data = { fid: "offline-created-folder" }; break;
    case "/open/v1/file/info": data = { fid: "offline-created-folder", file_name: "Approved folder", full_path: [] }; break;
    default: throw Error("Unexpected offline API path: " + apiPath);
  }
  return Buffer.from(JSON.stringify({ status: 0, errno: 0, data }));
}
function request(options, callback) {
  const chunks = [], stream = new Writable({ write(chunk, encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
  stream.setTimeout = () => stream;
  stream.on("finish", () => {
    try {
      const input = Buffer.concat(chunks).toString("utf8"), bytes = response(options, input ? JSON.parse(input) : null);
      const incoming = Readable.from([bytes]); incoming.statusCode = 200; incoming.headers = { "content-type": "application/json", "content-length": String(bytes.length) };
      callback(incoming);
    } catch (error) { stream.emit("error", error); }
  });
  return stream;
}
require("node:https").request = request;
require("node:http").request = () => { throw Error("Offline test forbids HTTP"); };
for (const name of ["node:http", "node:https"]) require(name).get = () => { throw Error("Offline test forbids get"); };
require("node:net").connect = require("node:net").createConnection = () => { throw Error("Offline test forbids sockets"); };
global.fetch = () => { throw Error("Offline test forbids fetch"); };
