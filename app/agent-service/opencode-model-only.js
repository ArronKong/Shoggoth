"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { serviceError } = require("./security");
const { runBoundedModelOnly } = require("./runtime-model-only");
const { effortId } = require("./model-reasoning-catalog");

const AGENT = "shoggoth-model-only";
const PERMISSION = Object.freeze([{ permission: "*", pattern: "*", action: "deny" }]);
const fail = code => serviceError(code, "OpenCode 无工具模型任务未能完成");

function isolateOpenCodeModelEnvironment(env, privateConfig) {
  env.HOME = path.join(privateConfig, "home");
  for (const key of ["OPENCODE_DISABLE_PROJECT_CONFIG", "OPENCODE_DISABLE_EXTERNAL_SKILLS",
    "OPENCODE_DISABLE_CLAUDE_CODE_SKILLS", "OPENCODE_DISABLE_LSP_DOWNLOAD"]) env[key] = "1";
  // Keep the account's auth store so native OAuth refresh remains authoritative.
  // The one temporary session is removed after its private server has stopped.
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ autoupdate: false,
    permission: { "*": "deny" }, tools: { "*": false }, mcp: {}, plugin: [], instructions: [],
    compaction: { auto: false, prune: false },
    agent: { title: { disable: true }, summary: { disable: true },
      [AGENT]: { mode: "primary", steps: 2, permission: { "*": "deny" }, tools: { "*": false },
        prompt: "Complete the supplied text task. Tools and external actions are unavailable. Return only the requested output." } },
  });
}

function assertOpenCodeModelConfiguration(config, protectionPlugin = null) {
  const denied = value => value && Object.keys(value).length > 0 && value["*"] === "deny"
    && Object.values(value).every(action => action === "deny");
  if (!denied(config?.permission) || !denied(config.agent?.[AGENT]?.permission)
    || Object.keys(config.mcp || {}).length
    || JSON.stringify(config.plugin || []) !== JSON.stringify(protectionPlugin ? [protectionPlugin] : [])
    || (config.instructions || []).length || config.compaction?.auto !== false
    || config.agent?.[AGENT]?.steps !== 2) {
    throw fail("MODEL_ONLY_TOOLS_FORBIDDEN");
  }
}

function openCodeVariants(model) {
  return Object.entries(model?.variants || {}).filter(([, options]) =>
    options && typeof options === "object" && !Array.isArray(options) && options.disabled !== true);
}

const REASONING_VARIANT_FIELDS = ["reasoningEffort", "reasoning_effort", "effort", "reasoning", "reasoningConfig",
  "reasoningMode", "thinking", "thinkingConfig", "thinkingLevel", "thinkingBudget", "enableThinking", "enable_thinking"];

function hasReasoningOptions(fields) {
  return fields && (REASONING_VARIANT_FIELDS.some(key => fields[key] != null)
    || fields.output_config?.effort != null || fields.chat_template_kwargs?.thinking_mode != null
    || fields.chat_template_kwargs?.enable_thinking != null || fields.chat_template_args?.enable_thinking != null);
}

function openCodeThinkingOptions(model) {
  // OpenCode can also define variants for unrelated model options. Its V1
  // catalog supplies the provider options behind each variant alongside its ID.
  return openCodeVariants(model).filter(([id, options]) => effortId(id) && id !== "default"
    && (hasReasoningOptions(options) || hasReasoningOptions(options.modelParams)))
    .slice(0, 16).map(([id]) => id);
}

function resolveOpenCodeModelSettings(execution, model) {
  const core = require("./shoggoth-memory/core.cjs");
  const variants = openCodeVariants(model).map(([id]) => id).filter(id =>
    Object.hasOwn(core.MEMORY_THINKING_LEVEL_RANKS, core.normalizeMemoryThinkingLevel(id)));
  // An explicit non-reasoning capability has only the off level. Unknown or
  // fixed reasoning cannot be represented as an adjustable native setting.
  if (!variants.length && model?.capabilities?.reasoning !== false) throw fail("MODEL_ONLY_SETTINGS_UNAVAILABLE");
  const settings = require("./memory-model-settings").resolveMemoryModelExecution(execution, {
    thinkingOptions: variants.length ? variants : ["off"],
    thinkingDefault: null, fastTier: null,
  });
  return variants.length ? { variant: settings.thinkingLevel } : {};
}

async function generateOpenCodeModelOnly(host, input) {
  return runBoundedModelOnly(input, async signal => {
    const { OpenCodeRuntimeHost, modelRef, usageFromTokens, openCodeFailureCode } = require("./opencode-runtime-host");
    let requested = modelRef(input.model);
    const worker = new OpenCodeRuntimeHost({ paths: host.paths, runtimeBinding: host.binding,
      runtimeEnvironment: host.runtimeEnvironment, parentEnv: host.parentEnv, fs: host.fs,
      spawnProcess: host.spawnProcess, controlInstance: true, modelOnlyInstance: true,
      secretGateway: host.secretGateway, modelProjectionPluginPath: host.modelProjectionPluginPath,
      permissionPolicy: { approvalPolicy: "never", sandbox: "read-only" } });
    let sessionId = null, stopError = null, originalError = null;
    const stop = () => { void worker.stop().catch(cause => { stopError = cause; }); };
    const fence = () => {
      if (signal.aborted || host.state !== "ready") throw fail("MODEL_ONLY_CANCELED");
      input.assertCurrent?.();
    };
    host.modelWorkers.add(worker);
    signal.addEventListener("abort", stop, { once: true });
    try {
      const scope = input.modelSecretScope;
      if (worker.secretGateway && (typeof scope?.profileId !== "string" || !scope.profileId.trim()
        || typeof scope?.sessionId !== "string" || !scope.sessionId.trim())) {
        throw fail("SECRET_MODEL_IDENTITY_UNAVAILABLE");
      }
      const secretScope = worker.secretGateway ? Object.freeze({ profileId: scope.profileId, sessionId: scope.sessionId }) : null;
      fence(); await worker.initialize(); fence();
      let settings = {};
      if (input.execution) {
        if (!requested) {
          const config = (await worker.client.request("GET", "/config", undefined, { signal })).data;
          requested = modelRef(config?.model);
        }
        if (!requested) throw fail("MODEL_ONLY_SETTINGS_UNAVAILABLE");
        const catalog = (await worker.client.request("GET", "/provider", undefined, { signal })).data;
        const provider = catalog?.all?.find(item => item.id === requested.providerID);
        const model = provider?.models?.[requested.id];
        if (!catalog?.connected?.includes(requested.providerID) || !model) throw fail("RUNTIME_MODEL_UNAVAILABLE");
        settings = resolveOpenCodeModelSettings(input.execution, model);
        fence();
      }
      const created = (await worker.client.request("POST", "/session", {
        title: "Shoggoth model task", permission: PERMISSION,
      }, { signal })).data;
      if (!/^ses_[A-Za-z0-9]+$/u.test(created?.id || "")) throw fail("MODEL_ONLY_ACCEPTANCE_UNKNOWN");
      sessionId = created.id;
      const route = `/session/${sessionId}`;
      const session = (await worker.client.request("GET", route, undefined, { signal })).data;
      if (session?.id !== sessionId || JSON.stringify(session.permission) !== JSON.stringify(PERMISSION)) {
        throw fail("MODEL_ONLY_TOOLS_FORBIDDEN");
      }
      if (secretScope) {
        if (!worker.modelSecretRoute?.ready()) throw fail("SECRET_MODEL_PROJECTION_UNAVAILABLE");
        worker.modelSecretScopes.set(sessionId, secretScope);
      }
      fence();
      const messageId = `msg_${crypto.randomBytes(16).toString("hex")}`;
      const response = (await worker.client.request("POST", `${route}/message`, {
        messageID: messageId, agent: AGENT, tools: { "*": false },
        // Keep the run's trusted host protocol above the supplied recall brief
        // and evidence. A dedicated worker must not drop these instructions.
        ...(host.modelInstructions ? { system: host.modelInstructions } : {}),
        ...(requested ? { model: { providerID: requested.providerID, modelID: requested.id } } : {}),
        ...settings,
        parts: [{ type: "text", text: input.prompt }],
      }, { signal, timeoutMs: input.timeoutMs ?? 600_000 })).data;
      fence();
      // Inspect the complete temporary conversation, not just the last answer:
      // an intermediate tool call must never be hidden by a later text result.
      const messages = (await worker.client.request("GET", `${route}/message`, undefined, { signal })).data;
      if (!Array.isArray(messages) || messages.some(message => !Array.isArray(message.parts))) {
        throw fail("MODEL_ONLY_OUTPUT_INVALID");
      }
      if (messages.some(message => message.parts.some(part => ["tool", "subtask"].includes(part.type)))) {
        throw fail("MODEL_ONLY_TOOLS_FORBIDDEN");
      }
      const info = response?.info;
      if (info?.error) throw fail(openCodeFailureCode(info.error));
      if (settings.variant !== undefined && (messages.find(message => message.info?.id === messageId)?.info?.model?.variant !== settings.variant
        || info?.variant !== settings.variant)) throw fail("MODEL_ONLY_SETTINGS_UNAVAILABLE");
      if (info?.role !== "assistant" || info.parentID !== messageId || info.sessionID !== sessionId
        || !info.time?.completed || typeof info.providerID !== "string" || typeof info.modelID !== "string"
        || !Array.isArray(response.parts) || response.parts.some(part => part.type === "text" && typeof part.text !== "string")
        || !messages.some(message => message.info?.id === info.id)) throw fail("MODEL_ONLY_OUTPUT_INVALID");
      const selected = modelRef(`${info.providerID}/${info.modelID}`);
      if (requested && (selected.providerID !== requested.providerID || selected.id !== requested.id)) {
        throw fail("RUNTIME_MODEL_UNAVAILABLE");
      }
      const text = response.parts.filter(part => part.type === "text").map(part => part.text).join("");
      if (typeof text !== "string" || !text.isWellFormed() || text.includes("\0")
        || !text.trim() || Buffer.byteLength(text) > 32 * 1024) throw fail("MODEL_ONLY_OUTPUT_INVALID");
      fence(); input.onText?.(text);
      return { text, model: `${selected.providerID}/${selected.id}`, provider: selected.providerID,
        usage: usageFromTokens(info.tokens) };
    } catch (cause) {
      originalError = cause; throw cause;
    } finally {
      signal.removeEventListener("abort", stop);
      // Killing this dedicated process confirms that even an unknown HTTP
      // receipt cannot continue execution after the admission slot is released.
      try { await worker.stop(); } catch { throw fail("RUNTIME_STOP_UNCONFIRMED"); }
      if (stopError) throw fail("RUNTIME_STOP_UNCONFIRMED");
      host.modelWorkers.delete(worker);
      if (sessionId && host.state === "ready") {
        try {
          const removed = await host.client.request("DELETE", `/session/${sessionId}`, undefined, { timeoutMs: 2_000 });
          if (removed.data !== true) throw fail("MODEL_ONLY_CLEANUP_FAILED");
        } catch (cause) {
          // Preserve the actual Provider/transport failure when cleanup also
          // fails. Execution has already been confirmed stopped above.
          if (originalError) originalError.cleanupErrorCode = "MODEL_ONLY_CLEANUP_FAILED";
          else throw fail("MODEL_ONLY_CLEANUP_FAILED");
        }
      }
      if (worker.privateConfig) host.fs.rmSync(worker.privateConfig, { recursive: true, force: true });
    }
  }, { cleanupMs: 10_000 });
}

module.exports = { isolateOpenCodeModelEnvironment, assertOpenCodeModelConfiguration, generateOpenCodeModelOnly,
  openCodeThinkingOptions, resolveOpenCodeModelSettings };
