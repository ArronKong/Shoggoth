"use strict";

// Fake `agy_acp_server` for unit tests. Message shapes mirror frames captured from
// the official 1.2.1 server on 2026-09-26 (permissions, in-band failures that
// only surface on stderr, cancellation notice, browser login flow).
const fs = require("node:fs");
const readline = require("node:readline");

const logFile = process.env.FAKE_ACP_LOG;
const record = (entry) => { if (logFile) fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`); };
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const update = (sessionId, value) => send({ method: "session/update", params: { sessionId, update: value } });
const models = ["gemini-3.8-flash-high", "gemini-3.8-flash-low", "gemini-pro-agent"];
const sessions = new Map();
let nextRequestId = 0;
const pendingReverse = new Map();
let pendingPrompt = null;
let resumeAttempts = 0;

function configOptions(state) {
  return [
    { id: "model", name: "Model", category: "model", type: "select", currentValue: state.model,
      options: models.map((value) => ({ value, name: value.toUpperCase(), description: value })) },
    { id: "mode", name: "Session Mode", category: "mode", type: "select", currentValue: state.mode,
      options: ["default", "auto_edit", "yolo"].map((value) => ({ value, name: value, description: value })) },
  ];
}

function sessionResult(state) {
  return {
    modes: { currentModeId: state.mode, availableModes: [] },
    configOptions: configOptions(state),
    models: { availableModels: models.map((modelId) => ({ modelId, name: modelId })), currentModelId: state.model },
  };
}

function reverse(method, params) {
  const id = nextRequestId++;
  send({ id, method, params });
  return new Promise((resolve) => pendingReverse.set(id, resolve));
}

function permissionOptions() {
  return [
    { optionId: "allow_always", name: "Allow Always (risky)", kind: "allow_always",
      _meta: { "agy.security.warning": { severity: "high", risk: "prompt_injection", title: "Allowing always can be risky" } } },
    { optionId: "allow", name: "Allow", kind: "allow_once" },
    { optionId: "deny", name: "Deny", kind: "reject_once" },
  ];
}

async function prompt(message) {
  const { sessionId } = message.params;
  const text = message.params.prompt.find((block) => block.type === "text")?.text || "";
  const images = message.params.prompt.filter((block) => block.type === "image").length;
  record({ method: "session/prompt", sessionId, text, images, mode: sessions.get(sessionId)?.mode, model: sessions.get(sessionId)?.model });
  const directive = /DIRECTIVE:([A-Z_]+)/u.exec(text)?.[1] || "PLAIN";
  if (directive === "REMOTE_ERROR") {
    send({ id: message.id, error: { code: -32603, message: "Internal error", data: {
      details: "HTTPSConnectionPool(host='oauth2.googleapis.com', port=443): Max retries exceeded (Caused by ProxyError('Unable to connect to proxy'))",
    } } });
    return;
  }
  if (directive === "LOGIN") {
    process.stderr.write("I0926 credential_manager.py:561] Credentials missing or invalid. Launching browser login flow...\n");
    return; // never answers; the host must fail fast
  }
  const inbandFailures = {
    INBAND_ERROR: `There was a network issue connecting to the server. (failed to construct executor: MCP load failed for shoggoth: calling "initialize": invalid character '\\x00' in string)`,
    INBAND_NETWORK_ERROR: "There was a network issue connecting to the server",
    INBAND_RATE_LIMIT: "RESOURCE_EXHAUSTED (code 429): Resource has been exhausted",
    INBAND_QUOTA_ERROR: "quota exhausted",
    INBAND_UNKNOWN_ERROR: "Unexpected execution failure",
  };
  if (Object.hasOwn(inbandFailures, directive)) {
    // The official server logs this ordinary subscription description before
    // failures too. It is not a provider rejection or an exhausted allowance.
    process.stderr.write("I0926 onboard.py:142] loadCodeAssist response: {'upgradeSubscriptionText': 'You can upgrade to a Google AI Ultra plan to receive higher rate limits.'}\n");
    process.stderr.write(`W0926 local_connection.py:551] System step error (HTTP 2): ${inbandFailures[directive]}\n`);
    process.stderr.write(`E0926 server.py:4823] Antigravity SDK error processing prompt for session ${sessionId}\n`);
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "The MCP server 'shoggoth' failed to initialize." } });
    send({ id: message.id, result: { stopReason: "end_turn" } });
    return;
  }
  if (directive === "SLOW") {
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "partial " } });
    pendingPrompt = { id: message.id, sessionId };
    return;
  }
  // The real server sends nothing while the model thinks.
  if (directive === "SILENT") {
    pendingPrompt = { id: message.id, sessionId };
    return;
  }
  if (directive === "SILENT_LATE") {
    setTimeout(() => {
      update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "LATE ANSWER" } });
      send({ id: message.id, result: { stopReason: "end_turn" } });
    }, 400);
    return;
  }
  if (directive === "UNKNOWN_UPDATE") update(sessionId, { sessionUpdate: "future_update_kind", payload: { value: 1 } });
  // Captured from the official 1.2.1 server on 2026-09-30: both successful
  // native reads and MCP failures finish with this same lossy ACP frame.
  // ACP 1.2.1 _stream_live_step broadcasts an ERROR step to every open ID.
  // The denied grep never gets a start; an earlier successful read gets its error.
  if (directive === "ERROR_BROADCAST") {
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: "call_read",
      title: "Running view_file", kind: "read", status: "in_progress",
      rawInput: { absolute_path: "/w/snapshot.txt" } });
    await new Promise(resolve => setTimeout(resolve, 120));
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "call_read",
      status: "failed", rawOutput: "Access to /outside is denied by grep_search pre-tool hook" });
    await new Promise(resolve => setTimeout(resolve, 400));
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Recovered after denial." } });
    send({ id: message.id, result: { stopReason: "end_turn" } });
    return;
  }
  if (["BROKEN_TOOL_RESULTS", "BROKEN_TOOL_RESULTS_CANCEL"].includes(directive)) {
    for (const call of [
      { toolCallId: "call_read", title: "Running view_file", kind: "read", status: "in_progress",
        rawInput: { absolute_path: "/w/snapshot.txt" } },
      { toolCallId: "public-snapshot", title: "shoggoth_computer_snapshot", kind: "other", status: "pending",
        rawInput: { arguments: { sessionId: "computer-one" } }, _meta: { mcp: { server: "shoggoth", tool: "computer_snapshot" } } },
      { toolCallId: "public-click", title: "shoggoth_computer_click", kind: "other", status: "pending",
        rawInput: { arguments: { sessionId: "computer-one", ref: "c3", snapshotRevision: "revision-one" } },
        _meta: { mcp: { server: "shoggoth", tool: "computer_click" } } },
    ]) update(sessionId, { sessionUpdate: "tool_call", ...call });
    for (const toolCallId of ["call_read", "public-snapshot", "public-click"]) {
      update(sessionId, { sessionUpdate: "tool_call_update", toolCallId,
        status: toolCallId === "public-snapshot" ? "completed" : "failed",
        rawOutput: toolCallId === "public-snapshot" ? "Call shoggoth computer_snapshot" : "Tool execution failed" });
    }
    if (directive === "BROKEN_TOOL_RESULTS_CANCEL") { pendingPrompt = { id: message.id, sessionId }; return; }
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "The click paused after user takeover." } });
    send({ id: message.id, result: { stopReason: "end_turn" } });
    return;
  }
  if (["PERMISSION", "MCP_PERMISSION", "EDIT_PERMISSION"].includes(directive)) {
    const toolCall = directive === "MCP_PERMISSION"
      ? { toolCallId: "tool-mcp", kind: "other", status: "pending", title: "shoggoth_board_list", content: [],
        rawInput: { arguments: {} }, _meta: { mcp: { tool: "board_list", server: "shoggoth" }, is_mcp_tool_call: true } }
      : directive === "EDIT_PERMISSION"
        ? { toolCallId: "tool-edit", kind: "edit", status: "pending", title: "Run write_to_file?", content: [], rawInput: { TargetFile: "/w/a.txt" } }
        : { toolCallId: "tool-url", kind: "fetch", status: "pending", title: "Run read_url_content?",
          content: [{ type: "content", content: { type: "text", text: "https://example.com" } }], rawInput: { Url: "https://example.com" } };
    update(sessionId, { sessionUpdate: "tool_call", ...toolCall });
    const outcome = await reverse("session/request_permission", { sessionId, toolCall, options: permissionOptions() });
    record({ method: "permission-outcome", directive, outcome });
    const allowed = outcome?.outcome?.outcome === "selected" && outcome.outcome.optionId !== "deny";
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: toolCall.toolCallId, status: allowed ? "completed" : "failed", rawOutput: allowed ? "ok" : "denied" });
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: allowed ? "ALLOWED" : "DENIED" } });
    send({ id: message.id, result: { stopReason: "end_turn" } });
    return;
  }
  update(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } });
  update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `ANSWER(${images} images)` } });
  send({ id: message.id, result: { stopReason: "end_turn" } });
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id !== undefined && message.method === undefined) {
    pendingReverse.get(message.id)?.(message.result);
    pendingReverse.delete(message.id);
    return;
  }
  record({ method: message.method, params: message.method === "session/prompt" ? undefined : message.params });
  if (message.method === "initialize") {
    send({ id: message.id, result: {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, promptCapabilities: { image: true, audio: true, embeddedContext: true },
        mcpCapabilities: { http: true, sse: true }, sessionCapabilities: { list: {}, resume: {} }, auth: { logout: {} } },
      authMethods: [{ id: "oauth-personal", name: "Log in with Google" }],
      agentInfo: { name: "antigravity-acp", title: "Google Antigravity", version: "1.2.1" },
    } });
  } else if (message.method === "authenticate") {
    if (process.env.FAKE_ACP_LOGIN_FLOW === "1") {
      process.stderr.write("I0926 credential_manager.py:561] Credentials missing or invalid. Launching browser login flow...\n");
      return;
    }
    if (process.env.FAKE_ACP_BROWSER_LOGIN === "1") {
      // The real sign-in: print the authorization URL, record the method, answer.
      record({ method: "browser-login", browser: process.env.BROWSER ?? null });
      process.stderr.write("I0926 credential_manager.py:561] Credentials missing or invalid. Launching browser login flow...\n");
      process.stderr.write("Please visit this URL to authorize this application: https://accounts.google.com/o/oauth2/v2/");
      setTimeout(() => {
        process.stderr.write("auth?response_type=code&client_id=fake&state=fake\n");
        const settings = `${process.env.GEMINI_HOME}/antigravity-acp/settings.json`;
        fs.writeFileSync(settings, JSON.stringify({ auth: { type: "oauth-personal" } }), { mode: 0o600 });
        send({ id: message.id, result: {} });
      }, 30);
      return;
    }
    if (process.env.FAKE_ACP_AUTH_ERROR === "1") {
      send({ id: message.id, error: { code: -32603, message: "Internal error", data: { details: "OAuth callback failed" } } });
      return;
    }
    send({ id: message.id, result: {} });
  } else if (message.method === "session/new") {
    if (process.env.FAKE_ACP_NEW_ERROR === "network") {
      send({ id: message.id, error: { code: -32603, message: "Internal error", data: {
        details: "HTTPSConnectionPool(host='oauth2.googleapis.com'): Max retries exceeded (Caused by ProxyError('Unable to connect to proxy'))" } } });
      return;
    }
    if (process.env.FAKE_ACP_NEW_ERROR === "auth") {
      send({ id: message.id, error: { code: -32000, message: "Authentication required", data: { message: "No authentication method selected." } } });
      return;
    }
    const sessionId = `00000000-0000-4000-8000-${String(sessions.size + 1).padStart(12, "0")}`;
    sessions.set(sessionId, { model: models[0], mode: "default" });
    send({ id: message.id, result: { sessionId, ...sessionResult(sessions.get(sessionId)) } });
    update(sessionId, { sessionUpdate: "available_commands_update", availableCommands: [
      { name: "plan", description: "Plan carefully before executing a task." },
      { name: "logout", description: "Log out and clear stored credentials." },
    ] });
  } else if (message.method === "session/resume") {
    resumeAttempts += 1;
    const failure = process.env.FAKE_ACP_RESUME_ERROR;
    const details = {
      "tls-once": "SSLEOFError: EOF occurred in violation of protocol (_ssl.c:1104)",
      tls: "SSLEOFError: EOF occurred in violation of protocol (_ssl.c:1104)",
      proxy: "ProxyError: Unable to connect to proxy",
      auth: "UNAUTHENTICATED: credentials missing",
      quota: "RESOURCE_EXHAUSTED: quota exhausted",
      mcp: "There was a network issue: MCP load failed for shoggoth",
      region: "User location is not supported",
      storage: "No space left on device: private-history-path",
      history: "Failed to parse conversation history: unexpected EOF",
      certificate: "TLS handshake failed: CERTIFICATE_VERIFY_FAILED",
      unknown: "Unexpected EOF in private-history-path",
    }[failure];
    if (failure === "timeout") return;
    if (details && (failure !== "tls-once" || resumeAttempts === 1)) {
      send({ id: message.id, error: { code: -32603, message: "Internal error", data: { details } } });
      return;
    }
    // Mirrors the real server: mode survives a restart, model returns to its default.
    const state = sessions.get(message.params.sessionId) || { model: models[0], mode: "yolo" };
    sessions.set(message.params.sessionId, { ...state, model: models[0] });
    send({ id: message.id, result: sessionResult(sessions.get(message.params.sessionId)) });
  } else if (message.method === "session/set_config_option") {
    const state = sessions.get(message.params.sessionId);
    if (message.params.configId === "model" && !models.includes(message.params.value)) {
      send({ id: message.id, error: { code: -32602, message: "Unknown model" } });
      return;
    }
    state[message.params.configId] = message.params.value;
    send({ id: message.id, result: { configOptions: configOptions(state) } });
  } else if (message.method === "session/prompt") {
    void prompt(message);
  } else if (message.method === "session/cancel") {
    if (pendingPrompt?.sessionId === message.params.sessionId) {
      update(pendingPrompt.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "The request was cancelled by the client." } });
      send({ id: pendingPrompt.id, result: { stopReason: "cancelled" } });
      pendingPrompt = null;
    }
  } else if (message.id !== undefined) {
    send({ id: message.id, error: { code: -32601, message: "Method not found" } });
  }
});
