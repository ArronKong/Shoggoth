"use strict";
const crypto = require("node:crypto");
const { runtimeBinding, runtimeCapabilities } = require("./runtime-adapter");
const { validateRuntimeContextUsage } = require("./runtime-context-usage");
const { serviceError } = require("./security");
const METHODS = Object.freeze({
  sessionStart: "session.start", sessionResume: "session.resume", sessionRead: "session.read", sessionList: "session.list",
  sessionRename: "session.rename", sessionArchive: "session.archive", sessionUnarchive: "session.unarchive", sessionDelete: "session.delete",
  turnStart: "turn.start", turnSteer: "turn.steer", turnInterrupt: "turn.interrupt", modelsList: "models.list",
  commandsList: "commands.list", commandExecute: "commands.execute", accountRead: "account.read",
  accountLogin: "account.login", accountLogout: "account.logout", generateModelOnly: "model.generate.toolFree",
});
const EVENT_TYPES = new Set(["text", "text_delta", "reasoning", "reasoning_delta", "plan", "tool_start", "tool_update", "tool_result", "status",
  "complete", "usage", "context_usage", "context_compacted", "error", "warning", "account_backoff", "account_unavailable", "rate_limits"]);
const fail = (code = "RUNTIME_HANDLE_INVALID") => serviceError(code, "Runtime V1 contract rejected the operation");
function data(value, maxBytes = 8 * 1024 * 1024) {
  let size = 0, nodes = 0;
  const visit = (item, depth) => {
    if (++nodes > 100_000 || depth > 32) throw fail("RUNTIME_PROTOCOL_INVALID");
    if (item === null || typeof item === "boolean") return item;
    if (typeof item === "string") { size += Buffer.byteLength(item); if (!item.isWellFormed() || size > maxBytes) throw fail("RUNTIME_PROTOCOL_INVALID"); return item; }
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (!item || typeof item !== "object" || ![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(item))) throw fail("RUNTIME_PROTOCOL_INVALID");
    if (Array.isArray(item) && (item.length > 100_000 || Object.keys(item).length !== item.length
      || Object.keys(item).some(key => !/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= item.length))) throw fail("RUNTIME_PROTOCOL_INVALID");
    const output = Array.isArray(item) ? [] : {};
    for (const key of Reflect.ownKeys(item)) {
      if (Array.isArray(item) && key === "length") continue;
      if (typeof key === "string") { size += Buffer.byteLength(key); if (size > maxBytes) throw fail("RUNTIME_PROTOCOL_INVALID"); }
      const property = Object.getOwnPropertyDescriptor(item, key);
      if (typeof key !== "string" || !property.enumerable || !Object.hasOwn(property, "value")) throw fail("RUNTIME_PROTOCOL_INVALID");
      // Legacy native envelopes omit optional undefined values in JSON.
      if (property.value === undefined) continue;
      Object.defineProperty(output, key, { value: visit(property.value, depth + 1), enumerable: true, writable: true, configurable: true });
    }
    return output;
  };
  return visit(value, 0);
}
const id = value => typeof value === "string" && value.length > 0 && value.length <= 512 && value.isWellFormed() && !value.includes("\0");
function validateResult(method, value, input = {}) {
  const result = data(value ?? null);
  if (["sessionStart", "sessionResume", "sessionRead"].includes(method)) {
    if (!result?.session || !id(result.session.id)
      || (method !== "sessionStart" && input.sessionId && result.session.id !== input.sessionId)) throw fail("RUNTIME_PROTOCOL_INVALID");
  } else if (method === "turnStart" && !id(result?.turn?.id)) throw fail("RUNTIME_TURN_ACCEPTANCE_UNKNOWN");
  else if (method === "sessionList" && !Array.isArray(result?.data ?? result?.sessions)) throw fail("RUNTIME_PROTOCOL_INVALID");
  else if (method === "modelsList" && !Array.isArray(result?.data ?? result?.models)) throw fail("RUNTIME_PROTOCOL_INVALID");
  else if (method === "commandsList" && !Array.isArray(result?.commands)) throw fail("RUNTIME_PROTOCOL_INVALID");
  return result;
}
function validateEvent(value) {
  const event = data(value);
  if (event?.known !== true || !EVENT_TYPES.has(event.type)) return null;
  if (!["warning", "error", "account_backoff", "account_unavailable", "rate_limits"].includes(event.type)
    && !id(event.sessionId ?? event.threadId)) throw fail("RUNTIME_PROTOCOL_INVALID");
  if (event.turnId !== undefined && event.turnId !== null && !id(event.turnId)) throw fail("RUNTIME_PROTOCOL_INVALID");
  if (event.type === "text" && typeof event.text !== "string") throw fail("RUNTIME_PROTOCOL_INVALID");
  if (["text_delta", "reasoning_delta"].includes(event.type) && typeof event.delta !== "string") throw fail("RUNTIME_PROTOCOL_INVALID");
  if (event.type === "reasoning" && event.reasoning !== undefined
    && typeof event.reasoning !== "string" && !Array.isArray(event.reasoning)) throw fail("RUNTIME_PROTOCOL_INVALID");
  if (["context_usage", "context_compacted"].includes(event.type)) validateRuntimeContextUsage(event.contextUsage);
  return Object.freeze(event);
}

// One facade per pooled transport. It owns no run authority; the Coordinator's
// per-attempt leases still fence every execution and host capability call.
function runtimeHandleV1(raw, expectedBinding, { onViolation = () => {} } = {}) {
  const binding = runtimeBinding(expectedBinding);
  if (!raw || ["runtime", "runtimeProfileId", "runtimeAccountId"].some(key => raw[key] !== binding[key])
    || typeof raw.subscribe !== "function" || !raw.terminated || typeof raw.terminated.then !== "function") throw fail();
  const capabilities = runtimeCapabilities(raw.capabilities);
  const nativeMethod = method => method === "accountLogin" && !raw.accountLogin ? "accountLoginStart" : method;
  for (const [method, capability] of Object.entries(METHODS)) if (capabilities[capability] && typeof raw[nativeMethod(method)] !== "function") throw fail();
  if (capabilities.serverRequests && typeof raw.registerServerRequestHandler !== "function") throw fail();
  const home = raw.host?.home ?? raw.host?.runtimeEnvironment?.userHome ?? raw.homeIdentity ?? null;
  if (home !== null && typeof home !== "string") throw fail();
  const identity = Object.freeze({ ...binding, homeIdentity: crypto.createHash("sha256")
    .update(JSON.stringify([binding.runtime, binding.runtimeAccountId, home])).digest("hex") });
  let alive = true;
  const cleanups = new Set(), observations = new Map();
  const assertAlive = () => { if (!alive) throw fail("RUNTIME_HANDLE_TERMINATED"); };
  const finish = () => { alive = false; for (const unsubscribe of cleanups) { try { unsubscribe(); } catch {} } cleanups.clear(); observations.clear(); };
  const terminated = Promise.resolve(raw.terminated).then(value => { finish(); return value; }, error => { finish(); throw error; });
  terminated.catch(() => {});
  const facade = { kind: "shoggoth-runtime-handle", version: 1, ...binding, identity, capabilities, terminated,
    host: raw.host, workspace: raw.workspace, controlInstance: raw.controlInstance === true,
    get registeredSecrets() { return raw.registeredSecrets || []; },
    assertExecutionProviderCurrent() { assertAlive(); raw.assertExecutionProviderCurrent?.(); },
    async authenticationState(input) { assertAlive(); if (typeof raw.authenticationState !== "function") throw fail("RUNTIME_CAPABILITY_UNSUPPORTED");
      const result = await raw.authenticationState(input); assertAlive(); return data(result); },
    subscribe(listener) {
      assertAlive();
      const unsubscribe = raw.subscribe(value => {
        if (!alive) return;
        let event;
        try {
          event = validateEvent(value); if (!event) return;
        } catch (error) {
          onViolation({ runtime: binding.runtime, code: error.code || "RUNTIME_PROTOCOL_INVALID",
            type: Object.getOwnPropertyDescriptor(value || {}, "type")?.value });
          // A broken event stream cannot prove execution completion. Retire it;
          // the coordinator records unknown acceptance instead of replaying.
          void Promise.resolve().then(() => raw.stop ? raw.stop() : raw.host?.stop?.()).catch(() => {});
          return;
        }
        if (event.contextUsage) { observations.set(event.sessionId ?? event.threadId, event.contextUsage);
          while (observations.size > 512) observations.delete(observations.keys().next().value); }
        listener(event);
      });
      const dispose = typeof unsubscribe === "function" ? unsubscribe : () => unsubscribe?.unsubscribe?.();
      cleanups.add(dispose); return () => { cleanups.delete(dispose); dispose(); };
    },
    registerServerRequestHandler(method, handler) {
      assertAlive(); if (!capabilities.serverRequests) throw fail("RUNTIME_CAPABILITY_UNSUPPORTED");
      const remove = raw.registerServerRequestHandler(method, async (params, context) => {
        assertAlive(); const result = await handler(data(params), context); assertAlive(); return result;
      });
      cleanups.add(remove); return () => { cleanups.delete(remove); remove(); };
    },
    subscribeAccountAuth(listener) {
      assertAlive(); if (typeof raw.subscribeAccountAuth !== "function") return () => {};
      const remove = raw.subscribeAccountAuth(value => { if (alive) listener(data(value)); });
      cleanups.add(remove); return () => { cleanups.delete(remove); remove(); };
    },
    async contextUsage({ sessionId }) { assertAlive(); if (!id(sessionId)) throw fail("RUNTIME_PROTOCOL_INVALID");
      return observations.get(sessionId) || null; },
    async compact({ sessionId, cwd }) { assertAlive(); if (!capabilities["context.compact.native"]) throw fail("RUNTIME_CAPABILITY_UNSUPPORTED");
      return facade.commandExecute({ text: "/compact", sessionId, cwd }); },
    async stop() { if (!alive) return; if (typeof raw.host?.stop !== "function" && typeof raw.stop !== "function") throw fail("RUNTIME_STOP_UNCONFIRMED");
      await (raw.stop ? raw.stop() : raw.host.stop()); finish(); },
  };
  for (const [method, capability] of Object.entries(METHODS)) {
    if (!capabilities[capability]) continue;
    facade[method] = async input => {
    assertAlive(); if (!capabilities[capability]) throw fail("RUNTIME_CAPABILITY_UNSUPPORTED");
    // Signals are local control authority, not transport data.
    const { signal, ...payload } = input || {}; const checked = data(payload);
    const result = await raw[nativeMethod(method)]({ ...checked, ...(signal ? { signal } : {}) });
    assertAlive(); return validateResult(method, result, checked);
  };
  }
  if (facade.accountLogin) facade.accountLoginStart = facade.accountLogin;
  for (const method of ["accountLoginApiKey", "accountLoginCancel"]) if (capabilities["account.login"] && typeof raw[method] === "function") {
    facade[method] = async input => { assertAlive(); const result = await raw[method](data(input)); assertAlive(); return data(result); };
  }
  return Object.freeze(facade);
}
module.exports = { runtimeHandleV1, validateRuntimeHandleResult: validateResult, validateRuntimeEvent: validateEvent, runtimeData: data, RUNTIME_V1_METHODS: METHODS };
