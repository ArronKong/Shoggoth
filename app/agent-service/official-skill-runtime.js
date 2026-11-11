"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const Ajv = require("ajv");
const { createMcpFetch } = require("./mcp-http-fetch");
const { assertPrivateDirectory, ensurePrivateDirectoryTree } = require("./security");
const { atomicWritePrivateFile, readPrivateFile } = require("./private-file");
const { validateOfficialAccountResult, validOfficialVerificationUrl } = require("../core/official-skill-connector-dto");

const fail = (code = "OFFICIAL_SKILL_AUTH_FAILED") => { throw Object.assign(new Error(code), { code }); };
const object = (properties = {}, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const string = (maxLength = 2048) => ({ type: "string", minLength: 1, maxLength, pattern: "^[^\\u0000-\\u001f\\u007f]+$" });
const integer = (maximum = 100000000000) => ({ type: "integer", minimum: 0, maximum });
const id = { ...string(128), pattern: "^[A-Za-z0-9_-]+$" };
const confirm = { const: true };
const pagination = { count: { type: "integer", minimum: 1, maximum: 100 }, maxIdx: integer() };
const address = object({ lat: { type: "integer", minimum: -90000000, maximum: 90000000 }, lng: { type: "integer", minimum: -180000000, maximum: 180000000 }, address: string(500), houseNumber: { ...string(200), minLength: 0 }, name: { ...string(100), minLength: 0 }, phone: { ...string(30), pattern: "^[+0-9 -]+$" }, cityId: { anyOf: [integer(), id] } }, ["lat", "lng", "address", "phone"]);
const deliveryFields = { sender: address, recipient: address, goods: object({ goodsName: string(200), goodsWeight: { type: "number", exclusiveMinimum: 0, maximum: 1000 }, goodTypes: { type: "array", items: integer(9), minItems: 1, maxItems: 1 }, goodTypeNames: { type: "array", items: string(30), minItems: 1, maxItems: 1 } }, ["goodsName"]), businessType: { enum: ["1", "2"] }, bizTypeSceneTag: { enum: ["0", "1", "2", "3", "4", "5", "6"] }, businessTypeTag: { enum: ["0", "1"] }, serviceType: { enum: ["1003", "4033"] }, tipFee: integer(1000000), purchaseDetail: string(1000) };
const TOOL_DEFS = {
  doordash: require("./doordash-skill-runtime").TOOL_DEFS,
  shop: [],
  "quark-drive": require("./quark-skill-runtime").TOOL_DEFS,
  "baidu-maps": require("./baidu-map-skill-runtime").TOOL_DEFS,
  "rollinggo-hotel": require("./rollinggo-skill-runtime").TOOL_DEFS,
  fliggy: [["travel_search", "Search official travel products, flights, hotels and attractions. Trial access may return limited results.", object({ query: string(2000) }, ["query"])]],
  weread: [
    ["search_books", "Search WeRead. Choose scope from the user's intent; results are one page, not a total count.", object({ keyword: string(500), scope: { enum: [0, 10, 16, 14, 6, 12, 13, 2, 4] }, ...pagination }, ["keyword", "scope"])],
    ["bookshelf", "Read your bookshelf; total entries include books, albums and the mp entry.", object()],
    ["book_info", "Read book metadata by bookId from a search or shelf result.", object({ bookId: id }, ["bookId"])],
    ["notebooks", "Read personal notebooks. Note count includes reviews, highlights and bookmarks.", object({ count: pagination.count, lastSort: integer() })],
    ["book_notes", "Read a book's highlights. Bookmark content is not exported by this endpoint.", object({ bookId: id }, ["bookId"])],
    ["reading_stats", "Read statistics; duration fields use seconds, and totalReadTime is the total.", object({ mode: { enum: ["weekly", "monthly", "annually", "overall"] }, baseTime: integer() })],
    ["recommend_books", "Read personalized book recommendations.", object(pagination)],
  ],
  "meituan-paotui": [
    ["search_address", "Search a delivery address. Does not place an order.", object({ keyword: string(500), city: string(100) }, ["keyword"])],
    ["address_book", "Read the account address book; returned phone numbers may be masked.", object()],
    ["address_phone", "Read the phone number needed for a selected saved address.", object({ addressId: id }, ["addressId"])],
    ["delivery_preview", "Preview delivery price and details. Show the result and ask for explicit confirmation before submit_order.", object(deliveryFields, ["sender", "recipient", "goods"])],
    ["submit_order", "Create a paid delivery order from the exact unexpired preview after the user confirms. Requires a second confirmation above 100 yuan.", object({ previewId: id, confirmed: confirm, highValueConfirmed: confirm, remark: string(1000) }, ["previewId", "confirmed"]), true],
    ["order_status", "Read the status of a delivery order.", object({ orderId: id }, ["orderId"])],
  ],
  alipay: [
    ["submit_payment", "Submit an Alipay cashier payment after explicit user approval in a supported current session. The application supplies the actual session identity; callers cannot choose or invent it. The amount, payee and purpose are the caller's current order summary; this tool does not verify that they match the cashier URL. Present the provider's actual confirmation, never claim the summary was independently verified. This may perform a payment; never use it for a connection test.", object({ cashierLink: string(8192), amountYuan: { type: "number", minimum: 0.01, maximum: 1000000, description: "Amount from the current order, explicitly confirmed by the user." }, payee: { ...string(200), description: "Payee from the current order, explicitly confirmed by the user." }, purpose: string(500), confirmed: confirm }, ["cashierLink", "amountYuan", "payee", "purpose", "confirmed"]), true],
    ["payment_status", "Query only a payment initiated by this connector using the returned receiptId. A receiptId is valid only during this connection process. After restart or if it is unavailable, the payment outcome is unknown: check the actual status in Alipay and do not resubmit the payment.", object({ receiptId: id }, ["receiptId"])],
  ],
};
const ACCOUNT_DEFS = [
  ["account_status", "Check the actual account or service state without creating an order or payment.", object()],
  ["account_start", "Start provider authorization. The user must finish in the official application.", object(), true],
  ["account_bind", "Finish a pending authorization after user action. A code is accepted only for Alipay.", object({ code: string(1024) }), true],
  ["account_logout", "Clear local sign-in, or return Alipay's official revocation link for the user to finish.", object(), true],
];

function parseJson(text) {
  const clean = String(text).replace(/\u001b\[[0-9;]*m/gu, "").trim();
  try { return JSON.parse(clean); } catch {}
  for (const line of clean.split(/\r?\n/u).reverse()) { try { const value = JSON.parse(line); if (value && typeof value === "object") return value; } catch {} }
  // Some official CLIs pretty-print JSON after a banner. Only accept a complete
  // suffix, never a JSON fragment lifted from a diagnostic log line.
  for (let index = clean.lastIndexOf("\n{"); index >= 0; index = clean.lastIndexOf("\n{", index - 1)) { try { return JSON.parse(clean.slice(index + 1)); } catch {} }
  return null;
}
function publicOutput(value, secrets = []) {
  if (Array.isArray(value)) return value.map(item => publicOutput(item, secrets));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => !/(?:^|_)(?:access_?token|refresh_?token|api_?key|private_?key|cookie|authorization|secret|password)(?:$|_)/iu.test(key)
    && !/^(?:accessToken|refreshToken|apiKey|privateKey|orderToken|outShakeNo)$/u.test(key)).map(([key, item]) => [key, publicOutput(item, secrets)]));
  if (typeof value === "string") { let result = value; for (const secret of secrets.filter(secret => typeof secret === "string" && secret.length >= 6)) result = result.split(secret).join("[redacted]"); return result; }
  return value;
}
function commandEnvironment(providerId, home, env, extra = {}, native = false) {
  const safe = { HOME: home, TMPDIR: path.join(home, "tmp"), XDG_CONFIG_HOME: path.join(home, ".config"), XDG_CACHE_HOME: path.join(home, ".cache"), PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "en_US.UTF-8", NO_COLOR: "1", CI: "1" };
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"]) if (env[key]) safe[key] = env[key];
  if (!native) safe.ELECTRON_RUN_AS_NODE = "1";
  if (providerId === "fliggy" && env.FLYAI_API_KEY) safe.FLYAI_API_KEY = env.FLYAI_API_KEY;
  if (providerId === "meituan-paotui") safe.PT_PASSPORT_AUTH_FILE = path.join(home, "passport-auth.json");
  if (providerId === "doordash") safe.PYTHON_KEYRING_BACKEND = "keyring.backends.null.Keyring";
  // The macOS package installs PayGuard in the OS user's Library. Point only
  // the pinned CLI's helper installer there; keep its wallet HOME isolated.
  // userInfo() consults the OS account rather than an inherited HOME override.
  if (providerId === "alipay" && native && process.platform === "darwin") safe.PAYGUARD_INSTALL_DIR = path.join(os.userInfo().homedir, "Library", "Application Support", "com.alipay.agent.payguard", "PayGuard.app");
  return { ...safe, ...extra };
}

// Existing Alipay homes contain these non-credential cache/log paths as
// 0755/0644. Tighten only those known paths beneath the
// already-private HOME; unknown files and unsafe links still fail closed.
const ALIPAY_READABLE_HOME_PATHS = new Map([
  ...["Library", "Library/Logs", "Library/LaunchAgents", "Library/Application Support", "Library/Application Support/com.alipay.agent.payguard"].map(relative => [relative, "directory"]),
  ...[".alipay-bot-cli/environment-detection-cache.json", "Library/Logs/com.alipay.agent.payguard.install.log", "Library/Logs/com.alipay.agent.payguard.preinstall.log"].map(relative => [relative, "file"]),
]);
function assertManagedHome(home, { repairAlipayPermissions = false } = {}) {
  assertPrivateDirectory(home);
  const repairs = [];
  let count = 0;
  const walk = directory => {
    for (const entry of fs.readdirSync(directory)) {
      if (++count > 10000) fail("OFFICIAL_SKILL_INTEGRITY_FAILED");
      const target = path.join(directory, entry), stat = fs.lstatSync(target);
      if (stat.isSymbolicLink() || process.getuid && stat.uid !== process.getuid()) fail("OFFICIAL_SKILL_INTEGRITY_FAILED");
      if ((!stat.isDirectory() && !stat.isFile() && !stat.isSocket()) || stat.isFile() && stat.nlink !== 1) fail("OFFICIAL_SKILL_INTEGRITY_FAILED");
      if ((stat.isDirectory() || stat.isFile()) && (stat.mode & 0o077) !== 0) {
        const kind = stat.isDirectory() ? "directory" : "file";
        const relative = path.relative(home, target).split(path.sep).join("/");
        if (!repairAlipayPermissions || ALIPAY_READABLE_HOME_PATHS.get(relative) !== kind
          || (stat.mode & 0o777) !== (stat.isDirectory() ? 0o755 : 0o644)) fail("OFFICIAL_SKILL_INTEGRITY_FAILED");
        repairs.push({ target, stat });
      }
      if (stat.isDirectory()) walk(target);
    }
  };
  walk(home);
  // Validate the entire tree before changing any mode. Pin each inode without
  // following links so permission repair cannot affect a replaced target.
  for (const { target, stat } of repairs) {
    let fd;
    try {
      fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0)
        | (stat.isDirectory() ? fs.constants.O_DIRECTORY || 0 : 0));
      const opened = fs.fstatSync(fd);
      if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.uid !== stat.uid || opened.mode !== stat.mode
        || opened.isFile() && opened.nlink !== 1) fail("OFFICIAL_SKILL_INTEGRITY_FAILED");
      fs.fchmodSync(fd, stat.mode & 0o700);
      if ((fs.fstatSync(fd).mode & 0o077) !== 0) fail("OFFICIAL_SKILL_INTEGRITY_FAILED");
    } catch { fail("OFFICIAL_SKILL_INTEGRITY_FAILED"); }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  if (repairs.length) assertManagedHome(home);
}

function createOfficialSkillRuntime({ providerId, root, home, env = process.env, spawn: spawnImpl = spawn, fetch: fetchImpl, validate = () => {}, now = Date.now } = {}) {
  if (!TOOL_DEFS[providerId]) fail("OFFICIAL_SKILL_INVALID_ARGUMENT");
  if (providerId === "baidu-maps") env = { ...env, BAIDU_MAP_AUTH_TOKEN: env.BAIDU_MAP_AUTH_TOKEN?.trim() };
  const fetch = fetchImpl || createMcpFetch({ env }), children = new Set(), previews = new Map(), payments = new Map(), secrets = [];
  for (const key of ["FLYAI_API_KEY", "WEREAD_API_KEY", "BAIDU_MAP_AUTH_TOKEN"]) if (env[key]) secrets.push(env[key]);
  const accountDefinitions = providerId === "quark-drive" ? ACCOUNT_DEFS.map(([name, description, schema, write]) => [name,
    name === "account_bind" ? "Finish Quark authorization with the code entered only in the connector's private window. Never request it in chat." : description,
    name === "account_bind" ? object({ code: string(4096) }, ["code"]) : schema, write]) : providerId === "doordash" ? ACCOUNT_DEFS.map(([name, description, schema, write]) => [name,
    name === "account_bind" ? "Finish DoorDash PKCE authorization using the full callback URL entered in the connector's private window. Never ask the user to paste this URL or a token in chat." : description,
    name === "account_bind" ? object({ code: string(8192) }, ["code"]) : schema, write]) : ACCOUNT_DEFS;
  const definitions = [...(providerId === "baidu-maps" ? accountDefinitions.filter(([name]) => name === "account_status") : accountDefinitions), ...(providerId === "shop" ? require("./shop-skill-runtime").getShopToolDefs(root) : TOOL_DEFS[providerId])];
  const ajv = providerId === "shop" ? require("./shop-skill-runtime").createValidator() : new Ajv({ strict: false, allErrors: false });
  if (providerId === "doordash") ajv.addFormat("uuid", /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu);
  const validators = new Map(definitions.map(([name, , schema]) => [name, ajv.compile(schema)]));
  const tools = definitions.map(([name, description, inputSchema, write = false]) => ({ name, description, inputSchema,
    annotations: { readOnlyHint: !write, destructiveHint: write, idempotentHint: !write, openWorldHint: true } }));
  let authorization = null, chain = Promise.resolve(), poisoned = false, closed = false;
  const account = (state, fields = {}) => validateOfficialAccountResult({ id: providerId, state, verificationUrl: null, qrCode: null, userCode: null, userName: null, errorCode: null, ...fields });
  const stable = value => value && typeof value === "object" ? Array.isArray(value) ? value.map(stable) : Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
  async function guardedWrite(kind, payload, operation, { sessionId = null, keepCompleted = false } = {}) {
    const file = path.join(home, "operation-guards.json"), digest = crypto.createHash("sha256").update(JSON.stringify([kind, stable(payload)])).digest("hex");
    let ledger = { schemaVersion: 1, operations: [] };
    if (fs.existsSync(file)) ledger = JSON.parse(readPrivateFile(file, { maxBytes: 512 * 1024 }));
    if (ledger?.schemaVersion !== 1 || !Array.isArray(ledger.operations) || ledger.operations.length > 1000
      || ledger.operations.some(item => !/^[a-f0-9]{64}$/u.test(item.digest) || !["pending", "unknown", "complete"].includes(item.state))) fail("OFFICIAL_SKILL_OPERATION_UNCERTAIN");
    if (ledger.operations.some(item => item.digest === digest)) fail("OFFICIAL_SKILL_OPERATION_UNCERTAIN");
    const record = { digest, state: "pending", sessionId, createdAt: now() };
    ledger.operations.push(record);
    const save = () => atomicWritePrivateFile(file, JSON.stringify(ledger), { trustedRoot: root });
    save();
    try {
      const result = await operation(); record.state = "complete";
      if (!keepCompleted) ledger.operations = ledger.operations.filter(item => item !== record);
      save(); return result;
    } catch (error) {
      // Shop documents HTTP 401 as a refusal before tool dispatch. It may be
      // retried after explicit sign-in without treating it as an unknown write.
      if (error.shopNotDispatched === true) { ledger.operations = ledger.operations.filter(item => item !== record); save(); throw error; }
      record.state = "unknown"; try { save(); } catch { poisoned = true; }
      throw Object.assign(new Error("uncertain result"), { code: "OFFICIAL_SKILL_OPERATION_UNCERTAIN" });
    }
  }
  function officialUrl(value) { return typeof value === "string" && validOfficialVerificationUrl(providerId, value) ? value : null; }
  function resultUrl(result, text) {
    const candidates = [result?.verification_url, result?.verificationUrl, result?.auth_link, result?.direct_auth_link, result?.auth_url, result?.authUrl, result?.url, result?.access_url, result?.shortUrl, result?.data?.access_url, result?.data?.url];
    for (const value of candidates) { const checked = officialUrl(value); if (checked) return checked; }
    for (const line of String(text).split(/\r?\n/u).filter(line => !/(?:http request|http response|traceId|costTime|accessUrl|extInfo)/iu.test(line))) {
      for (const value of line.match(/https:\/\/[^\s<>"')\]]+/gu) || []) { const checked = officialUrl(value); if (checked) return checked; }
    }
    return null;
  }
  function terminate(child) { try { if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGTERM"); else child.kill("SIGTERM"); } catch {} }
  async function stopActiveChildren() {
    const active = [...children];
    await Promise.all(active.map(child => new Promise(resolve => {
      if (child.exitCode !== null && child.exitCode !== undefined) { resolve(); return; }
      let settled = false, killTimer, endTimer;
      const finish = () => { if (settled) return; settled = true; clearTimeout(killTimer); clearTimeout(endTimer); resolve(); };
      child.once("close", finish);
      killTimer = setTimeout(() => { try { if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch {} }, 1500);
      endTimer = setTimeout(() => { poisoned = true; finish(); }, 3000);
      terminate(child);
    })));
  }
  function run(relative, args, { signal, extraEnv = {}, native = false, timeoutMs = 100_000, onAuthorization, onExit, rawInput, applicationHelper = false, sideEffect = false } = {}) {
    validate(); signal?.throwIfAborted();
    if (poisoned || closed) fail("OFFICIAL_SKILL_OPERATION_UNCERTAIN");
    assertManagedHome(home, { repairAlipayPermissions: providerId === "alipay" });
    for (const directory of [home, path.join(home, "tmp"), path.join(home, ".config"), path.join(home, ".cache")]) {
      if (directory === home) assertPrivateDirectory(home); else ensurePrivateDirectoryTree(directory, home);
    }
    if (providerId === "meituan-paotui") {
      const guardDir = path.join(home, ".cliguard"), guard = path.join(guardDir, "cliguard-updates");
      ensurePrivateDirectoryTree(guardDir, home);
      const marker = "Managed pinned runtime; automatic executable updates are disabled.\n";
      if (!fs.existsSync(guard)) fs.writeFileSync(guard, marker, { flag: "wx", mode: 0o600 });
      else if (readPrivateFile(guard, { maxBytes: 1024 }).toString() !== marker) fail("OFFICIAL_SKILL_INTEGRITY_FAILED");
    }
    return new Promise((resolve, reject) => {
      const executable = applicationHelper ? path.join(__dirname, providerId === "quark-drive" ? "quark-skill-cli-helper.js" : "rollinggo-skill-cli-helper.js") : path.join(root, relative);
      const child = spawnImpl(native ? executable : process.execPath, native ? args : ["--require", path.join(__dirname, "official-skill-child-bootstrap.js"), executable, ...args], {
        cwd: home, env: commandEnvironment(providerId, home, env, extraEnv, native), stdio: [rawInput === undefined ? "ignore" : "pipe", "pipe", "pipe"], shell: false, detached: process.platform !== "win32", windowsHide: true,
      });
      if (rawInput !== undefined) { child.stdin.on("error", () => {}); child.stdin.end(rawInput); }
      children.add(child); let stdout = "", stderr = "", done = false, handedOff = false, limit = 0, stopError, killTimer, endTimer;
      const finish = (error, result) => {
        if (done) return; done = true;
        if (!handedOff) { clearTimeout(timer); clearTimeout(killTimer); clearTimeout(endTimer); }
        signal?.removeEventListener("abort", cancel); if (error) reject(error); else resolve(result);
      };
      const requestStop = code => {
        if (stopError) return;
        stopError = Object.assign(new Error("stopped"), { code: sideEffect ? "OFFICIAL_SKILL_OPERATION_UNCERTAIN" : code });
        terminate(child);
        killTimer = setTimeout(() => { try { if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch {} }, 1500);
        endTimer = setTimeout(() => { poisoned = true; finish(Object.assign(new Error("unconfirmed exit"), { code: "OFFICIAL_SKILL_OPERATION_UNCERTAIN" })); }, 3000);
      };
      const cancel = () => requestStop("OFFICIAL_SKILL_AUTH_CANCELLED");
      const timer = setTimeout(() => requestStop("OFFICIAL_SKILL_AUTH_FAILED"), timeoutMs); timer.unref?.();
      signal?.addEventListener("abort", cancel, { once: true });
      const append = (chunk, stream) => {
        limit += chunk.length; if (limit > 2 * 1024 * 1024) { requestStop("OFFICIAL_SKILL_AUTH_FAILED"); return; }
        if (stream === "stdout") stdout += chunk.toString("utf8"); else stderr += chunk.toString("utf8");
        if (!handedOff && onAuthorization) { const result = onAuthorization(stdout, stderr); if (result) { handedOff = true; finish(null, { code: null, stdout, stderr, authorization: result }); } }
      };
      child.stdout?.on("data", chunk => append(chunk, "stdout")); child.stderr?.on("data", chunk => append(chunk, "stderr"));
      child.once("error", () => { children.delete(child); const error = Object.assign(new Error("runtime"), { code: "OFFICIAL_SKILL_RUNTIME_MISSING" }); onExit?.(error); finish(error); });
      child.once("close", code => {
        terminate(child); children.delete(child); clearTimeout(timer); clearTimeout(killTimer); clearTimeout(endTimer);
        let error = stopError || (sideEffect && code !== 0 ? Object.assign(new Error("uncertain result"), { code: "OFFICIAL_SKILL_OPERATION_UNCERTAIN" }) : null);
        try { if (providerId === "alipay") assertManagedHome(home, { repairAlipayPermissions: true }); }
        catch (homeError) { error ||= homeError; }
        onExit?.(error || (code !== 0 ? failure() : null));
        finish(error, { code, stdout, stderr });
      });
    });
  }
  function failure() { return Object.assign(new Error("provider failed"), { code: "OFFICIAL_SKILL_AUTH_FAILED" }); }
  function successful(result) {
    const parsed = parseJson(result.stdout);
    if (result.code !== 0 || parsed?.success === false || parsed?.isError === true || parsed?.errcode && parsed.errcode !== 0 || parsed?.error && !parsed?.data) throw failure();
    return parsed ?? { output: result.stdout.trim() };
  }
  async function weread(api, args, signal) {
    if (!env.WEREAD_API_KEY) fail("OFFICIAL_SKILL_AUTH_UNSUPPORTED");
    const response = await fetch("https://i.weread.qq.com/api/agent/gateway", { method: "POST", redirect: "error", signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30_000)]),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.WEREAD_API_KEY}` }, body: JSON.stringify({ ...args, api_name: api, skill_version: "1.0.5" }) });
    if (!response.ok) throw failure();
    const text = await response.text(); if (text.length > 2 * 1024 * 1024) throw failure();
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || value.errcode !== undefined && value.errcode !== 0 || value.upgrade_info) throw failure();
    return value;
  }
  const passport = (args, options) => run("runtime/passport/dist/index.js", args, options);
  const clientArgs = ["--client_id", "ac76c22d257c4c6d9164719eea64ed4b", "--env", "prod"];
  async function meituanToken(signal) {
    const result = await passport(["get-token", ...clientArgs], { signal });
    const token = result.stdout.trim(); if (result.code !== 0 || !token || token.length > 32768 || !/^[\x21-\x7e]+$/u.test(token)) throw failure();
    secrets.push(token); return token;
  }
  async function paotui(args, signal, guardPayload) {
    const token = await meituanToken(signal), operation = async () => successful(await run("runtime/paotui.js", args, { signal, extraEnv: { MCP_ACCESS_TOKEN: token }, sideEffect: args[0] === "submit_order" }));
    return guardPayload ? guardedWrite("delivery", guardPayload, operation) : operation();
  }
  const alipay = (args, options) => run("runtime/alipay-bot", [...args, "--json"], { ...options, native: true });

  const shopAuth = providerId === "shop" ? require("./shop-skill-auth").createShopAuth({ root, home, fetch, now }) : null;
  const baidu = providerId === "baidu-maps" ? require("./baidu-map-skill-runtime").createBaiduMapAdapter({ fetch, env, account, now }) : null;
  const quark = providerId === "quark-drive" ? require("./quark-skill-runtime").createQuarkAdapter({ root, home, run, now, account, guardedWrite }) : null;
  const rollinggo = providerId === "rollinggo-hotel" ? require("./rollinggo-skill-runtime").createRollingGoAdapter({ root, home, run, now, account, guardedWrite, stopActiveChildren, parseJson }) : null;
  const shop = shopAuth ? require("./shop-skill-runtime").createShopAdapter({ now, account, guardedWrite, auth: shopAuth,
    client: require("./shop-mcp-client").createShopMcpClient({ fetch, getToken: () => shopAuth.getToken() }) }) : null;
  const doordash = providerId === "doordash" ? require("./doordash-skill-runtime").createDoorDashAdapter({ root, home, now, account, guardedWrite, parseJson,
    rememberSecret: value => { if (!secrets.includes(value)) secrets.push(value); }, run: (args, options) => run("runtime/dd-cli", args, { ...options, native: true }) }) : null;
  async function accountAction(action, args, signal) {
    if (baidu) return baidu.account(action, args, signal);
    if (rollinggo) return rollinggo.account(action, args, signal);
    if (quark) return quark.account(action, args, signal);
    if (doordash) return doordash.account(action, args, signal);
    if (args.code !== undefined && (providerId !== "alipay" || action !== "bind" || !/^\d{6}$/u.test(args.code))) fail("OFFICIAL_SKILL_INVALID_ARGUMENT");
    if (shop) return shop.account(action, signal);
    if (providerId === "weread" || providerId === "fliggy") {
      if (action !== "status") return account("unknown", { errorCode: "OFFICIAL_SKILL_AUTH_UNSUPPORTED" });
      if (providerId === "weread") { if (!env.WEREAD_API_KEY) return account("signedOut"); await weread("/_list", {}, signal); }
      else successful(await run("runtime/dist/flyai-bundle.cjs", ["keyword-search", "--query", "杭州旅行"], { signal }));
      return account("ready");
    }
    if (providerId === "meituan-paotui") {
      if (action === "logout") { successful(await passport(["logout", ...clientArgs], { signal })); authorization = null; return account("signedOut"); }
      if (action === "start") {
        authorization = null;
        const result = await passport(["auth", "get-code", ...clientArgs, "--json"], { signal }), parsed = successful(result);
        // Passport returns an official dpurl.cn short link. Its auth_link is
        // user-facing; direct_auth_link must never be substituted or exposed.
        const url = officialUrl(parsed?.auth_link); if (url) { authorization = url; return account("authorizing", { verificationUrl: url }); }
        // get-code may instead return a previously cached token. Missing or
        // rejected links are not a reason to attempt login before authorization.
        if (parsed?.auth_link || typeof parsed?.token !== "string" || !/^[\x21-\x7e]{1,32768}$/u.test(parsed.token)) throw failure();
        await paotui(["login"], signal); return account("ready");
      }
      if (action === "bind") successful(await passport(["auth", "poll-token", "--client_id", clientArgs[1], "--timeout", "90", "--interval", "3", "--json"], { signal }));
      let hasToken = false;
      try { await meituanToken(signal); hasToken = true; } catch (error) { if (signal?.aborted) throw error; }
      if (!hasToken && action === "status") {
        // get-code only creates an authorization session. The UI's explicit
        // "I have authorized" status action must exchange that session before
        // checking the account; get-token alone cannot complete authorization.
        const polled = await passport(["auth", "poll-token", "--client_id", clientArgs[1], "--timeout", "90", "--interval", "3", "--json"], { signal });
        // The official poller removes its session on timeout as well as on
        // success. A failed exchange requires a fresh start, not stale polling.
        if (polled.code !== 0) { authorization = null; return account("signedOut", { errorCode: "OFFICIAL_SKILL_AUTH_FAILED" }); }
      }
      try { await paotui(["login"], signal); authorization = null; return account("ready"); }
      catch (error) { if (signal?.aborted) throw error; return account("unknown", { errorCode: "OFFICIAL_SKILL_AUTH_STATUS_FAILED" }); }
    }
    const commands = { status: ["check-wallet"], start: ["apply-wallet", "--agent-name", "Shoggoth"], bind: ["bind-wallet", "-c", args.code || ""], logout: ["close-wallet"] };
    if (action === "bind" && !args.code) fail("OFFICIAL_SKILL_INVALID_ARGUMENT");
    const result = await alipay(commands[action], { signal });
    if (result.code !== 0) throw failure();
    const text = result.stdout.trim();
    // Alipay 0.4.8 pretty-prints the final result after its diagnostic output.
    let parsed;
    try { parsed = JSON.parse(text.slice(text.lastIndexOf("\n{") + 1)); } catch {}
    if (action === "start" && typeof parsed?.alreadyExists === "boolean" && typeof parsed.alreadyPending === "boolean") {
      if (parsed.status === "bound" && !parsed.localPersistenceFailed) return account("ready");
      if (parsed.status === "unbound") {
        const verificationUrl = officialUrl(parsed.accessUrl);
        if (verificationUrl || parsed.alreadyPending) return account("authorizing", { verificationUrl });
      }
      return account("unknown", { errorCode: "OFFICIAL_SKILL_AUTH_STATUS_FAILED" });
    }
    if (action === "bind" && parsed?.status === "bound" && typeof parsed.boundAt === "string" && !parsed.localPersistenceFailed) return account("ready");
    const url = resultUrl(parsed, text);
    if (action === "logout") return account("authorizing", { verificationUrl: url, errorCode: url ? null : "OFFICIAL_SKILL_AUTH_STATUS_FAILED" });
    const pending = parsed?.code === 200 && (parsed.status === "unbound" || parsed.message === "已申请开通，等待授权");
    const ready = parsed?.code === 200 && !pending && (parsed.status === "bound" || parsed.access_url === "");
    if (ready || /(?:✓\s*支付功能已开启|\[开启成功\]|支付宝支付功能已开启成功)/u.test(text)) return account("ready");
    if (url) return account("authorizing", { verificationUrl: url });
    if (action === "status" && pending) return account("authorizing");
    if (parsed?.code === 500 || /(?:未开通|未授权|未绑定)/u.test(text)) return account("signedOut");
    return account("unknown", { errorCode: "OFFICIAL_SKILL_AUTH_STATUS_FAILED" });
  }

  function deliveryArgs(args) {
    const flags = { sender: "sender", recipient: "recipient", goods: "goods", businessType: "business-type", bizTypeSceneTag: "biz-type-scene-tag", businessTypeTag: "business-type-tag", serviceType: "service-type", tipFee: "tip-fee", purchaseDetail: "purchase-detail" };
    return Object.entries(args).flatMap(([key, value]) => flags[key] ? [`--${flags[key]}`, typeof value === "object" ? JSON.stringify(value) : String(value)] : []);
  }
  function cashierLink(value) { try { const url = new URL(value); return url.protocol === "https:" && !url.port && !url.username && !url.password && /^(?:cashier[^.]*|[^.]*excashier[^.]*|tbapi[^.]*)\.alipay\.com$/iu.test(url.hostname); } catch { return false; } }
  async function execute(name, args, { signal, officialSessionId } = {}) {
    if (!validators.get(name)?.(args)) fail("OFFICIAL_SKILL_INVALID_ARGUMENT");
    if (poisoned || closed) fail("OFFICIAL_SKILL_OPERATION_UNCERTAIN");
    validate(); signal?.throwIfAborted();
    if (name.startsWith("account_")) return accountAction(name.slice(8), args, signal);
    let result;
    if (baidu) result = await baidu.call(name, args, signal);
    else if (doordash) result = await doordash.call(name, args, { signal });
    else if (shop) result = await shop.call(name, args, { signal });
    else if (quark) result = await quark.execute(name, args, signal);
    else if (rollinggo) result = await rollinggo.call(name, args, signal);
    else if (providerId === "fliggy") result = successful(await run("runtime/dist/flyai-bundle.cjs", ["keyword-search", "--query", args.query], { signal }));
    else if (providerId === "weread") result = await weread({ search_books: "/store/search", bookshelf: "/shelf/sync", book_info: "/book/info", notebooks: "/user/notebooks", book_notes: "/book/bookmarklist", reading_stats: "/readdata/detail", recommend_books: "/book/recommend" }[name], args, signal);
    else if (providerId === "meituan-paotui") {
      if (name === "search_address") result = await paotui(["search_poi", "--keyword", args.keyword, ...(args.city ? ["--city", args.city] : [])], signal);
      if (name === "address_book") result = await paotui(["get_address_list"], signal);
      if (name === "address_phone") result = await paotui(["get_address_info", "--address-id", args.addressId], signal);
      if (name === "order_status") result = await paotui(["get_order_status", "--order-id", args.orderId], signal);
      if (name === "delivery_preview") {
        if (args.businessType === "2" && (!args.purchaseDetail || args.serviceType || args.bizTypeSceneTag) || args.businessType !== "2" && (args.businessTypeTag || args.purchaseDetail)) fail("OFFICIAL_SKILL_INVALID_ARGUMENT");
        if (args.businessType === "2" && args.businessTypeTag === undefined) fail("OFFICIAL_SKILL_INVALID_ARGUMENT");
        if (args.businessType !== "2") {
          const pairs = { "餐饮": 2, "文件": 4, "生鲜": 3, "蛋糕": 9, "鲜花": 1, "数码": 5, "服饰": 7, "快递": 8, "五金": 2, "汽配": 2, "其他": 8 };
          if (!args.goods.goodsWeight || !args.goods.goodTypes || !args.goods.goodTypeNames || pairs[args.goods.goodTypeNames[0]] !== args.goods.goodTypes[0]) fail("OFFICIAL_SKILL_INVALID_ARGUMENT");
        }
        result = await paotui(["delivery_preview", ...deliveryArgs(args)], signal);
        const data = result.data || result, token = data.orderToken, fee = data._deliveryFee, total = data._previewTotal;
        if (typeof token !== "string" || !token || !Number.isFinite(Number(fee)) || Number(fee) < 0 || !Number.isFinite(Number(total)) || Number(total) < 0) throw failure();
        const previewId = crypto.randomUUID(); previews.set(previewId, { args: structuredClone(args), token, fee, total, coupon: data._couponViewId, expires: now() + 5 * 60_000 });
        result = { ...result, previewId, confirmationRequired: true, highValueConfirmationRequired: Number(total) > 100 };
      }
      if (name === "submit_order") {
        const preview = previews.get(args.previewId); if (!preview || preview.expires < now() || Number(preview.total) > 100 && args.highValueConfirmed !== true) fail("OFFICIAL_SKILL_INVALID_ARGUMENT");
        previews.delete(args.previewId);
        result = await paotui(["submit_order", ...deliveryArgs(preview.args), "--order-token", preview.token, "--delivery-fee", String(preview.fee), ...(preview.coupon ? ["--coupon-view-id", String(preview.coupon)] : []), ...(args.remark ? ["--remark", args.remark] : [])], signal, { ...preview.args, remark: args.remark || "" });
      }
    } else if (providerId === "alipay") {
      if (name === "submit_payment") {
        if (!cashierLink(args.cashierLink)) fail("OFFICIAL_SKILL_INVALID_ARGUMENT");
        if (typeof officialSessionId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(officialSessionId)) fail("OFFICIAL_SKILL_SESSION_REQUIRED");
        const sessionId = officialSessionId, summary = `服务内容：${args.purpose}，支付金额：¥${args.amountYuan.toFixed(2)}，支付对象：${args.payee}`;
        const raw = await guardedWrite("payment", args.cashierLink, async () => {
          const response = await alipay(["submit-payment", "--session-id", sessionId, "--payment-link", args.cashierLink, "--intent-summary", summary], { signal, sideEffect: true }); successful(response); return response;
        }, { sessionId, keepCompleted: true }); result = successful(raw);
        const parsed = parseJson(raw.stdout), data = parsed?.data || parsed;
        const order = data?.outShakeNo, url = officialUrl(data?.shortUrl), receiptId = crypto.randomUUID();
        if (typeof order === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(order)) payments.set(receiptId, ["--out-shake-no", order]);
        else if (url) payments.set(receiptId, ["-p", url]);
        result = { ...result, receiptId: payments.has(receiptId) ? receiptId : null };
      } else { const query = payments.get(args.receiptId); if (!query) fail("OFFICIAL_SKILL_OPERATION_UNCERTAIN"); result = successful(await alipay(["query-payment-status", ...query], { signal })); }
    }
    if (result === undefined) fail("OFFICIAL_SKILL_INVALID_ARGUMENT");
    return publicOutput(result, secrets);
  }
  return { tools, call(name, args, options) { const work = chain.then(() => execute(name, args, options)); chain = work.catch(() => {}); return work; },
    async close() {
      closed = true;
      baidu?.close();
      await stopActiveChildren();
      authorization = null;
      children.clear(); previews.clear(); payments.clear();
    },
  };
}

module.exports = { createOfficialSkillRuntime, commandEnvironment, parseJson, publicOutput, assertManagedHome, TOOL_DEFS, ACCOUNT_DEFS };
