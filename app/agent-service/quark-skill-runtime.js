"use strict";

const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { atomicWritePrivateFile, readPrivateFile } = require("./private-file");
const { ensurePrivateDirectoryTree } = require("./security");
const { validOfficialVerificationUrl } = require("../core/official-skill-connector-dto");
const object = (properties = {}, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const text = (maxLength = 2048) => ({ type: "string", minLength: 1, maxLength, pattern: "^[^\\u0000-\\u001f\\u007f]+$" });
const fid = { ...text(512), pattern: "^[A-Za-z0-9_][A-Za-z0-9_.:-]*$" };
const fids = { type: "array", items: fid, minItems: 1, maxItems: 10000, uniqueItems: true };
const positive = (maximum = 100) => ({ type: "integer", minimum: 1, maximum });
const confirmed = { const: true }, page = { page: positive(100000), size: positive() };
const shareUrl = { ...text(8192), pattern: "^https://pan\\.quark\\.cn/s/[A-Za-z0-9]+(?:[/?#].*)?$" };
const write = (name, description, fields, required) => [name, description, object({ ...fields, confirmed }, [...required, "confirmed"]), true];
const TOOL_DEFS = [
  ["user_info", "Read the currently authorized Quark account and capacity.", object()],
  ["list_files", "List a Quark directory. Results may include a private resultId for complete paginated access.", object({ parentFid: fid, all: { type: "boolean" } })],
  ["search_files", "Search Quark once using the user's intended query. Keep file-type terms. Search results are the delivery unless the user also requested further action.", object({ keyword: text(50), size: positive(), searchType: { enum: ["mix", "video", "album", "doc", "audio", "dir", "package", "other", "app"] }, parentFid: fid }, ["keyword"])],
  ["result_files", "Read a page of a complete result previously returned by search_files or list_files. Use this to obtain all FIDs before a requested follow-up; the preview is incomplete.", object({ resultId: text(64), offset: { type: "integer", minimum: 0, maximum: 1000000 }, limit: positive() }, ["resultId"])],
  ["share_details", "Read one page from a Quark share link.", object({ url: shareUrl, passcode: text(32), parentFid: fid, ...page }, ["url"])],
  ["search_share", "Search files in a Quark share link.", object({ url: shareUrl, keyword: text(500), ...page }, ["url", "keyword"])],
  ["share_updates", "Read previously saved shares with new content.", object(page)],
  ["share_update_files", "Read new files in a selected share before asking whether to save them.", object({ url: shareUrl, page: positive(100000) }, ["url"])],
  ["share_saved_directory", "Read the destination used for a previous share save.", object({ url: shareUrl }, ["url"])],
  ["summarize_files", "Ask Quark AI to summarize selected files. Requires the account's AI entitlement. First search for FIDs; preserve the actual answer and membership notices.", object({ query: text(4000), fids }, ["query", "fids"])],
  ["ask_files", "Ask Quark AI a question grounded in selected files or directories. Requires the account's AI entitlement.", object({ query: text(4000), fids }, ["query", "fids"])],
  ["upload_tasks", "Read this connector's persisted upload tasks. Does not resume them.", object()],
  ["download_tasks", "Read this connector's persisted download tasks. Does not resume them.", object()],
  write("upload_file", "Upload exactly one user-selected regular local file after approval. Omit parentFid unless the user chose a destination; root is 0 only when explicitly requested.", { filePath: text(4096), parentFid: fid }, ["filePath"]),
  write("download_file", "Download a selected file into this connector's private downloads directory, without overwriting an existing file.", { fid }, ["fid"]),
  write("create_folder", "Create the requested Quark directory after approval.", { name: text(1024), parentFid: fid }, ["name"]),
  write("move_files", "Move the exact approved files to the selected destination.", { fids, targetFid: fid }, ["fids", "targetFid"]),
  write("share_files", "Create an approved share. Confirm files, visibility and expiration; the result includes the actual share link and any passcode.", { fids, title: text(200), visibility: { enum: ["private", "public"] }, expiration: { enum: ["permanent", "1d", "7d", "30d", "60d", "100d", "180d"] } }, ["fids", "visibility", "expiration"]),
  write("save_share", "Save approved files from a share. Omit destinationFid unless explicitly chosen. Omit fids to save the complete share.", { url: shareUrl, passcode: text(32), fids, destinationFid: fid }, ["url"]),
  write("save_share_update", "Save new files from a share into its previous destination only after checking the update and obtaining approval.", { url: shareUrl }, ["url"]),
  write("organize_photos", "Organize personal photos/videos with Quark AI; this command can create copies immediately. Confirm scope and organization rule before calling. Do not use for documents or explicit moves; no preliminary search is needed.", { query: text(4000) }, ["query"]),
  write("confirm_photo_organization", "Confirm this connector's Quark organization receipt and the user's chosen copy or move operation.", { receiptId: text(64), mode: { enum: ["copy", "move"] } }, ["receiptId", "mode"]),
  write("rename_files", "Rename the approved complete batch. Show old/new names, ordering and collision decisions first. Never retry an uncertain submission.", { items: { type: "array", minItems: 1, maxItems: 5000, items: object({ fid, oldName: text(255), newName: { ...text(255), pattern: "^[^/\\\\\\u0000-\\u001f\\u007f]+$" }, parentFid: fid }, ["fid", "oldName", "newName"]) } }, ["items"]),
  write("undo_rename", "Undo a completed rename batch created by this connector, after explicit approval.", { receiptId: text(64) }, ["receiptId"]),
  ["revocation_link", "Get Quark's official revocation page for the user to finish in the Quark Drive app. Returning the page does not revoke authorization.", object()],
];
const fail = (code = "OFFICIAL_SKILL_QUARK_FAILED") => { throw Object.assign(new Error(code), { code }); };
const uuid = value => typeof value === "string" && /^[a-f0-9-]{36}$/u.test(value);

function parseOutput(result) {
  const lines = [];
  for (const line of String(result.stdout).split(/\r?\n/u)) { try { const value = JSON.parse(line); if (value && typeof value === "object") lines.push(value); } catch {} }
  const finals = lines.filter(line => line.type === "result"), final = finals.at(-1);
  if (!final || result.code !== 0 || final.code !== 0) {
    const code = final?.providerCode ?? final?.code;
    if ([-102, -103, -107, -1408].includes(code)) fail("OFFICIAL_SKILL_QUARK_AUTH_REQUIRED");
    if (code === -104) fail("OFFICIAL_SKILL_RUNTIME_MISSING");
    if ([32003, 32004].includes(code)) fail("OFFICIAL_SKILL_QUARK_LIMITED");
    fail();
  }
  return { final, lists: lines.filter(line => line.type === "list").map(line => line.data), artifacts: lines.filter(line => line.type === "artifact").map(line => line.data) };
}
function publicQuark(value) {
  if (Array.isArray(value)) return value.map(publicQuark);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => !/token|page.?code|agent.?auth|cookie|authorization|secret|password/iu.test(key)).map(([key, item]) => [key, publicQuark(item)]));
  if (typeof value === "string") return value.replace(/([?&](?:access_token|refresh_token|agent_auth_code|page_code)=)[^&#\s]*/giu, "$1[redacted]");
  return value;
}

function createQuarkAdapter({ root, home, run, now = Date.now, account, guardedWrite }) {
  const stateFile = path.join(home, "quark-authorization.json"), receiptsFile = path.join(home, "quark-receipts.json");
  const save = state => atomicWritePrivateFile(stateFile, JSON.stringify(state), { trustedRoot: root });
  function load() {
    if (!fs.existsSync(stateFile)) return { version: 1, deviceId: crypto.randomUUID(), pending: null };
    const state = JSON.parse(readPrivateFile(stateFile, { maxBytes: 64 * 1024 }));
    if (state.version !== 1 || !uuid(state.deviceId) || state.pending && (typeof state.pending.pageCode !== "string" || !state.pending.pageCode || state.pending.pageCode.length > 8192
      || !validOfficialVerificationUrl("quark-drive", state.pending.url) || !Number.isFinite(state.pending.expiresAt) || !Number.isFinite(state.pending.nextPollAt))) fail("OFFICIAL_SKILL_INTEGRITY_FAILED");
    return state;
  }
  const invoke = async (input, signal, sideEffect = false) => parseOutput(await run("", [], { signal, applicationHelper: true, rawInput: JSON.stringify(input), timeoutMs: 120_000, sideEffect }));
  const pendingAccount = state => account("authorizing", { verificationUrl: state.pending.url });
  function receipts() {
    if (!fs.existsSync(receiptsFile)) return {};
    const value = JSON.parse(readPrivateFile(receiptsFile, { maxBytes: 512 * 1024 }));
    if (!value || Array.isArray(value) || typeof value !== "object" || Object.keys(value).length > 1000) fail("OFFICIAL_SKILL_INTEGRITY_FAILED");
    return value;
  }
  function remember(value) {
    const entries = receipts(); if (Object.keys(entries).length >= 1000) fail("OFFICIAL_SKILL_QUARK_LIMITED");
    const receiptId = crypto.randomUUID(); entries[receiptId] = value;
    atomicWritePrivateFile(receiptsFile, JSON.stringify(entries), { trustedRoot: root }); return receiptId;
  }
  function ownedFile(value) {
    if (typeof value !== "string" || !path.isAbsolute(value) || !value.startsWith(`${home}${path.sep}`)) fail("OFFICIAL_SKILL_INTEGRITY_FAILED");
    const relative = path.relative(home, value);
    if (!relative || relative.startsWith("..") || /(?:^|\/)(?:config\.json|quark-account\.json|quark-authorization\.json|operation-guards\.json|quark-receipts\.json)$/u.test(relative)) fail("OFFICIAL_SKILL_INTEGRITY_FAILED");
    let current = home;
    for (const part of relative.split(path.sep)) { current = path.join(current, part); if (fs.lstatSync(current).isSymbolicLink()) fail("OFFICIAL_SKILL_INTEGRITY_FAILED"); }
    return value;
  }
  function receiptFile(value) {
    if (typeof value !== "string" || path.isAbsolute(value) || value.split(/[\\/]/u).some(part => !part || part === "." || part === "..")) fail("OFFICIAL_SKILL_INTEGRITY_FAILED");
    return ownedFile(path.join(home, value));
  }
  async function accountAction(action, args, signal) {
    const state = load();
    if (action === "logout") {
      // Local exit never calls the vendor's remote logout/revoke command.
      const config = path.join(home, ".quarkclouddrive", "shoggoth", "config.json");
      if (fs.existsSync(config)) { if (fs.lstatSync(config).isSymbolicLink()) fail("OFFICIAL_SKILL_INTEGRITY_FAILED"); fs.unlinkSync(config); }
      state.pending = null; save(state); return account("signedOut");
    }
    if (action === "start") {
      const { final } = await invoke({ operation: "start", deviceId: state.deviceId }, signal);
      const data = final.data;
      if (!validOfficialVerificationUrl("quark-drive", data?.authorizePageUrl) || typeof data.pageCode !== "string" || !data.pageCode || data.pageCode.length > 8192) fail("OFFICIAL_SKILL_AUTH_FAILED");
      state.pending = { url: data.authorizePageUrl, pageCode: data.pageCode, expiresAt: now() + 5 * 60_000, nextPollAt: now() + 5000 };
      save(state); return pendingAccount(state);
    }
    if (action === "bind") {
      if (!state.pending || state.pending.expiresAt <= now() || !args.code || args.code.length > 4096) fail("OFFICIAL_SKILL_AUTH_FAILED");
      const { final } = await invoke({ operation: "bind", deviceId: state.deviceId, code: args.code }, signal);
      if (!["ready", "unknown"].includes(final.data?.state)) fail("OFFICIAL_SKILL_AUTH_FAILED");
      state.pending = null; save(state); return account(final.data.state, { userName: final.data.userName || null, errorCode: final.data.state === "unknown" ? "OFFICIAL_SKILL_AUTH_STATUS_FAILED" : null });
    }
    if (action !== "status") fail("OFFICIAL_SKILL_INVALID_ARGUMENT");
    if (state.pending) {
      if (state.pending.expiresAt <= now()) { state.pending = null; save(state); return account("signedOut", { errorCode: "OFFICIAL_SKILL_AUTH_FAILED" }); }
      if (state.pending.nextPollAt > now()) return pendingAccount(state);
      state.pending.nextPollAt = now() + 5000; save(state);
      const { final } = await invoke({ operation: "poll", deviceId: state.deviceId, pageCode: state.pending.pageCode }, signal);
      if (final.data?.state === "authorizing") return pendingAccount(state);
      if (final.data?.state === "signedOut") { state.pending = null; save(state); return account("signedOut", { errorCode: "OFFICIAL_SKILL_AUTH_FAILED" }); }
      if (!["ready", "unknown"].includes(final.data?.state)) fail("OFFICIAL_SKILL_AUTH_FAILED");
      state.pending = null; save(state); return account(final.data.state, { userName: final.data.userName || null, errorCode: final.data.state === "unknown" ? "OFFICIAL_SKILL_AUTH_STATUS_FAILED" : null });
    }
    try {
      const { final } = await invoke({ operation: "status" }, signal);
      if (!["signedOut", "ready"].includes(final.data?.state)) fail();
      return account(final.data.state, { userName: final.data.userName || null });
    } catch (error) {
      if (signal?.aborted || ["OFFICIAL_SKILL_INTEGRITY_FAILED", "OFFICIAL_SKILL_RUNTIME_MISSING"].includes(error.code)) throw error;
      return account("unknown", { errorCode: error.code === "OFFICIAL_SKILL_QUARK_AUTH_REQUIRED" ? error.code : "OFFICIAL_SKILL_AUTH_STATUS_FAILED" });
    }
  }
  async function execute(name, args, signal) {
    if (name === "result_files") {
      const entry = receipts()[args.resultId];
      if (!entry || entry.kind !== "result") fail("OFFICIAL_SKILL_INVALID_ARGUMENT");
      const contents = readPrivateFile(receiptFile(entry.file), { maxBytes: 32 * 1024 * 1024 }).toString("utf8");
      const all = contents.split(/\r?\n/u).filter(Boolean), offset = args.offset || 0, limit = args.limit || 100;
      return { ok: true, total: all.length, offset, files: publicQuark(all.slice(offset, offset + limit).map(line => JSON.parse(line))), hasMore: offset + limit < all.length };
    }
    const flag = (key, value) => value === undefined ? [] : [key, String(value)];
    const definitions = new Map(TOOL_DEFS.map(definition => [definition[0], definition]));
    let argv;
    switch (name) {
      case "user_info": argv = ["get-user-info"]; break;
      case "list_files": argv = ["browse", ...flag("--parent-fid", args.parentFid), ...(args.all ? ["--all"] : [])]; break;
      case "search_files": argv = ["search", "--keyword", args.keyword, "--stdout-only", ...flag("--size", args.size), ...flag("--search-type", args.searchType), ...flag("--parent-fid", args.parentFid)]; break;
      case "share_details": argv = ["share-detail", "--url", args.url, ...flag("--passcode", args.passcode), ...flag("--page", args.page), ...flag("--size", args.size), ...flag("--pdir-fid", args.parentFid)]; break;
      case "search_share": argv = ["share-search", "--url", args.url, "--keyword", args.keyword, ...flag("--page", args.page), ...flag("--size", args.size)]; break;
      case "share_updates": argv = ["get-share-update-list", ...flag("--page", args.page), ...flag("--size", args.size)]; break;
      case "share_update_files": argv = ["get-share-update-files", "--url", args.url, ...flag("--page", args.page)]; break;
      case "share_saved_directory": argv = ["get-share-saved-dir", "--url", args.url]; break;
      case "summarize_files": case "ask_files": argv = [name === "ask_files" ? "qa" : "summary", "--query", args.query, "--fid-list", args.fids.join(",")]; break;
      case "upload_tasks": argv = ["upload", "list"]; break;
      case "download_tasks": argv = ["download", "list"]; break;
      case "upload_file": {
        if (!path.isAbsolute(args.filePath) || fs.realpathSync(args.filePath) !== path.normalize(args.filePath)
          || !fs.lstatSync(args.filePath).isFile() || args.filePath === root || args.filePath.startsWith(`${root}/`)) fail("OFFICIAL_SKILL_INVALID_ARGUMENT");
        argv = ["upload", "--file-path", args.filePath, ...flag("--parent-fid", args.parentFid)]; break;
      }
      case "download_file": {
        const directory = path.join(home, "downloads", crypto.randomUUID()); ensurePrivateDirectoryTree(directory, home);
        argv = ["download", "--fid", args.fid, "--output-dir", directory]; break;
      }
      case "create_folder": argv = ["create-folder", "--dir-path", args.name, ...flag("--parent-fid", args.parentFid)]; break;
      case "move_files": argv = ["move", ...args.fids, "--target-fid", args.targetFid]; break;
      case "share_files": argv = ["share", ...args.fids, "--url-type", args.visibility === "private" ? "2" : "1", "--expired-type", String(["permanent", "1d", "7d", "30d", "60d", "100d", "180d"].indexOf(args.expiration) + 1), ...flag("--title", args.title)]; break;
      case "save_share": argv = ["saveas", "--url", args.url, ...flag("--passcode", args.passcode), ...flag("--fid-list", args.fids?.join(",")), ...flag("--to-pdir-fid", args.destinationFid)]; break;
      case "save_share_update": argv = ["saveas-update", "--url", args.url]; break;
      case "organize_photos": argv = ["organize", "--query", args.query]; break;
      case "confirm_photo_organization": {
        const entry = receipts()[args.receiptId]; if (entry?.kind !== "organization" || typeof entry.taskId !== "string") fail("OFFICIAL_SKILL_INVALID_ARGUMENT");
        argv = [args.mode === "move" ? "organize-move" : "organize-copy", "--task-id", entry.taskId]; break;
      }
      case "rename_files": {
        if (new Set(args.items.map(item => item.fid)).size !== args.items.length) fail("OFFICIAL_SKILL_INVALID_ARGUMENT");
        const file = path.join(home, "rename", crypto.randomUUID(), "items.json"); ensurePrivateDirectoryTree(path.dirname(file), home);
        atomicWritePrivateFile(file, JSON.stringify({ schema_version: 1, items: args.items.map(item => ({ fid: item.fid, old_name: item.oldName, new_name: item.newName, ...(item.parentFid ? { parent_fid: item.parentFid } : {}) })) }), { trustedRoot: root });
        argv = ["rename", "--items-file", file]; break;
      }
      case "undo_rename": {
        const entry = receipts()[args.receiptId]; if (entry?.kind !== "rename" || !/^[a-f0-9]{16}$/u.test(entry.batchId)) fail("OFFICIAL_SKILL_INVALID_ARGUMENT");
        argv = ["rename-revert", "--batch-id", entry.batchId, "--record-file", receiptFile(entry.file)]; break;
      }
      case "revocation_link": argv = ["unauthorize"]; break;
      default: fail("OFFICIAL_SKILL_INVALID_ARGUMENT");
    }
    const sideEffect = definitions.get(name)?.[3] === true;
    const operation = async () => {
      const result = await invoke({ operation: "command", args: argv }, signal, sideEffect);
      const data = publicQuark(result.final.data), output = { ok: true, data, ...(result.lists.length ? { files: publicQuark(result.lists) } : {}), ...(result.final.msg ? { message: publicQuark(result.final.msg) } : {}), ...(result.final.notice ? { notice: publicQuark(result.final.notice) } : {}) };
      for (const artifact of result.artifacts) if (artifact?.file_path) {
        const file = ownedFile(artifact.file_path);
        if (!file.endsWith(".jsonl")) fail("OFFICIAL_SKILL_INTEGRITY_FAILED");
        output.resultId = remember({ kind: "result", file: path.relative(home, file) });
      }
      if (name === "rename_files" && data?.record_file && /^[a-f0-9]{16}$/u.test(data.batch_id || "")) output.receiptId = remember({ kind: "rename", file: path.relative(home, ownedFile(data.record_file)), batchId: data.batch_id });
      if (name === "organize_photos" && result.final.needsConfirmation === true && typeof data?.task_id === "string") { output.confirmationRequired = true; output.receiptId = remember({ kind: "organization", taskId: data.task_id }); }
      if (name === "revocation_link") {
        if (!validOfficialVerificationUrl("quark-drive", data?.revokeUrl)) fail();
        return { ok: true, url: data.revokeUrl, revoked: false, message: "请在夸克网盘独立端 App 完成解除授权，或进入：我的 → 登录授权管理 → 其他 AI 助手授权。" };
      }
      return output;
    };
    // A cloud write is not complete until its private receipt can be saved.
    // Disk or validation failure after dispatch must keep replay blocked too.
    return sideEffect ? guardedWrite(`quark:${name}`, args, operation) : operation();
  }
  return { account: accountAction, execute };
}
module.exports = { TOOL_DEFS, createQuarkAdapter, parseOutput, publicQuark };
