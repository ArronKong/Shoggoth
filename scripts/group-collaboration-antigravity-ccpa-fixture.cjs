"use strict";

// Task-owned fake OAuth/cache + fixed loopback CCPA fixtures. This module never
// imports/starts the SDK, reads an existing credential, or forwards remotely.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const http = require("node:http"), https = require("node:https"), net = require("node:net");
const { execFileSync } = require("node:child_process");
const guard = require("./group-collaboration-antigravity-guard.cjs");
const FIXED_TLS_HOSTS = ["cloudcode-pa.googleapis.com", "daily-cloudcode-pa.googleapis.com"];
const MAX_BODY = 16 * 1024 * 1024;
const MAX_JSON_DEPTH = 128, MAX_JSON_NODES = 1000000;
// The complete native request can contain many tool schemas. The small hook
// policy parser's 4096-node/16-level bounds are inappropriate for this capture
// hop. Keep independent, explicit limits and reject duplicate keys before
// parsing; objects use null prototypes so schema property names are data.
function parseCapturedJson(raw) {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > MAX_BODY) throw guard.failure("AGY_CCPA_BODY_SIZE_INVALID");
  let at = 0, nodes = 0;
  const space = () => { while (/[ \t\r\n]/u.test(raw[at] || "x")) at += 1; };
  const string = () => {
    const start = at++;
    while (at < raw.length) {
      if (raw[at] === "\\") { at += 2; continue; }
      if (raw[at++] === '"') {
        const item = JSON.parse(raw.slice(start, at));
        if (!item.isWellFormed() || item.includes("\0")) throw guard.failure("AGY_CCPA_INVALID_STRING");
        return item;
      }
    }
    throw guard.failure("AGY_CCPA_INVALID_JSON");
  };
  const value = depth => {
    if (depth > MAX_JSON_DEPTH || ++nodes > MAX_JSON_NODES) throw guard.failure("AGY_CCPA_JSON_COMPLEXITY");
    space(); const token = raw[at];
    if (token === '"') return string();
    if (token === "{" || token === "[") {
      at += 1; space(); const object = token === "{", result = object ? Object.create(null) : [], seen = new Set(), end = object ? "}" : "]";
      if (raw[at] === end) { at += 1; return result; }
      for (;;) {
        let key;
        if (object) {
          if (raw[at] !== '"') throw guard.failure("AGY_CCPA_INVALID_JSON");
          key = string(); if (seen.has(key)) throw guard.failure("AGY_CCPA_DUPLICATE_JSON_KEY");
          seen.add(key); space(); if (raw[at++] !== ":") throw guard.failure("AGY_CCPA_INVALID_JSON");
        }
        const item = value(depth + 1);
        if (object) result[key] = item; else result.push(item);
        space(); if (raw[at] === end) { at += 1; return result; }
        if (raw[at++] !== ",") throw guard.failure("AGY_CCPA_INVALID_JSON"); space();
      }
    }
    const matched = raw.slice(at).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u);
    if (!matched) throw guard.failure("AGY_CCPA_INVALID_JSON");
    at += matched[0].length; const item = JSON.parse(matched[0]);
    if (typeof item === "number" && !Number.isFinite(item)) throw guard.failure("AGY_CCPA_NONFINITE_NUMBER");
    return item;
  };
  try { const result = value(0); space(); if (at !== raw.length) throw guard.failure("AGY_CCPA_INVALID_JSON"); return result; }
  catch (error) { if (error?.code?.startsWith("AGY_CCPA_")) throw error; throw guard.failure("AGY_CCPA_INVALID_JSON"); }
}
function ownedRoot(raw) {
  // Reject unowned/traversing strings before any filesystem query, including
  // realpath. A negative user-Home case must not read that Home's metadata.
  if (typeof raw !== "string" || !path.isAbsolute(raw) || path.normalize(raw) !== raw || !raw.startsWith("/private/tmp/sggroup-")) throw guard.failure("AGY_CCPA_ROOT_UNSAFE");
  if (fs.realpathSync(raw) !== raw) throw guard.failure("AGY_CCPA_ROOT_UNSAFE");
  guard.noLinks(raw, raw); return raw;
}
function directory(file, root) {
  if (!path.isAbsolute(file) || path.normalize(file) !== file || !guard.within(file, root)) throw guard.failure("AGY_CCPA_PATH_UNSAFE");
  let current = root;
  for (const part of path.relative(root, file).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { const stat = fs.lstatSync(current); if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o022)) throw guard.failure("AGY_CCPA_PATH_UNSAFE"); }
    catch (error) { if (error.code !== "ENOENT") throw error; fs.mkdirSync(current, { mode: 0o700 }); }
  }
  guard.noLinks(file, root); return file;
}
function writeNew(file, bytes, root, mode = 0o600) {
  guard.noLinks(path.dirname(file), root);
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), mode);
  try { fs.writeFileSync(fd, bytes); } finally { fs.closeSync(fd); }
  return { path: file, ...guard.readStable(file, { root, mode, maxBytes: MAX_BODY }) };
}
function createOwnedSyntheticOAuthInputs(options) {
  const root = ownedRoot(options.root), sdkHome = directory(options.sdkHome || path.join(root, "fresh-sdk-home"), root);
  const geminiHome = directory(options.geminiHome || path.join(sdkHome, ".gemini"), root);
  const ttl = options.ttlSeconds ?? 3600;
  if (!Number.isSafeInteger(ttl) || ttl < 600 || ttl > 3600) throw guard.failure("AGY_CCPA_FAKE_EXPIRY_UNSAFE");
  const syntheticToken = "owned-agy-ccpa-fixture-" + crypto.randomBytes(32).toString("hex");
  const projectId = options.projectId || "owned-agy-ccpa-fixture-project";
  if (!/^owned-[a-z0-9-]{1,96}$/u.test(projectId)) throw guard.failure("AGY_CCPA_FAKE_PROJECT_UNSAFE");
  const tokenPath = path.join(directory(guard.officialAppDataDir(geminiHome), root), "acp_token.json");
  // google.oauth2.Credentials.from_authorized_user_info requires the refresh,
  // client-id and client-secret fields. The future token/expiry make this an
  // owned synthetic cached-token case; a refresh is forbidden by the network
  // boundary, not made into a successful Google authentication claim.
  const document = { client_id: "owned-fake-client-id", client_secret: "owned-fake-client-secret",
    refresh_token: "owned-fake-refresh-token", token: syntheticToken,
    token_uri: "https://oauth2.googleapis.com/token", expiry: new Date(Date.now() + ttl * 1000).toISOString(),
    scopes: ["https://www.googleapis.com/auth/cloud-platform", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/aicode"], project_id: projectId };
  const fact = writeNew(tokenPath, Buffer.from(JSON.stringify(document, null, 2) + "\n"), root);
  return { root, sdkHome, geminiHome, projectId, syntheticToken, tokenPath, tokenSha256: fact.sha256, tokenIdentity: fact.identity,
    requiredNativeEnvironment: { HOME: sdkHome, GEMINI_HOME: geminiHome, AGY_ACP_FORCE_FILE_STORAGE: "1" },
    sourceAuthority: "pinned-1.2.1 OAuth credential file schema and official FORCE_FILE_STORAGE; actual native load remains unproven",
    originalCredentialRead: false, originalKeychainRead: false, SDKsStarted: 0, realOAuthAcceptance: false };
}
function createOwnedTlsFiles({ root: raw }) {
  const root = ownedRoot(raw), dir = directory(path.join(root, "ccpa-loopback-control/tls"), root);
  const env = { PATH: "/usr/bin:/bin", HOME: dir, TMPDIR: dir };
  const caKey = path.join(dir, "owned-ca-key.pem"), ca = path.join(dir, "owned-ca.pem"), key = path.join(dir, "owned-leaf-key.pem"), csr = path.join(dir, "owned-leaf.csr"), cert = path.join(dir, "owned-leaf.pem");
  if ([caKey, ca, key, csr, cert].some(guard.pathExists)) throw guard.failure("AGY_CCPA_TLS_FILES_ALREADY_EXIST");
  const extensions = writeNew(path.join(dir, "leaf-extensions.cnf"), Buffer.from("basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:cloudcode-pa.googleapis.com,DNS:daily-cloudcode-pa.googleapis.com\n"), root, 0o400);
  const run = args => execFileSync("/usr/bin/openssl", args, { cwd: dir, env, stdio: ["ignore", "ignore", "pipe"], timeout: 10000 });
  run(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", caKey, "-out", ca, "-days", "1", "-sha256", "-subj", "/CN=Owned AGY loopback fixture CA"]);
  run(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", csr, "-sha256", "-subj", "/CN=cloudcode-pa.googleapis.com"]);
  run(["x509", "-req", "-in", csr, "-CA", ca, "-CAkey", caKey, "-CAcreateserial", "-out", cert, "-days", "1", "-sha256", "-extfile", extensions.path]);
  const files = [caKey, ca, key, csr, cert].map(file => { fs.chmodSync(file, file.endsWith("-key.pem") ? 0o600 : 0o400); const fact = guard.readStable(file, { root }); return { path: file, sha256: fact.sha256, identity: fact.identity }; });
  return { root, caPath: ca, caSha256: files.find(item => item.path === ca).sha256, keyPath: key, certificatePath: cert, files,
    systemTrustChanged: false, sdkStarted: false, fixedTlsHostnames: [...FIXED_TLS_HOSTS] };
}
function fixtureResponse(plan) {
  if (!guard.plain(plan) || !Object.keys(plan).every(key => ["text", "functionCall"].includes(key))
    || (Object.hasOwn(plan, "text") === Object.hasOwn(plan, "functionCall"))) throw guard.failure("AGY_CCPA_RESPONSE_PLAN_INVALID");
  let part;
  if (Object.hasOwn(plan, "text")) {
    if (!guard.text(plan.text, 65536)) throw guard.failure("AGY_CCPA_RESPONSE_PLAN_INVALID"); part = { text: plan.text };
  } else {
    if (!guard.exact(plan.functionCall, ["name", "args"]) || !/^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/u.test(plan.functionCall.name)
      || !guard.plain(plan.functionCall.args)) throw guard.failure("AGY_CCPA_RESPONSE_PLAN_INVALID");
    part = { functionCall: structuredClone(plan.functionCall) };
  }
  return { response: { candidates: [{ index: 0, content: { role: "model", parts: [part] }, finishReason: "STOP" }] } };
}
async function readRequest(req) {
  const length = req.headers["content-length"];
  if (!/^(?:0|[1-9][0-9]*)$/u.test(length || "") || Number(length) > MAX_BODY || req.headers["transfer-encoding"]) throw guard.failure("AGY_CCPA_BODY_SIZE_INVALID");
  let total = 0; const parts = [];
  for await (const part of req) { total += part.length; if (total > MAX_BODY) throw guard.failure("AGY_CCPA_BODY_SIZE_INVALID"); parts.push(part); }
  if (total !== Number(length)) throw guard.failure("AGY_CCPA_BODY_LENGTH_MISMATCH");
  const bytes = Buffer.concat(parts);
  let text; try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw guard.failure("AGY_CCPA_INVALID_UTF8"); }
  // The original pinned CCPA client serializes a parsed JSON object with
  // json.dumps, so duplicate keys are not created by this hop. The owned
  // fixture also rejects duplicates; max parser complexity remains explicit.
  const parsed = parseCapturedJson(text);
  return { bytes, parsed };
}
async function createOwnedCcpaLoopback(options) {
  const root = ownedRoot(options.root), inputs = options.inputs;
  if (!inputs || inputs.root !== root || !/^owned-agy-ccpa-fixture-[a-f0-9]{64}$/u.test(inputs.syntheticToken || "")
    || inputs.originalCredentialRead || inputs.realOAuthAcceptance) throw guard.failure("AGY_CCPA_ONLY_OWNED_FAKE_AUTH_ALLOWED");
  guard.readStable(inputs.tokenPath, { root, mode: 0o600, expectedSha256: inputs.tokenSha256, identity: inputs.tokenIdentity });
  const control = directory(path.join(root, "ccpa-loopback-control"), root), captures = directory(path.join(control, "captures"), root);
  const expectedAuthorization = "Bearer " + inputs.syntheticToken, projectId = inputs.projectId, modelId = options.modelId || "gemini-2.5-flash";
  if (!/^owned-[a-z0-9-]{1,96}$/u.test(projectId || "")) throw guard.failure("AGY_CCPA_FAKE_PROJECT_UNSAFE");
  if (!/^[a-z][a-z0-9_.-]{0,127}$/u.test(modelId)) throw guard.failure("AGY_CCPA_MODEL_ID_INVALID");
  const plans = (options.responses || [{ text: "OWNED_CCPA_FIXTURE_CAPTURE_ONLY" }]).map(fixtureResponse), records = [], sockets = new Set();
  const maxGenerations = options.maxGenerations ?? 8, maxRequests = options.maxRequests ?? 32;
  if (!Number.isSafeInteger(maxGenerations) || maxGenerations < 1 || maxGenerations > 32 || !plans.length || plans.length > maxGenerations
    || !Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > 128) throw guard.failure("AGY_CCPA_BUDGET_INVALID");
  let generationCount = 0, accepted = 0, denied = 0, connects = 0, refusedConnects = 0, httpPort, tlsPort, proxyPort;
  const send = (res, status, value, type = "application/json") => { const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value)); res.writeHead(status, { "Content-Type": type, "Content-Length": bytes.length, Connection: "close" }); res.end(bytes); };
  const handler = secure => async (req, res) => {
    const fields = name => req.rawHeaders.filter((_, index, list) => index % 2 === 0 && list[index].toLowerCase() === name).length;
    const permittedHost = secure ? FIXED_TLS_HOSTS.includes((req.headers.host || "").replace(/:443$/u, ""))
      && FIXED_TLS_HOSTS.includes(req.socket.servername) : req.headers.host === "127.0.0.1:" + httpPort;
    if (req.method !== "POST" || !permittedHost || req.socket.remoteAddress !== "127.0.0.1" || fields("authorization") !== 1 || fields("host") !== 1
      || req.headers.authorization !== expectedAuthorization || (req.headers["content-type"] || "").split(";")[0] !== "application/json") {
      denied += 1; req.resume(); send(res, 401, { error: { code: 401, message: "Owned fixture rejected request before body capture" } }); return;
    }
    let url; try { if (!req.url.startsWith("/") || req.url.startsWith("//")) throw new Error("relative path required"); url = new URL(req.url, "http://owned.invalid"); }
    catch { denied += 1; req.resume(); send(res, 400, { error: { code: 400, message: "Invalid request path" } }); return; }
    const method = { "/v1internal:loadCodeAssist": "loadCodeAssist", "/v1internal:fetchAvailableModels": "fetchAvailableModels", "/v1internal:generateContent": "generateContent", "/v1internal:streamGenerateContent": "streamGenerateContent" }[url.pathname];
    const stream = method === "streamGenerateContent";
    if (!method || [...url.searchParams].some(([key, value]) => key !== "alt" || value !== (stream ? "sse" : "json"))
      || stream && url.searchParams.get("alt") !== "sse" || url.searchParams.getAll("alt").length > 1) { denied += 1; req.resume(); send(res, 404, { error: { code: 404, message: "Unregistered fixture method" } }); return; }
    if (accepted >= maxRequests) { denied += 1; req.resume(); send(res, 429, { error: { code: 429, message: "Owned total capture budget reached" } }); return; }
    try {
      const { bytes, parsed } = await readRequest(req);
      if (!guard.plain(parsed)) throw guard.failure("AGY_CCPA_REQUEST_OBJECT_REQUIRED");
      if (["generateContent", "streamGenerateContent"].includes(method)) {
        if (!guard.exact(parsed, ["project", "model", "request"]) || parsed.project !== projectId || parsed.model !== modelId || !guard.plain(parsed.request)) throw guard.failure("AGY_CCPA_FINAL_REQUEST_UNBOUND");
        if (generationCount >= maxGenerations) { denied += 1; send(res, 429, { error: { code: 429, message: "Owned generation budget reached" } }); return; }
      } else if (method === "loadCodeAssist") {
        if (!guard.exact(parsed, ["metadata"]) || !guard.exact(parsed.metadata, ["ideType"]) || parsed.metadata.ideType !== "ANTIGRAVITY") throw guard.failure("AGY_CCPA_ONBOARD_REQUEST_UNBOUND");
      } else if (!guard.exact(parsed, ["project"]) || parsed.project !== projectId) throw guard.failure("AGY_CCPA_MODEL_REQUEST_UNBOUND");
      const ordinal = ++accepted, file = path.join(captures, String(ordinal).padStart(3, "0") + "-" + method + ".json"), fact = writeNew(file, bytes, root);
      const record = { ordinal, method, transport: secure ? "fixed-host-owned-TLS-CONNECT" : "owned-loopback-HTTP", path: file, sha256: fact.sha256,
        identity: fact.identity, bytes: bytes.length, topLevelFields: Object.keys(parsed).sort(), headersStored: false, originalCredentialRead: false,
        actualSdkIngressProven: false, actualNativeToolBodyProven: false, modelAdmission: "UNPROVEN" };
      records.push(record);
      if (method === "loadCodeAssist") { send(res, 200, { currentTier: { id: "free-tier", name: "Owned fixture tier" }, cloudaicompanionProject: projectId }); return; }
      if (method === "fetchAvailableModels") { send(res, 200, { models: { [modelId]: { displayName: "Owned fixture model", supportsImages: false, supportsThinking: false } } }); return; }
      const response = plans[Math.min(generationCount++, plans.length - 1)];
      if (stream) send(res, 200, Buffer.from("data: " + JSON.stringify(response) + "\n\n"), "text/event-stream"); else send(res, 200, response);
    } catch (error) { denied += 1; send(res, 400, { error: { code: 400, message: /^AGY_(?:CCPA|GUARD)_[A-Z_]+$/u.test(error?.code || "") ? error.code : "Owned fixture request invalid" } }); }
  };
  const track = server => server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  const listen = server => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(server.address().port); }); });
  let tlsMaterial;
  if (options.tlsFiles) {
      const files = options.tlsFiles;
      if (files.root !== root || files.systemTrustChanged) throw guard.failure("AGY_CCPA_TLS_INPUTS_UNSAFE");
      const pinned = (file, mode) => {
        const record = files.files?.find(item => item.path === file);
        if (!record || !/^[a-f0-9]{64}$/u.test(record.sha256 || "") || !record.identity) throw guard.failure("AGY_CCPA_TLS_INPUTS_UNSAFE");
        return guard.readStable(file, { root, mode, expectedSha256: record.sha256, identity: record.identity }).bytes;
      };
      const key = pinned(files.keyPath, 0o600), cert = pinned(files.certificatePath, 0o400);
      const ca = pinned(files.caPath, 0o400);
      if (guard.sha(ca) !== files.caSha256) throw guard.failure("AGY_CCPA_TLS_INPUTS_UNSAFE");
      tlsMaterial = { key, cert };
  }
  const httpServer = track(http.createServer(handler(false)));
  let tlsServer, proxyServer, stopping;
  const closeOwned = () => {
    if (!stopping) stopping = (async () => {
      // server.close does not wait for an outbound CONNECT peer's close event.
      // Observe every owned socket before destroying it, then await both kinds
      // of closure so a returned zero is an actual resource result.
      const socketClosures = [...sockets].map(socket => new Promise(resolve => { socket.once("close", resolve); socket.destroy(); }));
      const listeners = [httpServer, tlsServer, proxyServer].filter(Boolean);
      await Promise.all([...socketClosures, ...listeners.map(server => new Promise(resolve => server.close(resolve)))]);
      return { allOwnedListenersClosed: listeners.every(server => !server.listening), ownedOpenSockets: sockets.size, sdkStarted: false };
    })();
    return stopping;
  };
  try {
    httpPort = await listen(httpServer);
    if (tlsMaterial) {
      tlsServer = track(https.createServer(tlsMaterial, handler(true))); tlsPort = await listen(tlsServer);
      proxyServer = track(http.createServer((req, res) => { req.resume(); send(res, 405, { error: { code: 405, message: "Fixed TLS CONNECT only" } }); }));
      proxyServer.on("connect", (req, client, head) => {
        if (client.remoteAddress !== "127.0.0.1" || !FIXED_TLS_HOSTS.some(host => req.url === host + ":443") || req.headers["proxy-authorization"] || head.length) { refusedConnects += 1; client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); return; }
        connects += 1;
        // This is the sole outbound connect in the module. Its address and
        // port are our already-owned TLS listener; remote forwarding is absent.
        const upstream = net.connect({ host: "127.0.0.1", port: tlsPort }); sockets.add(upstream); upstream.once("close", () => sockets.delete(upstream));
        upstream.once("connect", () => { client.write("HTTP/1.1 200 Connection Established\r\n\r\n"); upstream.pipe(client); client.pipe(upstream); });
        const close = () => { client.destroy(); upstream.destroy(); }; upstream.once("error", close); client.once("error", close); client.once("close", close); upstream.once("close", () => client.destroy());
      });
      proxyPort = await listen(proxyServer);
    }
  } catch (error) { await closeOwned(); throw error; }
  return { root, endpoint: "http://127.0.0.1:" + httpPort, proxyEndpoint: proxyPort ? "http://127.0.0.1:" + proxyPort : null,
    requiredNativeEnvironment: { ...inputs.requiredNativeEnvironment, AGY_ACP_CCPA_BASE_URL: "http://127.0.0.1:" + httpPort,
      ...(proxyPort ? { https_proxy: "http://127.0.0.1:" + proxyPort, HTTPS_PROXY: "http://127.0.0.1:" + proxyPort,
        NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost", HTTPLIB2_CA_CERTS: options.tlsFiles.caPath, SSL_CERT_FILE: options.tlsFiles.caPath } : {}) },
    snapshot: () => ({ records: structuredClone(records), acceptedRequests: accepted, deniedRequests: denied, generationCount, maxRequests, maxGenerations,
      fixedTlsConnects: connects, refusedTlsConnects: refusedConnects, ownedOpenSockets: sockets.size, remoteForwarding: false,
      systemTrustChanged: false, SDKsStarted: 0, originalAuthReadersStarted: 0, actualSdkIngressProven: false, modelAdmission: "UNPROVEN" }),
    extractBuiltinSchemas(record) {
      const bound = records.find(item => item.path === record.path && item.sha256 === record.sha256 && ["generateContent", "streamGenerateContent"].includes(item.method));
      if (!bound) throw guard.failure("AGY_CCPA_CAPTURE_RECORD_UNBOUND");
      const fact = guard.readStable(bound.path, { root, mode: 0o600, expectedSha256: bound.sha256, identity: bound.identity, maxBytes: MAX_BODY });
      const body = parseCapturedJson(new TextDecoder("utf-8", { fatal: true }).decode(fact.bytes)), found = {};
      if (!Array.isArray(body.request?.tools)) throw guard.failure("AGY_CCPA_CAPTURE_SCHEMA_UNSUPPORTED");
      for (const container of body.request.tools) {
        const fields = ["functionDeclarations", "function_declarations"].filter(key => Object.hasOwn(container || {}, key));
        if (!guard.plain(container) || fields.length !== 1 || !Array.isArray(container[fields[0]])) throw guard.failure("AGY_CCPA_CAPTURE_SCHEMA_UNSUPPORTED");
        for (const declaration of container[fields[0]]) {
          if (!guard.plain(declaration) || !guard.text(declaration.name, 128)) throw guard.failure("AGY_CCPA_CAPTURE_SCHEMA_UNSUPPORTED");
          if (!["create_file", "edit_file", "run_command"].includes(declaration.name)) continue;
          if (Object.hasOwn(found, declaration.name)) throw guard.failure("AGY_CCPA_CAPTURE_SCHEMA_DUPLICATE");
          const parameters = ["parameters", "parametersJsonSchema", "parameters_json_schema"].filter(key => Object.hasOwn(declaration, key));
          if (parameters.length !== 1 || !guard.plain(declaration[parameters[0]])) throw guard.failure("AGY_CCPA_CAPTURE_SCHEMA_UNSUPPORTED");
          found[declaration.name] = { authority: "captured-request-bytes;actual-SDK-ingress-origin-and-body-proof-must-be-verified-separately",
            capturedRequestPath: bound.path, capturedRequestSha256: bound.sha256, parameters: declaration[parameters[0]],
            actualSdkIngressProven: false, actualNativeToolBodyProven: false };
        }
      }
      if (!Object.keys(found).length) throw guard.failure("AGY_CCPA_CAPTURE_SCHEMA_MISSING");
      return found;
    },
    stop: closeOwned };
}
module.exports = { FIXED_TLS_HOSTS, MAX_BODY, MAX_JSON_DEPTH, MAX_JSON_NODES, parseCapturedJson,
  createOwnedSyntheticOAuthInputs, createOwnedTlsFiles, fixtureResponse, createOwnedCcpaLoopback };
