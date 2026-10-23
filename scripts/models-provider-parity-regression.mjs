#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import net from "node:net";
import http from "node:http";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const uiRoot = path.join(root, "app/manage-ui");
const viteBin = path.join(uiRoot, "node_modules/vite/bin/vite.js");
const require = createRequire(import.meta.url);
const playwrightCandidates = [
  path.join(root, "node_modules/playwright"),
  path.join(uiRoot, "node_modules/playwright"),
  path.join(os.homedir(), "node_modules/playwright"),
  path.join(os.homedir(), ".openclaw/workspace/node_modules/playwright"),
];
let chromium;
for (const candidate of playwrightCandidates) {
  try {
    ({ chromium } = require(candidate));
    break;
  } catch (error) {
    if (error?.code !== "MODULE_NOT_FOUND") throw error;
  }
}
assert.ok(chromium, "找不到 Playwright；请先安装项目测试依赖");
const requested = new Set(process.argv.slice(2));
const knownFlags = new Set(["--provider", "--tool-keys", "--managed-provider", "--managed-recovery", "--managed-native"]);
const unknownFlags = [...requested].filter((flag) => !knownFlags.has(flag));

if (unknownFlags.length > 0) {
  console.error(`models provider parity regression: unknown option ${unknownFlags.join(", ")}`);
  process.exit(2);
}

const runProvider = requested.size === 0 || requested.has("--provider");
const runToolKeys = requested.size === 0 || requested.has("--tool-keys");
const runManagedProvider = requested.size === 0 || requested.has("--managed-provider");
const runManagedRecovery = requested.size === 0 || requested.has("--managed-recovery");
const runManagedNative = requested.size === 0 || requested.has("--managed-native");
const REDACTED = "••••sentinel";
const REVEALED_SENTINEL = "revealed-sentinel";
const INPUT_SENTINEL = "input-sentinel";
const ADDED_KEY = "MiXeD_TOOL_KEY";
const ADDED_VALUE = "  added-secret-sentinel  ";
const LATE_KEY = "LATE_TOOL_KEY";
const REDACTED_AFTER_SAVE = "••••changed";
const BASE_URL = "https://api.example.test/v1";
const EDITED_BASE_URL = "https://edited.example.test/v1";

function revision(char) {
  return char.repeat(64);
}

async function waitFor(check, label, timeout = 7_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`等待超时：${label}`);
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

function formatError(error) {
  return error instanceof Error ? (error.stack || error.message) : String(error);
}

function processExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForProcessExit(child, timeout) {
  if (processExited(child)) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeout);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

async function stopProcess(child) {
  if (processExited(child)) return;
  child.kill("SIGTERM");
  if (await waitForProcessExit(child, 1_500)) return;
  if (!child.kill("SIGKILL") && !processExited(child)) {
    throw new Error("Vite 进程 SIGKILL 发送失败");
  }
  if (!(await waitForProcessExit(child, 1_500))) throw new Error("Vite 进程 SIGKILL 后仍未退出");
}

function envVar({
  key,
  category,
  isSet,
  isPassword = true,
  provider,
  providerLabel,
  description = "",
  tools,
}) {
  return {
    key,
    isSet,
    redactedValue: isSet ? REDACTED : null,
    description,
    url: null,
    category,
    isPassword,
    advanced: false,
    ...(provider ? { provider } : {}),
    ...(providerLabel ? { providerLabel } : {}),
    ...(tools ? { tools } : {}),
  };
}

function createState(backend) {
  return {
    backend,
    managed: false,
    pendingOperations: [],
    pendingIdentityResponse: null,
    pendingIdentityHttpStatus: 200,
    pendingIdentityReads: 0,
    readFailures: [],
    recoverResponse: null,
    recoverHttpStatus: 200,
    recoverLostAck: false,
    receiptHttpOrigin: null,
    operationResponse: null,
    operationHttpStatus: 200,
    directoryReads: 0,
    modelRequests: [],
    nextResult: null,
    calls: [],
    unexpectedRequests: [],
    provider: {
      inConfig: true,
      baseUrl: BASE_URL,
      keyConfigured: true,
    },
    vars: [
      envVar({
        key: "OPENROUTER_BASE_URL",
        category: "provider",
        isSet: true,
        isPassword: false,
        provider: "openrouter",
        providerLabel: "OpenRouter",
      }),
      envVar({
        key: "OPENROUTER_API_KEY",
        category: "provider",
        isSet: true,
        provider: "openrouter",
        providerLabel: "OpenRouter",
      }),
      envVar({
        key: "EXA_API_KEY",
        category: "tool",
        isSet: true,
        description: "Search tool credential",
        tools: ["exa"],
      }),
      envVar({
        key: LATE_KEY,
        category: "tool",
        isSet: true,
      }),
      ...(backend === "hermes"
        ? [
            envVar({
              key: "FIRECRAWL_API_KEY",
              category: "tool",
              isSet: false,
              description: "Unset directory entry",
              tools: ["firecrawl"],
            }),
          ]
        : []),
    ],
    delayNextAdd: false,
  };
}

function providerDirectory(state) {
  return {
    supported: true,
    providers: [
      {
        id: "openrouter",
        label: "OpenRouter",
        logoKey: "openrouter",
        getKeyUrl: null,
        inConfig: state.provider.inConfig,
        api: state.managed && state.provider.api === null ? null : "openai-responses",
        ...(state.managed ? { writeMode: "managed-model-change" } : {}),
        baseUrl: { value: state.provider.baseUrl,
          defaultValue: state.managed && state.provider.noDefaultEndpoint ? null : BASE_URL,
          editable: !state.managed || !state.provider.noModel && state.provider.api !== null },
        key: {
          configured: state.provider.keyConfigured,
          clearable: true,
          source: state.provider.keyConfigured ? "config" : null,
          redacted: state.provider.keyConfigured ? REDACTED : null,
          ...(state.managed ? { editable: !state.provider.noModel && state.provider.api !== null
            && Boolean(state.provider.baseUrl || !state.provider.noDefaultEndpoint),
            editReason: state.provider.noModel || state.provider.api === null ? "provider_metadata_required"
              : !state.provider.baseUrl && state.provider.noDefaultEndpoint ? "endpoint_required" : null } : {}),
        },
        keyProbePath: "/key",
        configured: true,
        custom: false,
        modelsCount: 1,
        defaultModelId: state.managed && state.provider.noModel ? null : "fixture-model",
        oauth: [],
      },
      ...(state.backend === "openclaw" ? [
        {
          id: "auth-only-custom",
          label: "Auth-only Custom",
          logoKey: "auth-only-custom",
          getKeyUrl: null,
          inConfig: false,
          ...(state.managed ? { writeMode: "managed-model-change" } : {}),
          api: null,
          baseUrl: { value: null, defaultValue: null, editable: false },
          key: { configured: true, clearable: !state.managed, source: "auth-profile", redacted: REDACTED,
            ...(state.managed ? { editable: false, editReason: "provider_metadata_required" } : {}) },
          keyProbePath: null,
          configured: true,
          custom: true,
          modelsCount: 0,
          defaultModelId: null,
          oauth: [],
        },
        {
          id: "manual-no-url",
          label: "Manual No URL",
          logoKey: "manual-no-url",
          getKeyUrl: null,
          inConfig: true,
          ...(state.managed ? { writeMode: "managed-model-change" } : {}),
          api: "openai-completions",
          baseUrl: { value: null, defaultValue: null, editable: true },
          key: { configured: false, clearable: false, source: null, redacted: null,
            ...(state.managed ? { editable: false, editReason: "endpoint_required" } : {}) },
          keyProbePath: null,
          configured: true,
          custom: true,
          modelsCount: 1,
          defaultModelId: "manual-model",
          oauth: [],
        },
      ] : []),
    ],
  };
}

function recordCall(state, { kind, method, backend, key, valueMatchesExpected }) {
  // 只记录无敏感信息的契约摘要；submitted value 永不进入状态、断言错误或日志。
  state.calls.push({ kind, method, backend, key, valueMatchesExpected });
}

function setEnvState(state, key, isSet) {
  let item = state.vars.find((entry) => entry.key === key);
  if (!item) {
    item = envVar({ key, category: "tool", isSet: false });
    state.vars.push(item);
  }
  item.isSet = isSet;
  item.redactedValue = isSet ? (key === LATE_KEY ? REDACTED_AFTER_SAVE : REDACTED) : null;
}

async function installApiFake(page, state) {
  await page.route("**/__api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const rawBackend = url.searchParams.get("backend");
    const globalRoute = url.pathname === "/__api/config" || url.pathname === "/__api/status";
    const rejectUnexpected = async (expectedMethods = [], status) => {
      state.unexpectedRequests.push({
        method,
        backend: rawBackend,
        path: url.pathname,
        expectedMethods,
      });
      await route.fulfill({
        status: status ?? (expectedMethods.length > 0 ? 405 : 404),
        json: { error: "unexpected fixture request" },
      });
    };
    if (url.pathname === "/__api/backends") {
      if (method !== "GET") return rejectUnexpected(["GET"]);
      await route.fulfill({ json: { backends: [] } });
      return;
    }
    if (url.pathname === "/__api/shoggoth/status") {
      if (method !== "GET") return rejectUnexpected(["GET"]);
      await route.fulfill({ status: 503, json: { error: "native service is outside the provider fixture" } });
      return;
    }
    if (!globalRoute && rawBackend !== state.backend) return rejectUnexpected([], 400);
    const backend = globalRoute ? state.backend : rawBackend;
    if (method === "GET" && state.readFailures.includes(url.pathname)) {
      await route.fulfill({ status: 503, json: { error: "fixture read unavailable" } }); return;
    }

    if (url.pathname === "/__api/config") {
      if (method !== "GET") return rejectUnexpected(["GET"]);
      await route.fulfill({
        json: {
          config: {
            gatewayUrl: "",
            token: "fixture-token",
            locale: "zh-CN",
            theme: "light",
            disabledBackends: [],
            notifications: { chat: false, cron: false, task: false },
            setupCompletedAt: 1,
          },
        },
      });
      return;
    }
    if (url.pathname === "/__api/status") {
      if (method !== "GET") return rejectUnexpected(["GET"]);
      await route.fulfill({
        json: {
          backends: [
            { id: "openclaw", name: "OpenClaw", connected: true },
            { id: "hermes", name: "Hermes", connected: true },
          ],
        },
      });
      return;
    }
    if (url.pathname === "/__api/models/config/capabilities") {
      if (method !== "GET") return rejectUnexpected(["GET"]);
      await route.fulfill({
        json:
          backend === "hermes"
            ? {
                supported: true,
                create: true,
                update: true,
                rename: true,
                delete: true,
                updateProvider: true,
                perAgentModelSettings: true,
                providerDirectory: false,
                blockers: [],
              }
            : {
                supported: true,
                create: true,
                update: true,
                rename: true,
                delete: true,
                updateProvider: true,
                perAgentModelSettings: false,
                providerDirectory: true,
                manageAuthProfiles: !state.managed,
                renameProvider: false, batch: !state.managed,
                blockers: [],
              },
      });
      return;
    }
    if (url.pathname === "/__api/models/config/pending") {
      if (method !== "GET") return rejectUnexpected(["GET"]);
      await route.fulfill({ json: { operations: state.pendingOperations } });
      return;
    }
    if (url.pathname === "/__api/models/config/pending-identities") {
      if (method !== "GET") return rejectUnexpected(["GET"]);
      state.pendingIdentityReads += 1;
      await route.fulfill({ status: state.pendingIdentityHttpStatus, json: state.pendingIdentityResponse ?? {
        version: 1, backendId: state.backend,
        operations: state.pendingOperations.map(({ operationId, providerKey, status, stage, code }) => ({
          operationId, providerKey, status, stage, ...(code ? { code } : {}),
        })),
      } }); return;
    }
    if (url.pathname === "/__api/models/config/operation/recover") {
      if (method !== "POST") return rejectUnexpected(["POST"]);
      const operationId = url.searchParams.get("operationId"), providerKey = url.searchParams.get("provider");
      if (state.nativeRows) assert.equal(state.nativeRows.some(row => row.operationId === operationId
        && row.backendId === rawBackend && row.providerKey === providerKey && row.code === "model_recovery_requested"), true,
        "manual recovery requires the confirmed native marker before HTTP");
      recordCall(state, { kind: "recover-original-model", method, backend: rawBackend, key: providerKey,
        valueMatchesExpected: [...url.searchParams.keys()].sort().join(",") === "backend,operationId,provider"
          && Object.keys(request.postDataJSON()).length === 0
          && state.pendingOperations.some((row) => row.operationId === operationId && row.providerKey === providerKey) });
      state.calls.at(-1).operationId = operationId;
      if (state.receiptHttpOrigin) {
        const actual = await route.fetch({ url: `${state.receiptHttpOrigin}${url.pathname}${url.search}` });
        noteNativeJournalReceipt(state, await actual.json());
        await route.fulfill({ response: actual }); return;
      }
      if (state.recoverLostAck) { await route.abort("failed"); return; }
      await route.fulfill({ status: state.recoverHttpStatus, json: state.recoverResponse ?? {
        version: 1, backendId: rawBackend, providerKey, operationId, status: "cleanup_pending", stage: "credential-write", terminal: false,
      } }); return;
    }
    if (url.pathname === "/__api/models/config/operation") {
      if (method !== "GET") return rejectUnexpected(["GET"]);
      const operationId = url.searchParams.get("operationId");
      const providerKey = url.searchParams.get("provider");
      recordCall(state, { kind: "observe-managed-provider", method, backend: rawBackend, key: providerKey,
        valueMatchesExpected: [...url.searchParams.keys()].sort().join(",") === "backend,operationId,provider"
          && (state.modelRequests.some((item) => item.operationId === operationId)
            || state.pendingOperations.some((item) => item.operationId === operationId && item.providerKey === providerKey)) && providerKey === "openrouter" });
      state.calls.at(-1).operationId = operationId;
      if (state.receiptHttpOrigin) {
        const actual = await route.fetch({ url: `${state.receiptHttpOrigin}${url.pathname}${url.search}` });
        noteNativeJournalReceipt(state, await actual.json());
        await route.fulfill({ response: actual }); return;
      }
      const pending = state.pendingOperations.find((item) => item.operationId === operationId
        && item.backendId === rawBackend && item.providerKey === providerKey);
      noteNativeJournalReceipt(state, state.operationResponse);
      await route.fulfill({ status: state.operationHttpStatus,
        json: state.operationResponse ?? { version: 1, backendId: rawBackend, operationId, providerKey,
          status: pending?.status ?? "not_found", stage: pending?.stage ?? "observation", terminal: false } });
      return;
    }
    if (url.pathname === "/__api/models/config") {
      if (method === "GET") {
        await route.fulfill({ json: { providers: [] } });
        return;
      }
      if (method === "POST" && state.backend === "openclaw") {
        const body = request.postDataJSON();
        if (state.managed && state.nativeRows) assert.equal(state.nativeRows.some(row => row.operationId === body.operationId
          && row.backendId === rawBackend && row.providerKey === body.providerKey), true, "native retain must precede managed model HTTP");
        if (state.managed && state.nativeRows) assert.equal(state.nativeRows.some(row => row.operationId === body.operationId
        && row.backendId === rawBackend && row.providerKey === body.providerKey), true, "native retain must precede managed model HTTP");
      if (state.managed) state.modelRequests.push({ method, operationId: body.operationId,
          endpoint: Boolean(body.baseUrl), key: Boolean(body.apiKey), clear: body.clearApiKey === true });
        const { safeSpec, secretEnvelope } = require(path.join(root, "app/core/model-change-validation"))
          .normalizeModelChangeRequest(body);
        const keyCreation = state.managed && Boolean(body.apiKey);
        recordCall(state, {
          kind: keyCreation ? "create-provider-secret" : "create-provider-endpoint", method, backend: rawBackend,
          key: body.providerKey,
          valueMatchesExpected: safeSpec.kind === "create"
            && safeSpec.providerMode === "new" && safeSpec.providerKey === "openrouter"
            && safeSpec.baseUrl === (keyCreation ? BASE_URL : EDITED_BASE_URL) && safeSpec.api === "openai-responses"
            && safeSpec.model.id === "fixture-model" && (!keyCreation || secretEnvelope.apiKey === INPUT_SENTINEL),
        });
        if (state.managed) state.calls.at(-1).operationId = body.operationId;
        const result = state.nextResult ?? { status: "applied" };
        if (state.managed && ["applied", "failed", "compensated"].includes(result.status)) noteNativeJournalReceipt(state,
          { version: 1, backendId: rawBackend, providerKey: body.providerKey, operationId: body.operationId,
            status: result.status, stage: "commit", terminal: true });
        if (result.status === "applied" || result.lostAck) {
          state.provider.inConfig = true;
          state.provider.baseUrl = safeSpec.baseUrl;
          if (keyCreation) state.provider.keyConfigured = true;
        }
        if (state.managed && result.status !== "applied") state.pendingOperations = [{
          operationId: body.operationId, backendId: rawBackend, providerKey: body.providerKey,
          kind: "create", status: result.status, stage: "credential-write", source: null, target: null,
        }];
        if (result.lostAck) { await route.abort("failed"); return; }
        if (result.invalidJSON) { await route.fulfill({ contentType: "application/json", body: "{" }); return; }
        await route.fulfill({ json: {
          ...(result.omitOperation ? {} : { operationId: state.managed ? (result.wrongOperation ? "wrong-operation" : body.operationId) : "fixture-create-provider" }),
          status: result.status, stage: result.status === "applied" ? "commit" : "credential-write", activation: null,
          ...(result.status !== "applied" ? { code: "fixture_not_applied" } : {}),
          ...(result.extraAck ?? {}),
        } });
        return;
      }
      if (method !== "PUT") return rejectUnexpected(["GET", "POST", "PUT"]);
      const body = request.postDataJSON();
      if (state.managed && state.nativeRows) assert.equal(state.nativeRows.some(row => row.operationId === body.operationId
        && row.backendId === rawBackend && row.providerKey === body.providerKey), true, "native retain must precede managed model HTTP");
      if (state.managed) state.modelRequests.push({ method, operationId: body.operationId,
        endpoint: Boolean(body.baseUrl), key: Boolean(body.apiKey), clear: body.clearApiKey === true });
      if (body.baseUrl) {
        state.provider.baseUrl = body.baseUrl;
        recordCall(state, {
          kind: "save-provider-base-url",
          method,
          backend: rawBackend,
          key: body.providerKey,
          valueMatchesExpected:
            body.providerKey === "openrouter" && body.baseUrl === EDITED_BASE_URL,
        });
      }
      if (body.apiKey) {
        if (state.managed && body.baseUrl) state.provider.baseUrl = body.baseUrl;
        if (!state.managed || !state.nextResult || state.nextResult.status === "applied") state.provider.keyConfigured = true;
        recordCall(state, {
          kind: "save-provider-secret",
          method,
          backend: rawBackend,
          key: body.providerKey,
          valueMatchesExpected:
            body.providerKey === "openrouter" && body.apiKey === INPUT_SENTINEL,
        });
      }
      if (body.clearBaseUrl) {
        state.provider.baseUrl = null;
        recordCall(state, {
          kind: "clear-provider-base-url",
          method,
          backend: rawBackend,
          key: body.providerKey,
          valueMatchesExpected:
            body.providerKey === "openrouter" && body.clearBaseUrl === true,
        });
      }
      if (body.clearApiKey) {
        state.provider.keyConfigured = false;
        recordCall(state, {
          kind: "clear-provider-secret",
          method,
          backend: rawBackend,
          key: body.providerKey,
          valueMatchesExpected:
            body.providerKey === "openrouter" && body.clearApiKey === true,
        });
      }
      const result = state.nextResult ?? { status: "applied" };
      if (state.managed && ["applied", "failed", "compensated"].includes(result.status)) noteNativeJournalReceipt(state,
        { version: 1, backendId: rawBackend, providerKey: body.providerKey ?? "openrouter", operationId: body.operationId,
          status: result.status, stage: "commit", terminal: true });
      if (state.managed) state.calls.at(-1).operationId = body.operationId;
      if (state.managed && result.status !== "applied") state.pendingOperations = [{
        operationId: body.operationId, backendId: rawBackend, providerKey: body.providerKey,
        kind: "update-provider", status: result.status, stage: "credential-write", source: null, target: null,
      }];
      if (result.lostAck) { await route.abort("failed"); return; }
      await route.fulfill({ json: {
        ...(result.omitOperation ? {} : { operationId: state.managed ? (result.wrongOperation ? "wrong-operation" : body.operationId) : "fixture-operation" }),
        status: result.status, stage: result.status === "applied" ? "commit" : "credential-write", activation: null,
        ...(result.extraAck ?? {}),
      } });
      return;
    }
    if (url.pathname === "/__api/models/config/reveal") {
      if (method !== "POST") return rejectUnexpected(["POST"]);
      const body = request.postDataJSON();
      recordCall(state, {
        kind: "reveal-provider-secret",
        method,
        backend: rawBackend,
        key: body.providerKey,
        valueMatchesExpected: body.providerKey === "openrouter",
      });
      await route.fulfill({ json: { apiKey: REVEALED_SENTINEL, reason: "env" } });
      return;
    }
    if (url.pathname === "/__api/models/provider-directory") {
      if (method !== "GET") return rejectUnexpected(["GET"]);
      state.directoryReads += 1;
      await route.fulfill({ json: providerDirectory(state) });
      return;
    }
    if (url.pathname === "/__api/models/endpoints/validate") {
      if (method !== "POST") return rejectUnexpected(["POST"]);
      const body = request.postDataJSON();
      recordCall(state, {
        kind: "validate-provider-secret",
        method,
        backend: rawBackend,
        key: body.name,
        valueMatchesExpected:
          body.name === "openrouter" && body.apiKey === INPUT_SENTINEL,
      });
      await route.fulfill({ json: { ok: true, reachable: true, message: "", models: [] } });
      return;
    }
    if (url.pathname === "/__api/models/endpoints") {
      if (method !== "GET") return rejectUnexpected(["GET"]);
      await route.fulfill({
        json: {
          supported: true,
          endpoints: [],
          profiles: [],
          form: backend === "openclaw" ? {
            apiOptions: ["openai-completions", "openai-responses"],
            defaultApi: "openai-completions",
            nameEditable: false,
            firstModelIsDefault: false,
            ...(state.managed ? { singleModelMutations: true, batchModelSelection: false, providerIdEditable: false, nameIsProviderId: true } : {}),
          } : {
            nameEditable: true,
            firstModelIsDefault: true,
          },
        },
      });
      return;
    }
    if (url.pathname === "/__api/models") {
      if (method !== "GET") return rejectUnexpected(["GET"]);
      await route.fulfill({
        json: {
          models: [],
          catalogRevision: backend === "hermes" ? revision("a") : revision("b"),
          unchanged: false,
        },
      });
      return;
    }
    if (url.pathname === "/__api/models/active") {
      if (method !== "GET") return rejectUnexpected(["GET"]);
      await route.fulfill({ json: { byScope: {}, providerByScope: {} } });
      return;
    }
    if (url.pathname === "/__api/models/auth-profiles") {
      if (method === "PUT" && state.backend === "openclaw" && !state.managed) {
        const body = request.postDataJSON();
        recordCall(state, { kind: "save-auth-profile-secret", method, backend: rawBackend, key: body.provider,
          valueMatchesExpected: body.provider === "openrouter" && body.apiKey === INPUT_SENTINEL });
        state.provider.keyConfigured = true;
        await route.fulfill({ json: { ok: true, id: "openrouter:default", activation: null } });
        return;
      }
      if (method !== "GET") return rejectUnexpected(["GET"]);
      await route.fulfill({ json: { supported: false, profiles: [] } });
      return;
    }
    if (url.pathname === "/__api/oauth") {
      if (method !== "GET") return rejectUnexpected(["GET"]);
      await route.fulfill({ json: { providers: [], profiles: [] } });
      return;
    }
    if (url.pathname === "/__api/env") {
      if (method === "GET") {
        await route.fulfill({ json: { vars: state.vars } });
        return;
      }
      const body = request.postDataJSON();
      let activation = null;
      if (method === "PUT") {
        const isAddedTool = !state.vars.some((entry) => entry.key === body.key);
        if (isAddedTool && state.delayNextAdd) {
          state.delayNextAdd = false;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        setEnvState(state, body.key, true);
        const kind = isAddedTool
          ? "add-tool-secret"
          : body.key === "EXA_API_KEY"
            ? "save-tool-secret"
            : body.key === LATE_KEY
              ? "save-late-tool-secret"
              : body.key.endsWith("_BASE_URL")
                ? "save-provider-base-url"
                : "save-provider-secret";
        const expectedValue = isAddedTool
          ? ADDED_VALUE
          : body.key.endsWith("_BASE_URL")
            ? EDITED_BASE_URL
            : INPUT_SENTINEL;
        recordCall(state, {
          kind,
          method,
          backend: rawBackend,
          key: body.key,
          valueMatchesExpected:
            body.value === expectedValue && (!isAddedTool || body.key === ADDED_KEY),
        });
        if (isAddedTool) activation = { kind: "gateway_restart", available: false };
      } else if (method === "DELETE") {
        setEnvState(state, body.key, false);
        const kind = body.key === "EXA_API_KEY" ? "clear-tool-secret" : "clear-provider-secret";
        recordCall(state, {
          kind,
          method,
          backend: rawBackend,
          key: body.key,
          valueMatchesExpected: Object.keys(body).length === 1,
        });
      } else return rejectUnexpected(["GET", "PUT", "DELETE"]);
      await route.fulfill({ json: { ok: true, activation } });
      return;
    }
    if (url.pathname === "/__api/env/reveal") {
      if (method !== "POST") return rejectUnexpected(["POST"]);
      const body = request.postDataJSON();
      const kind = body.key === "EXA_API_KEY"
        ? "reveal-tool-secret"
        : body.key === LATE_KEY
          ? "reveal-late-tool-secret"
          : body.key.endsWith("_BASE_URL")
            ? "reveal-provider-base-url"
            : "reveal-provider-secret";
      recordCall(state, {
        kind,
        method,
        backend: rawBackend,
        key: body.key,
        valueMatchesExpected: Object.keys(body).length === 1,
      });
      if (body.key === LATE_KEY) {
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      const value = body.key.endsWith("_BASE_URL") ? state.provider.baseUrl : REVEALED_SENTINEL;
      await route.fulfill({ json: { value } });
      return;
    }
    if (url.pathname === "/__api/env/validate") {
      if (method !== "POST") return rejectUnexpected(["POST"]);
      const body = request.postDataJSON();
      recordCall(state, {
        kind: "validate-provider-secret",
        method,
        backend: rawBackend,
        key: body.key,
        valueMatchesExpected:
          body.key === "OPENROUTER_API_KEY" && body.value === INPUT_SENTINEL,
      });
      await route.fulfill({ json: { supported: true, valid: true } });
      return;
    }

    await rejectUnexpected();
  });
}

function noteNativeJournalReceipt(state, value) {
  if (!value || value.terminal !== true || !["applied", "failed", "compensated"].includes(value.status)
    || value.version !== 1 || value.backendId !== state.backend || typeof value.operationId !== "string"
    || typeof value.providerKey !== "string" || Object.keys(value).some(key =>
      !["version", "backendId", "providerKey", "operationId", "status", "stage", "terminal", "code"].includes(key))) return;
  state.nativeJournalReceipts ??= new Map(); state.nativeJournalReceipts.set(value.operationId, structuredClone(value));
}
async function installNativeRecoveryFixture(page, state, mode = "normal") {
  state.nativeRows ??= [];
  state.nativeRevision ??= 0;
  state.nativeJournalReceipts ??= new Map();
  await page.exposeFunction("__nativeModelRecoveryFixture", async (method, value) => {
    recordCall(state, { kind: `native-model-${method}`, method: "IPC", backend: value?.backendId ?? state.backend,
      key: value?.providerKey ?? null, operationId: value?.operationId ?? null, valueMatchesExpected: true });
    const fault = state.nativeFaults?.[method];
    if (state.nativeHold?.method === method) await state.nativeHold.promise;
    if (fault?.before) return { ok: false, error: { code: "MODEL_RECOVERY_STORE_UNAVAILABLE", message: "fixture failure" } };
    if (method === "read") {
      if (fault && Object.hasOwn(fault, "value")) return { ok: true, value: fault.value };
      return { ok: true, value: { version: 1, revision: state.nativeRevision, operations: structuredClone(state.nativeRows) } };
    }
    assert.deepEqual(Object.keys(value).sort(), (method === "retain"
      ? ["version", "backendId", "providerKey", "operationId", "status", ...(value.code ? ["code"] : [])]
      : ["version", "backendId", "providerKey", "operationId"]).sort());
    assert.equal(value.version, 1); assert.doesNotMatch(JSON.stringify(value), /input-sentinel|apiKey|requestDigest|fingerprint|capability|lease|fixture\.test|modelId|ref"/);
    const existing = state.nativeRows.find(row => row.operationId === value.operationId);
    if (existing) assert.equal(existing.backendId === value.backendId && existing.providerKey === value.providerKey, true);
    let result;
    if (method === "retain") {
      const retained = { ...value, ...(existing?.code === "model_recovery_requested" ? { code: "model_recovery_requested" } : {}) };
      if (value.code) assert.equal(value.code, "model_recovery_requested");
      if (JSON.stringify(existing) !== JSON.stringify(retained)) {
        state.nativeRows = state.nativeRows.filter(row => row.operationId !== value.operationId);
        state.nativeRows.push(retained); state.nativeRevision++;
      }
      result = { version: 1, revision: state.nativeRevision, operation: structuredClone(retained) };
    } else {
      let receipt = state.nativeJournalReceipts.get(value.operationId);
      for (const candidate of [state.operationResponse, state.recoverResponse]) if (candidate?.operationId === value.operationId) {
        noteNativeJournalReceipt(state, candidate); receipt = state.nativeJournalReceipts.get(value.operationId);
      }
      if (!receipt || receipt.terminal !== true || receipt.backendId !== value.backendId || receipt.providerKey !== value.providerKey)
        return { ok: false, error: { code: "MODEL_RECOVERY_STORE_UNAVAILABLE", message: "original journal not terminal" } };
      if (existing) { state.nativeRows = state.nativeRows.filter(row => row.operationId !== value.operationId); state.nativeRevision++; }
      result = { version: 1, revision: state.nativeRevision, backendId: value.backendId, providerKey: value.providerKey,
        operationId: value.operationId, status: "acknowledged", outcome: receipt.status };
    }
    if (fault?.after) return { ok: false, error: { code: "MODEL_RECOVERY_CALLER_RETIRED", message: "fixture ACK lost" } };
    recordCall(state, { kind: `native-model-${method}-confirmed`, method: "IPC", backend: value.backendId,
      key: value.providerKey, operationId: value.operationId, valueMatchesExpected: true });
    return { ok: true, value: fault && Object.hasOwn(fault, "value") ? fault.value : result };
  });
  await page.addInitScript((selectedMode) => {
    if (selectedMode === "none") { delete window.openclawDesktop; return; }
    window.openclawDesktop ??= {};
    if (selectedMode === "missing") return;
    window.openclawDesktop.modelOperationRecovery = {
      read: () => window.__nativeModelRecoveryFixture("read"),
      retain: row => window.__nativeModelRecoveryFixture("retain", row),
      ack: identity => window.__nativeModelRecoveryFixture("ack", identity),
    };
    if (selectedMode.startsWith("missing-")) delete window.openclawDesktop.modelOperationRecovery[selectedMode.slice(8)];
  }, mode);
}

async function createHarness(browser, baseUrl, backend, options = {}) {
  const context = await browser.newContext({
    locale: "zh-CN",
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
    ...(options.storageState ? { storageState: options.storageState } : {}),
  });
  await context.addInitScript((selectedBackend) => {
    localStorage.setItem("openclaw.i18n.locale", "zh-CN");
    localStorage.setItem(
      "shoggoth.ui.v1",
      JSON.stringify({ version: 1, values: { "backend.models": selectedBackend } }),
    );
  }, backend);
  const page = await context.newPage();
  page.setDefaultTimeout(7_000);
  const state = options.state ?? createState(backend);
  state.managed = options.managed === true;
  Object.assign(state.provider, options.provider ?? {});
  if (Object.hasOwn(options, "nextResult")) state.nextResult = options.nextResult;
  Object.assign(state, options.stateOverrides ?? {});
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  // Credential reveal is desktop IPC only. Keep the browser fixture isolated
  // with a fake preload bridge; never reopen the retired HTTP secret route.
  await page.exposeFunction("__providerFixtureReveal", (owner, key, modelProvider) => {
    assert.equal(owner, backend);
    const baseUrl = !modelProvider && key.endsWith("_BASE_URL");
    recordCall(state, {
      kind: baseUrl ? "reveal-provider-base-url" : "reveal-provider-secret",
      method: "IPC", backend: owner, key, valueMatchesExpected: true,
    });
    return { ok: true, value: modelProvider
      ? { apiKey: REVEALED_SENTINEL }
      : { value: baseUrl ? state.provider.baseUrl : REVEALED_SENTINEL } };
  });
  await page.addInitScript(() => {
    window.openclawDesktop = {
      revealEnvVar: (owner, key) => window.__providerFixtureReveal(owner, key, false),
      revealModelProviderKey: (owner, key) => window.__providerFixtureReveal(owner, key, true),
    };
  });
  await installNativeRecoveryFixture(page, state, options.nativeMode ?? "normal");
  await installApiFake(page, state);
  await page.goto(`${baseUrl}/#/models`, { waitUntil: "domcontentloaded" });

  if (!options.skipProviderReady) {
  const providerTitle = backend === "hermes" ? "模型 Provider" : "模型 Provider（API Key）";
  await page.getByRole("heading", { name: providerTitle, exact: true }).waitFor();
  await page.locator("span").filter({ hasText: /^OpenRouter$/ }).first().waitFor();
  if (backend === "openclaw") {
    await page.getByText("Auth-only Custom", { exact: true }).waitFor();
    await page.getByText("Manual No URL", { exact: true }).waitFor();
  }
  }
  if (backend === "openclaw" && !options.skipRecoveryReady) await waitFor(async () => page.evaluate(async () => {
    const { getModelOperationRecoverySnapshot } = await import("/src/pages/models/model-operation-recovery.ts");
    return !["unknown", "loading"].includes(getModelOperationRecoverySnapshot("openclaw").journal);
  }), "journal-only initial read resolved");
  const harness = { backend, context, page, pageErrors, state };
  assertHarnessClean(harness);
  return harness;
}

async function withHarnesses(browser, baseUrl, run) {
  const harnesses = [];
  try {
    harnesses.push(await createHarness(browser, baseUrl, "hermes"));
    harnesses.push(await createHarness(browser, baseUrl, "openclaw"));
  } catch (error) {
    await Promise.allSettled(harnesses.map(({ context }) => context.close()));
    throw error;
  }

  let result;
  let runError;
  try {
    result = await run(harnesses);
  } catch (error) {
    runError = error;
  }

  let harnessError;
  try {
    for (const harness of harnesses) assertHarnessClean(harness);
  } catch (error) {
    harnessError = error;
  }
  const closeResults = await Promise.allSettled(
    harnesses.map(({ context }) => context.close()),
  );
  const closeErrors = closeResults
    .filter((entry) => entry.status === "rejected")
    .map((entry) => entry.reason);
  if (harnessError) throw harnessError;
  if (closeErrors.length > 0) throw new AggregateError(closeErrors, "关闭 Playwright context 失败");
  if (runError) throw runError;
  return result;
}

function assertHarnessClean({ backend, pageErrors, state }) {
  assert.deepEqual(pageErrors, [], `${backend} fixture 触发了 React pageerror`);
  assert.deepEqual(
    state.unexpectedRequests,
    [],
    `${backend} fixture 收到未声明的 API 路由或 method`,
  );
}

async function actionButtonOrder(locator) {
  return locator.locator("button:not(.field-input)").evaluateAll((buttons) =>
    buttons.map((button) =>
      button.getAttribute("aria-label") || button.textContent?.trim() || "",
    ),
  );
}

function callCount(state, kind) {
  return state.calls.filter((call) => call.kind === kind).length;
}

function assertSingleCall(state, kind, expected) {
  const matching = state.calls.filter((call) => call.kind === kind);
  assert.deepEqual(matching, [{ kind, ...expected }], `${state.backend}: ${kind} 请求契约`);
}

async function confirmClear(page) {
  const dialog = page.getByRole("alertdialog");
  await dialog.waitFor();
  await dialog.getByRole("button", { name: "清除", exact: true }).click();
}

async function exerciseProviderHarness(harness) {
  const { backend, page, state } = harness;
  const fields = page.locator("[data-provider-fields]").first();
  const slots = fields.locator(":scope > *");
  assert.equal(await slots.count(), 2, `${backend}: Provider 字段必须恰好为 Base URL → API Key`);
  const baseField = slots.nth(0);
  const secretField = slots.nth(1);

  await baseField.locator("button").first().click();
  const baseInput = baseField.locator("input");
  await baseInput.waitFor();
  assert.match(
    (await baseInput.getAttribute("aria-label")) || "",
    /base.?url|_BASE_URL/i,
    `${backend}: Provider 首字段必须是 Base URL`,
  );
  const baseEditButtons = await actionButtonOrder(baseField);
  assert.deepEqual(baseEditButtons, ["保存", "取消"], `${backend}: Base URL 编辑按钮顺序`);
  await baseInput.fill(EDITED_BASE_URL);
  await baseInput.press("Escape");
  await baseInput.waitFor({ state: "hidden" });
  assert.equal(callCount(state, "save-provider-base-url"), 0, `${backend}: Escape 不得保存 Base URL`);

  if (backend === "openclaw") {
    await baseField.locator("button").first().click();
    await baseInput.fill("ftp://invalid.example");
    const invalidSaveDisabled = await baseField.getByRole("button", { name: "保存", exact: true }).isDisabled();
    await baseInput.press("Enter");
    await page.waitForTimeout(100);
    const invalidSaveCalls = callCount(state, "save-provider-base-url");
    assert.deepEqual(
      { invalidSaveDisabled, invalidSaveCalls },
      { invalidSaveDisabled: true, invalidSaveCalls: 0 },
      "openclaw: 非 HTTP(S) Base URL 必须禁用保存且 Enter 不得提交",
    );
    await baseInput.press("Escape");
    await baseInput.waitFor({ state: "hidden" });
  }

  await baseField.locator("button").first().click();
  await baseInput.fill(EDITED_BASE_URL);
  await baseInput.press("Enter");
  await waitFor(() => callCount(state, "save-provider-base-url") === 1, `${backend} Enter 保存 Base URL`);
  assertSingleCall(state, "save-provider-base-url", {
    method: "PUT",
    backend,
    key: backend === "hermes" ? "OPENROUTER_BASE_URL" : "openrouter",
    valueMatchesExpected: true,
  });

  await secretField.locator("button").first().click();
  const secretInput = secretField.locator("input");
  await secretInput.waitFor();
  const secretInputLabel = (await secretInput.getAttribute("aria-label")) || "";
  assert.match(
    secretInputLabel,
    /api.?key|_API_KEY/i,
    `${backend}: Provider 第二字段必须是 API Key`,
  );
  const secretEditButtons = await actionButtonOrder(secretField);
  assert.deepEqual(
    secretEditButtons,
    ["校验", "保存", "取消"],
    `${backend}: API Key 编辑按钮顺序`,
  );
  await secretInput.fill(INPUT_SENTINEL);
  await secretField.getByRole("button", { name: "校验", exact: true }).click();
  await waitFor(
    () => callCount(state, "validate-provider-secret") === 1,
    `${backend} API Key validate`,
  );
  assertSingleCall(state, "validate-provider-secret", {
    method: "POST",
    backend,
    key: backend === "hermes" ? "OPENROUTER_API_KEY" : "openrouter",
    valueMatchesExpected: true,
  });
  await secretInput.press("Escape");
  await secretInput.waitFor({ state: "hidden" });

  const secretReadFieldLabel = await secretField.locator("button.field-input").getAttribute("aria-label");
  assert.ok(
    secretReadFieldLabel?.includes(secretInputLabel),
    `${backend}: API Key 读态编辑入口必须有可识别字段的 aria-label`,
  );
  const secretReadButtons = await actionButtonOrder(secretField);
  assert.deepEqual(
    secretReadButtons,
    ["查看明文", "清除"],
    `${backend}: API Key 读态按钮顺序`,
  );
  await secretField.getByRole("button", { name: "查看明文", exact: true }).click();
  await secretField.getByText(REVEALED_SENTINEL, { exact: true }).waitFor();
  assertSingleCall(state, "reveal-provider-secret", {
    method: "IPC",
    backend,
    key: backend === "hermes" ? "OPENROUTER_API_KEY" : "openrouter",
    valueMatchesExpected: true,
  });
  await secretField.getByRole("button", { name: "隐藏", exact: true }).click();
  await secretField.getByRole("button", { name: "查看明文", exact: true }).waitFor();

  await secretField.locator("button").first().click();
  await secretInput.fill(INPUT_SENTINEL);
  await secretInput.press("Enter");
  await waitFor(() => callCount(state, "save-provider-secret") === 1, `${backend} Enter 保存 API Key`);
  assertSingleCall(state, "save-provider-secret", {
    method: "PUT",
    backend,
    key: backend === "hermes" ? "OPENROUTER_API_KEY" : "openrouter",
    valueMatchesExpected: true,
  });

  await secretField.getByRole("button", { name: "清除", exact: true }).click();
  await confirmClear(page);
  await waitFor(() => callCount(state, "clear-provider-secret") === 1, `${backend} 清除 API Key`);
  assertSingleCall(state, "clear-provider-secret", {
    method: backend === "hermes" ? "DELETE" : "PUT",
    backend,
    key: backend === "hermes" ? "OPENROUTER_API_KEY" : "openrouter",
    valueMatchesExpected: true,
  });
  assertHarnessClean(harness);

  return {
    baseEditButtons,
    secretEditButtons,
    secretReadButtons,
  };
}

async function providerScenario(browser, baseUrl) {
  await withHarnesses(browser, baseUrl, async (harnesses) => {
    const layoutByBackend = {};
    for (const { backend, page } of harnesses) {
      const providerTitle = backend === "hermes" ? "模型 Provider" : "模型 Provider（API Key）";
      const titles = ["Provider 登录（OAuth）", providerTitle, "自定义端点"];
      const cards = [];
      for (const title of titles) {
        const heading = title === "自定义端点"
          ? page.getByText(title, { exact: true })
          : page.getByRole("heading", { name: title, exact: true });
        assert.equal(await heading.count(), 1, `${backend}: 缺少唯一卡片 ${title}`);
        cards.push(await heading.evaluate((element) => {
          const section = element.closest("section");
          if (!section) throw new Error("heading is not inside a section");
          const rect = section.getBoundingClientRect();
          const style = getComputedStyle(section);
          return {
            left: Math.round(rect.left),
            top: Math.round(rect.top),
            width: Math.round(rect.width),
            paddingLeft: style.paddingLeft,
            paddingRight: style.paddingRight,
            borderRadius: style.borderRadius,
          };
        }));
      }
      assert.ok(
        cards.every((card, index) => index === 0 || card.top > cards[index - 1].top),
        `${backend}: 卡片顺序必须是 OAuth → Provider → 自定义端点`,
      );
      assert.equal(new Set(cards.map((card) => card.left)).size, 1, `${backend}: 卡片左边缘未对齐`);
      assert.equal(new Set(cards.map((card) => card.width)).size, 1, `${backend}: 卡片宽度不一致`);
      assert.equal(new Set(cards.map((card) => card.paddingLeft)).size, 1, `${backend}: 卡片左 padding 不一致`);
      assert.equal(new Set(cards.map((card) => card.paddingRight)).size, 1, `${backend}: 卡片右 padding 不一致`);
      assert.equal(new Set(cards.map((card) => card.borderRadius)).size, 1, `${backend}: 卡片圆角不一致`);
      const field = page.locator("[data-provider-fields] .field-input");
      assert.ok(await field.count() >= 2, `${backend}: Provider 字段不足`);
      const fieldHeight = await field.first().evaluate((element) =>
        Math.round(element.getBoundingClientRect().height));
      layoutByBackend[backend] = {
        width: cards[0].width,
        paddingLeft: cards[0].paddingLeft,
        paddingRight: cards[0].paddingRight,
        borderRadius: cards[0].borderRadius,
        fieldHeight,
      };
    }
    assert.deepEqual(
      layoutByBackend.hermes,
      layoutByBackend.openclaw,
      "Hermes/OpenClaw 卡宽、内边距、圆角与字段高度必须一致",
    );

    const markerCounts = Object.fromEntries(
      await Promise.all(
        harnesses.map(async ({ backend, page }) => [
          backend,
          await page.locator("[data-provider-fields]").count(),
        ]),
      ),
    );
    assert.deepEqual(
      markerCounts,
      { hermes: 1, openclaw: 3 },
      "每个可见 Provider 都必须使用 data-provider-fields 共享结构",
    );

    const results = [];
    for (const harness of harnesses) {
      try { results.push(await exerciseProviderHarness(harness)); }
      catch (error) { throw new Error(`${harness.backend}: ${formatError(error)}\nCalls: ${JSON.stringify(harness.state.calls)}`); }
    }
    assert.deepEqual(results[0], results[1], "Provider 两后端的字段及按钮顺序必须一致");
    const fresh = harnesses.find(({ backend }) => backend === "openclaw");
    fresh.state.provider.inConfig = false;
    fresh.state.provider.baseUrl = null;
    fresh.state.provider.keyConfigured = false;
    await fresh.page.reload({ waitUntil: "domcontentloaded" });
    await fresh.page.getByRole("heading", { name: "模型 Provider（API Key）", exact: true }).waitFor();
    const field = fresh.page.locator("[data-provider-fields]").first().locator(":scope > *").nth(0);
    await field.locator("button").first().click();
    const input = field.locator("input");
    await input.fill(EDITED_BASE_URL);
    await input.press("Enter");
    await waitFor(() => callCount(fresh.state, "create-provider-endpoint") === 1,
      "fresh provider saves through explicit create mode");
    assertSingleCall(fresh.state, "create-provider-endpoint", {
      method: "POST", backend: "openclaw", key: "openrouter", valueMatchesExpected: true,
    });
    assert.equal(fresh.state.provider.inConfig, true);
    assert.equal(callCount(fresh.state, "save-provider-base-url"), 1,
      "fresh creation must not issue an extra existing-provider PUT");
    fresh.state.provider.inConfig = false;
    fresh.state.provider.baseUrl = null;
    fresh.state.provider.keyConfigured = false;
    await fresh.page.reload({ waitUntil: "domcontentloaded" });
    const secret = fresh.page.locator("[data-provider-secret]").first();
    await secret.locator("button").first().click();
    await secret.locator("input").fill(INPUT_SENTINEL);
    await secret.locator("input").press("Enter");
    await waitFor(() => callCount(fresh.state, "save-auth-profile-secret") === 1, "legacy first key preserves official auth-profile route");
    assertSingleCall(fresh.state, "save-auth-profile-secret", {
      method: "PUT", backend: "openclaw", key: "openrouter", valueMatchesExpected: true,
    });
    assert.equal(fresh.state.provider.inConfig, false);
    assert.equal(callCount(fresh.state, "create-provider-endpoint"), 1);

  });
}

async function managedProviderScenario(browser, baseUrl) {
  const withManaged = async (options, run) => {
    const harness = await createHarness(browser, baseUrl, "openclaw", { managed: true, ...options });
    try {
      await run(harness);
      assert.deepEqual(harness.pageErrors, []);
      assert.deepEqual(harness.state.unexpectedRequests, []);
      assert.equal(await harness.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    } finally { await harness.context.close(); }
  };
  const firstRow = (page) => page.locator("[data-provider-fields]").first().locator("xpath=..");
  const enterKey = async (page) => {
    const secret = page.locator("[data-provider-secret]").first();
    await secret.locator("button").first().click();
    await secret.locator("input").fill(INPUT_SENTINEL);
    await secret.locator("input").press("Enter");
  };
  await withManaged({ provider: { inConfig: false, baseUrl: null, keyConfigured: false } }, async ({ page, state }) => {
    await enterKey(page);
    await waitFor(() => callCount(state, "create-provider-secret") === 1, "managed first key exact create");
    const call = state.calls.find((item) => item.kind === "create-provider-secret");
    assert.equal(call.valueMatchesExpected, true);
    assert.match(call.operationId, /^provider:[0-9a-f-]{36}$/);
    await waitFor(() => state.provider.inConfig && state.provider.keyConfigured, "managed first key saved");
    await waitFor(async () => await page.locator("[data-managed-provider-operation]").count() === 0, "exact ACK consumed before unlock");
    assert.equal(await page.locator("[data-managed-provider-operation]").count(), 0);
    assert.equal(callCount(state, "save-provider-secret"), 0, "new catalog provider must not issue existing-provider PUT");
    assert.equal(state.modelRequests.length, 1);
    assert.equal(state.modelRequests[0].method, "POST");
    console.log("PASS managed provider first key uses exact catalog create + original operation ID");
  });
  await withManaged({}, async ({ page, state }) => {
    await enterKey(page);
    await waitFor(() => callCount(state, "save-provider-secret") === 1, "managed existing key update");
    const call = state.calls.find((item) => item.kind === "save-provider-secret");
    assert.equal(call.valueMatchesExpected, true);
    assert.match(call.operationId, /^provider:[0-9a-f-]{36}$/);
    assert.equal(callCount(state, "create-provider-secret"), 0);
    console.log("PASS managed existing provider key uses update with original operation ID");
  });
  await withManaged({ provider: { inConfig: false, baseUrl: null, keyConfigured: false, noDefaultEndpoint: true } },
    async ({ page, state }) => {
      const row = firstRow(page);
      await row.getByText("先设置有效端点，才能在受管模型事务中保存密钥。", { exact: true }).waitFor();
      assert.equal(await row.locator("[data-provider-secret] button").first().isDisabled(), true);
      const base = row.locator("[data-provider-fields]").locator(":scope > *").nth(0);
      await base.locator("button").first().click();
      await base.locator("input").fill(EDITED_BASE_URL);
      await base.locator("input").press("Enter");
      await waitFor(() => callCount(state, "create-provider-endpoint") === 1, "managed explicit endpoint creation");
      const call = state.calls.find((item) => item.kind === "create-provider-endpoint");
      assert.equal(call.valueMatchesExpected, true);
      await waitFor(() => row.locator("[data-provider-secret] button").first().isEnabled(), "key editable after exact endpoint create");
      console.log("PASS managed endpoint preparation uses real catalog model and enables subsequent key update");
    });
  for (const provider of [{ noModel: true }, { api: null }]) {
    await withManaged({ provider: { inConfig: false, baseUrl: null, keyConfigured: false, ...provider } },
      async ({ page, state }) => {
        const row = firstRow(page);
        await row.getByText("目录缺少明确的协议或默认模型，请在下方自定义端点中填写端点、协议和真实模型 ID。", { exact: true }).waitFor();
        assert.equal(await row.locator("[data-provider-secret] button").first().isDisabled(), true);
        assert.equal(await row.locator("[data-provider-fields]").locator(":scope > *").nth(0).locator("input").isDisabled(), true);
        assert.equal(callCount(state, "create-provider-secret") + callCount(state, "create-provider-endpoint"), 0);
      });
  }
  console.log("PASS managed missing protocol/model never invents endpoint or model ID");
  for (const keyless of [false, true]) {
    await withManaged({}, async ({ page, state }) => {
      const row = firstRow(page);
      const base = row.locator("[data-provider-fields]").locator(":scope > *").nth(0);
      await base.locator("button").first().click();
      await base.locator("input").fill(EDITED_BASE_URL);
      await base.locator("input").press("Enter");
      const draft = row.locator("[data-managed-endpoint-draft]");
      await draft.waitFor();
      assert.equal(callCount(state, "save-provider-base-url"), 0, "editing an existing endpoint is a local draft before explicit credential intent");
      if (keyless) {
        await draft.getByRole("button", { name: "保存为无密钥端点", exact: true }).click();
        const dialog = page.getByRole("alertdialog");
        await dialog.waitFor();
        await dialog.getByRole("button", { name: "保存为无密钥端点", exact: true }).click();
        await waitFor(() => callCount(state, "clear-provider-secret") === 1, "explicit endpoint + clear intent");
      } else {
        await enterKey(page);
        await waitFor(() => callCount(state, "save-provider-secret") === 1, "endpoint + explicit key intent");
      }
      const mutation = state.calls.filter((item) => item.kind.startsWith("save-provider-") || item.kind === "clear-provider-secret");
      assert.equal(mutation.length, 2, "one request produces endpoint and key/clear summaries");
      assert.equal(state.modelRequests.length, 1, "one HTTP write must carry both endpoint and explicit credential intent");
      assert.equal(state.modelRequests[0].endpoint, true);
      assert.equal(state.modelRequests[0].key, !keyless);
      assert.equal(state.modelRequests[0].clear, keyless);
      assert.match(state.modelRequests[0].operationId, /^provider:[0-9a-f-]{36}$/);
      assert.equal(mutation[0].kind, "save-provider-base-url");
      assert.equal(mutation[0].valueMatchesExpected, true);
      assert.equal(mutation[1].valueMatchesExpected, true);
      await waitFor(async () => await row.locator("[data-managed-provider-operation]").count() === 0, "coupled change exact receipt");
      await waitFor(async () => await row.locator("[data-managed-endpoint-draft]").count() === 0, "coupled endpoint applied readback clears draft");
      assert.equal(state.provider.baseUrl, EDITED_BASE_URL);
      assert.equal(state.provider.keyConfigured, !keyless);
    });
  }
  console.log("PASS managed existing endpoint drafts require explicit new key or confirmed keyless intent in one update");
  for (const nextResult of [{ status: "partial" }, { status: "blocked" },
    { status: "applied", lostAck: true }, { status: "applied", wrongOperation: true },
    { status: "applied", invalidJSON: true }, { status: "applied", omitOperation: true }, { status: "applied", extraAck: { apiKey: "untrusted-secret-sentinel" } }]) {
    await withManaged({ provider: { inConfig: false, baseUrl: null, keyConfigured: false }, nextResult },
      async ({ page, state }) => {
        await enterKey(page);
        await page.locator("[data-managed-provider-operation]").first().waitFor();
        const original = state.calls.find((item) => item.kind === "create-provider-secret").operationId;
        assert.match(await page.locator("[data-managed-provider-operation]").first().innerText(), new RegExp(original));
        assert.equal(await page.getByText("OpenRouter 已保存", { exact: true }).count(), 0);
        await page.reload({ waitUntil: "domcontentloaded" });
        const retained = page.locator("[data-managed-provider-operation]").first();
        await retained.waitFor();
        assert.match(await retained.innerText(), new RegExp(original));
        assert.equal(await firstRow(page).locator("[data-provider-secret] button").first().isDisabled(), true);
        const reads = callCount(state, "observe-managed-provider");
        await retained.getByRole("button", { name: "检查原操作", exact: true }).click();
        await waitFor(() => callCount(state, "observe-managed-provider") === reads + 1, "original operation GET only");
        if (nextResult.status === "applied") {
          await retained.getByText("原操作仍在处理中，结果确认前不会重复提交。", { exact: true }).waitFor();
        }
        assert.equal(callCount(state, "create-provider-secret"), 1, "unconfirmed original never resubmits or mints another operation");
        assert.equal(state.modelRequests.length, 1);
        assert.equal(state.modelRequests[0].operationId, original);
        const storage = await page.evaluate(() => JSON.parse(localStorage.getItem("shoggoth.model-operation-recovery.v1")));
        assert.equal(storage.operations.length, 1);
        assert.doesNotMatch(JSON.stringify(storage), /input-sentinel|apiKey|capability|fixture\.test/);
      });
  }
  console.log("PASS managed partial/blocked/lost/mismatched ACK retains original receipt across reload; observe is GET only");

  const lostAcknowledgement = { provider: { inConfig: false, baseUrl: null, keyConfigured: false },
    nextResult: { status: "applied", lostAck: true } };
  const reloadOriginal = async ({ page, state }) => {
    await enterKey(page);
    await page.locator("[data-managed-provider-operation]").first().waitFor();
    const original = state.modelRequests[0].operationId;
    await page.reload({ waitUntil: "domcontentloaded" });
    const retained = page.locator("[data-managed-provider-operation]").first();
    await retained.waitFor();
    assert.match(await retained.innerText(), new RegExp(original));
    assert.equal(await firstRow(page).locator("[data-provider-secret] button").first().isDisabled(), true);
    return { original, retained };
  };
  const receipt = (original, status, terminal) => ({ version: 1, backendId: "openclaw", operationId: original,
    providerKey: "openrouter", status, stage: terminal ? "commit" : "credential-write", terminal });
  for (const status of ["applied", "failed", "compensated"]) {
    await withManaged(lostAcknowledgement, async (harness) => {
      const { page, state } = harness;
      const { original, retained } = await reloadOriginal(harness);
      state.operationResponse = receipt(original, status, true);
      if (status !== "applied") {
        state.provider.inConfig = false;
        state.provider.baseUrl = null;
        state.provider.keyConfigured = false;
      }
      const reads = state.directoryReads;
      await retained.getByRole("button", { name: "检查原操作", exact: true }).click();
      const terminal = firstRow(page).locator("[data-managed-provider-terminal]");
      await terminal.waitFor();
      assert.match(await terminal.innerText(), new RegExp(original));
      await terminal.getByText(status === "applied" ? "已确认原操作成功。" : status === "failed"
        ? "已确认原操作失败，请检查当前设置。" : "原操作已补偿回退，请检查当前设置。", { exact: true }).waitFor();
      await waitFor(() => state.directoryReads === reads + 1, "observed terminal refreshes current directory");
      assert.equal(await page.locator("[data-managed-provider-operation]").count(), 0);
      assert.equal(await firstRow(page).locator("[data-provider-secret] button").first().isEnabled(), true);
      if (status !== "applied") assert.equal(await page.getByText("OpenRouter 已保存", { exact: true }).count(), 0);
      assert.equal(state.modelRequests.length, 1, "terminal observation never retries the original write");
      assert.equal(state.modelRequests[0].operationId, original);
      const observations = state.calls.filter((item) => item.kind === "observe-managed-provider");
      assert.equal(observations.length, 1);
      assert.equal(observations[0].method, "GET");
      assert.equal(observations[0].operationId, original);
      assert.equal(observations[0].valueMatchesExpected, true);
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("shoggoth.model-operation-recovery.v1")).operations.length), 0);
    });
  }
  console.log("PASS exact original applied/failed/compensated terminal receipt unlocks after reload without a second write");

  await withManaged(lostAcknowledgement, async (harness) => {
    const { page, state } = harness;
    const { original, retained } = await reloadOriginal(harness);
    const reads = state.directoryReads;
    for (const status of ["in_progress", "partial", "blocked", "needs_secret", "cleanup_pending", "not_found"]) {
      state.operationResponse = receipt(original, status, false);
      const observations = callCount(state, "observe-managed-provider");
      await retained.getByRole("button", { name: "检查原操作", exact: true }).click();
      await waitFor(() => callCount(state, "observe-managed-provider") === observations + 1, "nonterminal observation GET");
      await waitFor(async () => await retained.getByRole("button", { name: "检查原操作", exact: true }).isEnabled(), "nonterminal response settled");
      if (status === "not_found") await retained.getByText("原操作仍在处理中，结果确认前不会重复提交。", { exact: true }).waitFor();
      else assert.match(await retained.innerText(), new RegExp(status));
      assert.equal(await firstRow(page).locator("[data-provider-secret] button").first().isDisabled(), true);
      assert.equal(await page.locator("[data-managed-provider-terminal]").count(), 0);
      assert.equal(state.directoryReads, reads, "nonterminal observation is journal-only and does not refresh or recover");
      assert.equal(state.modelRequests.length, 1);
    }
    assert.equal(state.calls.filter((item) => item.kind === "observe-managed-provider")
      .every((item) => item.method === "GET" && item.operationId === original && item.valueMatchesExpected), true);
  });
  console.log("PASS all six nonterminal/not-found receipts remain locked; cleanup_pending never invokes recovery");

  await withManaged(lostAcknowledgement, async (harness) => {
    const { page, state } = harness;
    const { original, retained } = await reloadOriginal(harness);
    const correct = receipt(original, "applied", true);
    const absentTerminal = { ...correct }; delete absentTerminal.terminal;
    const malformed = [
      { ...correct, backendId: "hermes" }, { ...correct, operationId: "wrong-operation" },
      { ...correct, providerKey: "other-provider" }, { ...correct, version: 2 }, absentTerminal,
      { ...correct, status: "unknown" }, { ...correct, status: "cleanup_pending" },
      { ...correct, terminal: false }, { ...correct, apiKey: "untrusted-secret-sentinel" },
      { ...correct, capability: "untrusted-secret-sentinel" }, { ...correct, stage: "invalid stage" },
      { ...correct, code: "invalid code" }, [],
    ];
    for (const response of malformed) {
      state.operationResponse = response;
      const observations = callCount(state, "observe-managed-provider");
      await retained.getByRole("button", { name: "检查原操作", exact: true }).click();
      await waitFor(() => callCount(state, "observe-managed-provider") === observations + 1, "invalid original response GET");
      await waitFor(async () => await retained.getByRole("button", { name: "检查原操作", exact: true }).isEnabled(), "rejected original response settled");
      assert.match(await retained.innerText(), new RegExp(original));
      assert.equal(await firstRow(page).locator("[data-provider-secret] button").first().isDisabled(), true);
      assert.equal(await page.locator("[data-managed-provider-terminal]").count(), 0);
      assert.equal(await page.getByText("OpenRouter 已保存", { exact: true }).count(), 0);
      assert.doesNotMatch(await page.locator("body").innerText(), /untrusted-secret-sentinel|invalid stage|invalid code/);
      assert.equal(state.modelRequests.length, 1);
    }
    state.operationResponse = { ...correct, apiKey: "untrusted-secret-sentinel" };
    const rejected = await page.evaluate(async (operationId) => {
      const { getModelChangeOperation } = await import("/src/api/client.ts");
      try { await getModelChangeOperation("openclaw", operationId, "openrouter"); return { accepted: true }; }
      catch (error) { return { accepted: false, code: error.code, message: error.message, details: error.details }; }
    }, original);
    assert.equal(rejected.accepted, false);
    assert.equal(rejected.code, "model_operation_response_invalid");
    assert.equal(rejected.details, undefined);
    assert.doesNotMatch(JSON.stringify(rejected), /untrusted-secret-sentinel/);
    state.operationHttpStatus = 503;
    state.operationResponse = { error: "untrusted-secret-sentinel", details: { apiKey: "untrusted-secret-sentinel" } };
    const unavailable = await page.evaluate(async (operationId) => {
      const { getModelChangeOperation } = await import("/src/api/client.ts");
      try { await getModelChangeOperation("openclaw", operationId, "openrouter"); return { accepted: true }; }
      catch (error) { return { accepted: false, code: error.code, message: error.message, details: error.details }; }
    }, original);
    assert.equal(unavailable.accepted, false);
    assert.equal(unavailable.code, "model_operation_observation_failed");
    assert.equal(unavailable.details, undefined);
    assert.doesNotMatch(JSON.stringify(unavailable), /untrusted-secret-sentinel/);
    assert.equal(state.modelRequests.length, 1);
  });
  console.log("PASS 13 malformed/identity-mismatched/secret-bearing receipts are rejected; client errors expose no untrusted payload");
}

async function managedRecoveryScenario(browser, baseUrl) {
  const STORE = "shoggoth.model-operation-recovery.v1";
  const original = "provider:10000000-0000-4000-8000-000000000001";
  const pending = (status = "cleanup_pending") => ({ operationId: original, backendId: "openclaw",
    providerKey: "openrouter", kind: "create", status, stage: "credential-write", source: null, target: null });
  const receipt = (status = "applied", terminal = true) => ({ version: 1, backendId: "openclaw", operationId: original,
    providerKey: "openrouter", status, stage: terminal ? "commit" : "credential-write", terminal });
  const row = (page) => page.locator("[data-model-recovery-operation]").first();
  const firstSecret = (page) => page.locator("[data-provider-secret] button").first();
  const assertSafeStorage = async (page, count) => {
    const state = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), STORE);
    assert.equal(state.operations.length, count);
    for (const operation of state.operations) assert.equal(Object.keys(operation).every((key) =>
      ["version", "backendId", "providerKey", "operationId", "status", "code"].includes(key)), true);
    assert.doesNotMatch(JSON.stringify(state), /input-sentinel|apiKey|requestDigest|fingerprint|capability|lease|fixture\.test|modelId|ref"/);
    return state;
  };
  const screenshot = async (page, name) => {
    const directory = process.env.SHOGGOTH_MANAGED_RECOVERY_ARTIFACT_DIR;
    if (!directory) return;
    await mkdir(directory, { recursive: true }); await page.screenshot({ path: path.join(directory, `${name}.png`), fullPage: true });
  };
  const withRecovery = async (options, run) => {
    const harness = await createHarness(browser, baseUrl, "openclaw", { managed: true, ...options });
    try { await run(harness); assertHarnessClean(harness);
      if (!harness.page.isClosed()) assert.equal(await harness.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    } finally { await harness.context.close(); }
  };
  // A full new BrowserContext has no module Map/sessionStorage and no window state.
  const previous = await createHarness(browser, baseUrl, "openclaw", { managed: true,
    provider: { inConfig: false, baseUrl: null, keyConfigured: false }, nextResult: { status: "applied", lostAck: true } });
  let persisted, savedState, retainedId;
  try {
    const secret = previous.page.locator("[data-provider-secret]").first();
    await secret.locator("button").first().click(); await secret.locator("input").fill(INPUT_SENTINEL);
    await secret.locator("input").press("Enter"); await row(previous.page).waitFor();
    retainedId = previous.state.modelRequests[0].operationId;
    await assertSafeStorage(previous.page, 1); persisted = await previous.context.storageState(); savedState = previous.state;
  } finally { await previous.context.close(); }
  savedState.readFailures = ["/__api/models", "/__api/models/config", "/__api/models/config/capabilities", "/__api/models/provider-directory"];
  await withRecovery({ state: savedState, storageState: persisted, skipProviderReady: true }, async ({ page, state }) => {
    await row(page).waitFor(); assert.match(await row(page).innerText(), new RegExp(retainedId));
    assert.equal(await page.locator("[data-provider-fields]").count(), 0);
    await screenshot(page, "new-context-catalog-unavailable");
    assert.equal(await row(page).getByRole("button", { name: "恢复原操作", exact: true }).count(), 0);
    const observations = callCount(state, "observe-managed-provider");
    await row(page).getByRole("button", { name: "检查原操作", exact: true }).click();
    await waitFor(() => callCount(state, "observe-managed-provider") === observations + 1, "new context exact journal GET");
    await row(page).getByText("原操作仍在处理中，结果确认前不会重复提交。", { exact: true }).waitFor();
    assert.equal(state.modelRequests.length, 1); assert.equal(callCount(state, "recover-original-model"), 0);
    state.operationResponse = { ...receipt(), operationId: retainedId };
    await row(page).getByRole("button", { name: "检查原操作", exact: true }).click();
    await page.locator("[data-model-recovery-terminal]").getByText("已确认原操作成功。", { exact: true }).waitFor();
    await assertSafeStorage(page, 0); assert.equal(state.modelRequests.length, 1);
  });
  console.log("PASS new BrowserContext restores only safe original IDs; config/catalog/directory failure cannot hide journal observation");

  await withRecovery({ stateOverrides: { pendingOperations: [pending()] } }, async ({ page, state }) => {
    await row(page).waitFor(); assert.match(await row(page).innerText(), new RegExp(original));
    assert.equal(await firstSecret(page).isDisabled(), true); await assertSafeStorage(page, 1);
    assert.equal(callCount(state, "recover-original-model"), 0, "no automatic recovery POST on hydration");
    await screenshot(page, "server-pending-original");
    state.recoverResponse = receipt();
    await row(page).getByRole("button", { name: "恢复原操作", exact: true }).click();
    await page.locator("[data-model-recovery-terminal]").getByText("已确认原操作成功。", { exact: true }).waitFor();
    await screenshot(page, "explicit-original-recovery-terminal");
    const recovery = state.calls.filter((item) => item.kind === "recover-original-model");
    assert.equal(recovery.length, 1); assert.equal(recovery[0].operationId, original); assert.equal(recovery[0].valueMatchesExpected, true);
    assert.equal(await firstSecret(page).isEnabled(), true); await assertSafeStorage(page, 0);
    assert.equal(state.modelRequests.length, 0, "recovery has no model write specification or credential");
  });
  console.log("PASS server-only pending ID hydrates fresh window; explicit recovery uses original three queries + empty body only");

  await withRecovery({ stateOverrides: { pendingOperations: [pending("needs_secret")] } }, async ({ page, state }) => {
    await row(page).waitFor(); assert.equal(await row(page).getByRole("button", { name: "恢复原操作", exact: true }).count(), 0);
    assert.equal(await firstSecret(page).isDisabled(), true); assert.equal(callCount(state, "recover-original-model"), 0);
  });
  console.log("PASS needs_secret never offers credentialless recovery or a new provider write");

  for (const response of [{ kind: "partial", body: receipt("cleanup_pending", false) },
    { kind: "wrong-id", body: { ...receipt(), operationId: "foreign-operation" } },
    { kind: "secret", body: { ...receipt(), apiKey: "untrusted-secret-sentinel" } },
    { kind: "lost", body: null }]) {
    await withRecovery({ stateOverrides: { pendingOperations: [pending()], recoverResponse: response.body,
      recoverLostAck: response.kind === "lost" } }, async ({ page, state }) => {
      await row(page).waitFor(); await row(page).getByRole("button", { name: "恢复原操作", exact: true }).click();
      await waitFor(() => callCount(state, "recover-original-model") === 1, "explicit original recovery dispatched once");
      await waitFor(async () => await row(page).getByRole("button", { name: "检查原操作", exact: true }).isEnabled(), "recovery uncertain response settled");
      assert.equal(await firstSecret(page).isDisabled(), true); const metadata = await assertSafeStorage(page, 1);
      assert.equal(metadata.operations[0].code, "model_recovery_requested");
      if (response.kind === "wrong-id") await screenshot(page, "recovery-ack-unconfirmed");
      assert.doesNotMatch(await page.locator("body").innerText(), /untrusted-secret-sentinel/);
      await page.reload({ waitUntil: "domcontentloaded" }); await row(page).waitFor();
      assert.equal(await row(page).getByRole("button", { name: "恢复原操作", exact: true }).count(), 0, "reload cannot restore a consumed recovery dispatch");
      state.operationResponse = receipt("cleanup_pending", false);
      await row(page).getByRole("button", { name: "检查原操作", exact: true }).click();
      await waitFor(async () => await row(page).getByRole("button", { name: "检查原操作", exact: true }).isEnabled(), "readonly pending response settled");
      assert.equal((await assertSafeStorage(page, 1)).operations[0].code, "model_recovery_requested");
      assert.equal(callCount(state, "recover-original-model"), 1); assert.equal(state.modelRequests.length, 0);
      state.operationResponse = receipt("compensated", true);
      await row(page).getByRole("button", { name: "检查原操作", exact: true }).click();
      await page.locator("[data-model-recovery-terminal]").getByText("原操作已补偿回退，请检查当前设置。", { exact: true }).waitFor();
      await assertSafeStorage(page, 0); assert.equal(callCount(state, "recover-original-model"), 1);
    });
  }
  console.log("PASS four uncertain recovery responses consume local dispatch intent across reload; subsequent confirmation is GET only");

  const validSummary = { version: 1, backendId: "openclaw", operations: [] };
  const invalidSummaries = [
    { ...validSummary, backendId: "hermes" }, { ...validSummary, apiKey: "untrusted-secret-sentinel" },
    { ...validSummary, operations: null }, { ...validSummary, operations: [{ ...pending(), apiKey: "untrusted-secret-sentinel" }] },
    { ...validSummary, operations: Array.from({ length: 513 }, (_, n) => ({ operationId: `pending:${n}`, providerKey: "openrouter", status: "partial", stage: "commit" })) },
    { ...validSummary, operations: [0, 1].map(() => ({ operationId: original, providerKey: "openrouter", status: "partial", stage: "commit" })) },
    { ...validSummary, operations: [{ operationId: original, providerKey: "openrouter", status: "applied", stage: "commit" }] },
  ];
  for (const summary of [null, ...invalidSummaries]) {
    await withRecovery({ stateOverrides: { pendingIdentityResponse: summary,
      pendingIdentityHttpStatus: summary === null ? 503 : 200 } }, async ({ page, state }) => {
      await page.locator("[data-model-recovery-unknown]").waitFor();
      assert.equal(await firstSecret(page).isDisabled(), true);
      assert.equal(await page.getByRole("button", { name: "新增模型", exact: true }).isDisabled(), true);
      assert.doesNotMatch(await page.locator("body").innerText(), /untrusted-secret-sentinel/);
      const reads = state.pendingIdentityReads; state.pendingIdentityResponse = null; state.pendingIdentityHttpStatus = 200;
      await page.getByRole("button", { name: "重新核对操作清单", exact: true }).click();
      await waitFor(() => state.pendingIdentityReads === reads + 1, "retry only pending identity GET");
      await waitFor(async () => await firstSecret(page).isEnabled(), "verified empty list unlocks mutations");
      assert.equal(state.modelRequests.length, 0); assert.equal(callCount(state, "recover-original-model"), 0);
    });
  }
  console.log("PASS failed/foreign/secret-bearing/oversized/duplicate/nonpending journal lists remain unknown and block writes until verified");

  await withRecovery({ stateOverrides: { pendingOperations: [pending()] } }, async ({ page, state }) => {
    await page.getByRole("button", { name: "新增模型", exact: true }).click();
    const modal = page.getByRole("dialog"); await modal.waitFor();
    await modal.getByPlaceholder("openai", { exact: true }).fill("openrouter");
    await modal.getByPlaceholder("https://api.example.com/v1", { exact: true }).fill(BASE_URL);
    await modal.getByPlaceholder("手动输入模型 ID…", { exact: true }).fill("fixture-model");
    await modal.getByRole("button", { name: "添加", exact: true }).click();
    await modal.locator("[data-endpoint-original-operation-lock]").waitFor();
    assert.equal(await modal.getByRole("button", { name: "保存", exact: true }).isDisabled(), true);
    await screenshot(page, "new-modal-original-provider-lock");
    assert.equal(state.modelRequests.length, 0);
    const guarded = await page.evaluate(async () => {
      const { createOpenClawEndpointController } = await import("/src/pages/models/openclaw-endpoint-controller.ts");
      const { createEndpointMutationSession } = await import("/src/pages/models/endpoint-controller.ts");
      const controller = createOpenClawEndpointController("openclaw"); await controller.list();
      try { await controller.save({ id: "openrouter", name: "openrouter", baseUrl: "https://api.example.test/v1", api: "openai-responses", model: "fixture-model" },
        createEndpointMutationSession("openclaw", "create")); return { blocked: false }; }
      catch (error) { return { blocked: error.message === "model_original_operation_pending" }; }
    });
    assert.equal(guarded.blocked, true); assert.equal(state.modelRequests.length, 0);
  });
  console.log("PASS fresh endpoint modal root cannot bypass the original provider operation fence");

  await withRecovery({ nextResult: { status: "applied", lostAck: true } }, async ({ page, state }) => {
    const first = await page.evaluate(async (secret) => {
      const { createOpenClawEndpointController } = await import("/src/pages/models/openclaw-endpoint-controller.ts");
      const { createEndpointMutationSession } = await import("/src/pages/models/endpoint-controller.ts");
      const controller = createOpenClawEndpointController("openclaw"); await controller.list();
      const session = createEndpointMutationSession("openclaw", "create");
      window.__retainedEndpointController = { controller, session };
      const outcome = await controller.save({ id: "openrouter", name: "openrouter", baseUrl: "https://api.example.test/v1",
        api: "openai-responses", model: "fixture-model", apiKey: secret }, session);
      return { operationId: outcome.steps[0].operationId, locked: outcome.recovery?.locked };
    }, INPUT_SENTINEL);
    assert.equal(first.locked, true); assert.equal(state.modelRequests.length, 1);
    state.operationResponse = { ...receipt(), operationId: first.operationId };
    const blocked = await page.evaluate(async (operationId) => {
      const { getModelChangeOperation } = await import("/src/api/client.ts");
      const { confirmModelOperationTerminal } = await import("/src/pages/models/model-operation-recovery.ts");
      const receipt = await getModelChangeOperation("openclaw", operationId, "openrouter");
      if (!await confirmModelOperationTerminal(receipt)) throw new Error("original terminal missing");
      try { await window.__retainedEndpointController.controller.retry(window.__retainedEndpointController.session); return false; }
      catch (error) { return error.message === "model_original_operation_pending"; }
    }, first.operationId);
    assert.equal(blocked, true, "old frozen plan stays non-replayable after external terminal observation");
    assert.equal(state.modelRequests.length, 1); await assertSafeStorage(page, 0);
  });
  console.log("PASS an old managed endpoint step cannot replay after the original terminal GET has cleared its persistent lock");

  const corrupted = { cookies: [], origins: [{ origin: baseUrl, localStorage: [{ name: STORE,
    value: JSON.stringify({ version: 1, operations: [{ version: 1, backendId: "openclaw", providerKey: "openrouter",
      operationId: original, status: "partial", apiKey: "untrusted-secret-sentinel" }] }) }] }] };
  await withRecovery({ storageState: corrupted }, async ({ page, state }) => {
    await page.locator("[data-model-operation-recovery]").getByText("无法可靠保存或读取原操作编号，当前暂停模型修改。", { exact: true }).waitFor();
    assert.equal(await firstSecret(page).isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "新增模型", exact: true }).isDisabled(), true);
    await screenshot(page, "corrupt-recovery-store-locked");
    assert.equal(state.modelRequests.length, 0); assert.equal(callCount(state, "recover-original-model"), 0);
    assert.doesNotMatch(await page.locator("body").innerText(), /untrusted-secret-sentinel/);
  });
  console.log("PASS corrupt persistent identity DTO cannot be treated as empty or enable a new write");

  const actualRequests = [];
  let actualReceipt = { ...receipt(), operationId: "wrong-operation" };
  const receiptServer = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1"); let body = "";
    for await (const chunk of request) { body += chunk; if (body.length > 64) throw new Error("bounded fixture request"); }
    actualRequests.push({ method: request.method, query: Object.fromEntries(url.searchParams), body });
    response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(actualReceipt));
  });
  await new Promise((resolve) => receiptServer.listen(0, "127.0.0.1", resolve));
  try {
    await withRecovery({ stateOverrides: { pendingOperations: [pending()], receiptHttpOrigin: `http://127.0.0.1:${receiptServer.address().port}` } },
      async ({ page, state, context }) => {
        await row(page).waitFor(); await row(page).getByRole("button", { name: "恢复原操作", exact: true }).click();
        await waitFor(() => actualRequests.length === 1, "real local HTTP recovery request");
        await waitFor(async () => await row(page).getByRole("button", { name: "检查原操作", exact: true }).isEnabled(), "real mismatched HTTP receipt rejected");
        assert.equal(await firstSecret(page).isDisabled(), true);
        assert.deepEqual(actualRequests[0], { method: "POST", query: { backend: "openclaw", operationId: original, provider: "openrouter" }, body: "{}" });
        const storageState = await context.storageState(); await context.close();
        const restarted = await createHarness(browser, baseUrl, "openclaw", { managed: true, state, storageState });
        try {
          await row(restarted.page).waitFor(); assert.equal(await row(restarted.page).getByRole("button", { name: "恢复原操作", exact: true }).count(), 0);
          actualReceipt = receipt();
          await row(restarted.page).getByRole("button", { name: "检查原操作", exact: true }).click();
          await restarted.page.locator("[data-model-recovery-terminal]").getByText("已确认原操作成功。", { exact: true }).waitFor();
          assert.deepEqual(actualRequests.map((request) => request.method), ["POST", "GET"]);
          assert.deepEqual(actualRequests[1].query, actualRequests[0].query); assert.equal(actualRequests[1].body, "");
          await assertSafeStorage(restarted.page, 0); assertHarnessClean(restarted);
        } finally { await restarted.context.close(); }
      });
  } finally { await new Promise((resolve, reject) => receiptServer.close((error) => error ? reject(error) : resolve())); }
  console.log("PASS real loopback HTTP rejects a mismatched recovery ACK; new context retains original intent and only GET confirms terminal");
}

async function managedNativeScenario(browser, baseUrl) {
  const STORE = "shoggoth.model-operation-recovery.v1", original = "provider:native-original";
  const nativeRow = (id = original, status = "cleanup_pending", code) => ({ version: 1, backendId: "openclaw",
    providerKey: "openrouter", operationId: id, status, ...(code ? { code } : {}) });
  const pending = () => ({ operationId: original, backendId: "openclaw", providerKey: "openrouter", kind: "create",
    status: "cleanup_pending", stage: "credential-write", source: null, target: null });
  const receipt = (id = original, status = "applied") => ({ version: 1, backendId: "openclaw", providerKey: "openrouter",
    operationId: id, status, stage: "commit", terminal: true });
  const row = page => page.locator("[data-model-recovery-operation]").first();
  const secret = page => page.locator("[data-provider-secret]").first();
  const beginKey = async page => { await secret(page).locator("button").first().click();
    await secret(page).locator("input").fill(INPUT_SENTINEL); await secret(page).locator("input").press("Enter"); };
  const hold = method => { let release; const promise = new Promise(resolve => { release = resolve; }); return { method, promise, release }; };
  const withNative = async (options, action) => {
    const harness = await createHarness(browser, baseUrl, "openclaw", { managed: true, ...options });
    try { await action(harness); assertHarnessClean(harness); }
    finally { await harness.context.close(); }
  };
  const screenshot = async (page, name) => {
    const directory = process.env.SHOGGOTH_MANAGED_RECOVERY_ARTIFACT_DIR;
    if (!directory) return;
    await mkdir(directory, { recursive: true });
    await page.screenshot({ path: path.join(directory, `native-${name}.png`), fullPage: true });
  };
  let count = 0;
  const pass = label => { count++; console.log(`PASS native recovery ${label}`); };

  const readGate = hold("read");
  await withNative({ skipRecoveryReady: true, stateOverrides: { nativeHold: readGate } }, async ({ page, state }) => {
    await waitFor(() => callCount(state, "native-model-read") === 1, "Main read started");
    assert.equal(state.pendingIdentityReads, 0); assert.equal(await secret(page).locator("button").first().isDisabled(), true);
    await screenshot(page, "pending-main-read");
    readGate.release(); await waitFor(async () => await secret(page).locator("button").first().isEnabled(), "Main read before initial ready");
    assert.equal(state.pendingIdentityReads, 1); assert.equal(state.modelRequests.length, 0);
  }); pass("initial readiness awaits Main read; a present but uncalled method grants no write");

  for (const nativeMode of ["missing", "missing-read", "missing-retain", "missing-ack"]) {
    await withNative({ nativeMode }, async ({ page, state }) => {
      assert.equal(await secret(page).locator("button").first().isDisabled(), true);
      assert.equal(await page.getByRole("button", { name: "新增模型", exact: true }).isDisabled(), true);
      assert.equal(state.pendingIdentityReads, 0); assert.equal(state.modelRequests.length, 0);
      assert.equal(callCount(state, "recover-original-model"), 0);
    }); pass(`${nativeMode} native bridge never falls back to localStorage`);
  }
  await withNative({ stateOverrides: { nativeFaults: { read: { before: true } } } }, async ({ page, state }) => {
    assert.equal(await secret(page).locator("button").first().isDisabled(), true); assert.equal(state.pendingIdentityReads, 0);
    assert.equal(state.modelRequests.length, 0); assert.equal(callCount(state, "recover-original-model"), 0);
  }); pass("failed Main read stays unknown and never substitutes localStorage readiness");
  for (const value of [null, { version: 2, revision: 0, operations: [] }, { version: 1, revision: 0, operations: [], apiKey: "untrusted-secret-sentinel" },
    { version: 1, revision: 0, operations: [nativeRow(), { ...nativeRow(), backendId: "hermes" }] },
    { version: 1, revision: 0, operations: [nativeRow(original, "applied")] }]) {
    await withNative({ stateOverrides: { nativeFaults: { read: { value } } } }, async ({ page, state }) => {
      assert.equal(await secret(page).locator("button").first().isDisabled(), true); assert.equal(state.pendingIdentityReads, 0);
      assert.equal(state.modelRequests.length, 0); assert.doesNotMatch(await page.locator("body").innerText(), /untrusted-secret-sentinel/);
      state.nativeFaults = null;
      await page.getByRole("button", { name: "重新核对操作清单", exact: true }).click();
      await waitFor(async () => await secret(page).locator("button").first().isEnabled(), "verified Main retry read");
      assert.equal(state.pendingIdentityReads, 1);
    }); pass("bad/secret/duplicate-crossbackend/nonpending Main read stays locked until verified retry");
  }

  await withNative({}, async ({ page, state }) => {
    assert(callCount(state, "native-model-read") >= 1, "StrictMode may repeat a readonly initial Main read");
    await page.evaluate(() => { delete window.openclawDesktop; });
    await beginKey(page);
    await page.locator("[data-model-operation-recovery]").getByText("无法可靠保存或读取原操作编号，当前暂停模型修改。", { exact: true }).waitFor();
    await row(page).waitFor(); assert.equal(state.modelRequests.length, 0);
    assert.equal(callCount(state, "native-model-retain"), 0);
    assert.equal(await secret(page).locator("button").first().isDisabled(), true);
  }); pass("native presence is sticky after bridge retirement; legacy cache cannot authorize fallback HTTP");

  const retainGate = hold("retain");
  await withNative({ provider: { inConfig: false, baseUrl: null, keyConfigured: false }, stateOverrides: { nativeHold: retainGate } }, async ({ page, state }) => {
    await beginKey(page); await waitFor(() => callCount(state, "native-model-retain") === 1, "native retain dispatched");
    assert.equal(state.modelRequests.length, 0); await row(page).waitFor(); assert.equal(await secret(page).locator("button").first().isDisabled(), true);
    await screenshot(page, "pending-main-retain");
    retainGate.release(); await waitFor(() => state.modelRequests.length === 1, "model HTTP after native retain confirmed");
    await waitFor(() => state.nativeRows.length === 0 && callCount(state, "native-model-ack-confirmed") === 1, "Main ACK before row cleared");
    const before = state.calls.findIndex(call => call.kind === "native-model-retain-confirmed");
    const effect = state.calls.findIndex(call => call.kind === "create-provider-secret"); assert(before >= 0 && effect > before);
  }); pass("provider awaits durable retain and exact Main ACK; pending Promise is never treated as boolean");

  for (const fault of [{ before: true }, { after: true }, { value: { version: 1, revision: 1, operation: nativeRow("wrong-original", "unconfirmed") } }]) {
    await withNative({ provider: { inConfig: false, baseUrl: null, keyConfigured: false }, stateOverrides: { nativeFaults: { retain: fault } } }, async ({ page, state }) => {
      await beginKey(page); await waitFor(() => callCount(state, "native-model-retain") === 1, "unconfirmed retain attempted");
      await page.locator("[data-model-operation-recovery]").getByText("无法可靠保存或读取原操作编号，当前暂停模型修改。", { exact: true }).waitFor();
      assert.equal(state.modelRequests.length, 0); assert.equal(callCount(state, "recover-original-model"), 0); await row(page).waitFor();
      const prior = (await row(page).innerText()).match(/provider:[A-Za-z0-9-]+/)[0];
      if (fault.after) await screenshot(page, "unknown-main-retain");
      await page.reload({ waitUntil: "domcontentloaded" }); await row(page).waitFor();
      assert.match(await row(page).innerText(), new RegExp(prior)); assert.equal(state.modelRequests.length, 0);
    }); pass("failed/lost/wrong identity native retain keeps original ID and dispatches zero HTTP");
  }

  for (const failRetain of [false, true]) {
    const endpointGate = hold("retain");
    await withNative({ provider: { inConfig: false, baseUrl: null, keyConfigured: false }, stateOverrides: {
      nativeHold: endpointGate, ...(failRetain ? { nativeFaults: { retain: { before: true } } } : {}) } }, async ({ page, state }) => {
      await page.evaluate(async () => {
        const { createOpenClawEndpointController } = await import("/src/pages/models/openclaw-endpoint-controller.ts");
        const { createEndpointMutationSession } = await import("/src/pages/models/endpoint-controller.ts");
        const controller = createOpenClawEndpointController("openclaw"); await controller.list();
        window.__nativeEndpointResult = null;
        controller.save({ id: "openrouter", name: "openrouter", baseUrl: "https://api.example.test/v1", api: "openai-responses",
          model: "fixture-model" }, createEndpointMutationSession("openclaw", "create"))
          .then(value => { window.__nativeEndpointResult = value; }, error => { window.__nativeEndpointResult = { failed: error.message }; });
      });
      await waitFor(() => callCount(state, "native-model-retain") === 1, "endpoint await native retention");
      assert.equal(state.modelRequests.length, 0); endpointGate.release();
      await waitFor(async () => await page.evaluate(() => window.__nativeEndpointResult !== null), "endpoint finished native gate");
      assert.equal(state.modelRequests.length, failRetain ? 0 : 1);
      assert.equal(callCount(state, "native-model-ack-confirmed"), failRetain ? 0 : 1);
      if (failRetain) { await row(page).waitFor(); assert.equal(await secret(page).locator("button").first().isDisabled(), true); }
    }); pass("endpoint controller awaits native retain before first effect and fails closed on storage error");
  }

  const ackGate = hold("ack");
  await withNative({ stateOverrides: { nativeHold: ackGate } }, async ({ page, state }) => {
    await beginKey(page); await waitFor(() => callCount(state, "native-model-ack") === 1, "Main ACK started");
    assert.equal(state.modelRequests.length, 1); await row(page).waitFor(); assert.equal(await secret(page).locator("button").first().isDisabled(), true);
    await screenshot(page, "pending-main-ack");
    ackGate.release(); await waitFor(async () => await secret(page).locator("button").first().isEnabled(), "Main ACK then unlock");
    assert.equal(await row(page).count(), 0); assert.equal(state.nativeRows.length, 0);
  }); pass("HTTP terminal response alone cannot clear original ID while Main ACK is pending");

  for (const fault of [{ before: true }, { after: true }, { value: { version: 1, revision: 2, ...nativeRow("wrong-id"), status: "acknowledged", outcome: "applied" } },
    { value: { version: 1, revision: 2, backendId: "hermes", providerKey: "openrouter", operationId: original, status: "acknowledged", outcome: "applied" } }]) {
    await withNative({ stateOverrides: { nativeFaults: { ack: fault } } }, async ({ page, state }) => {
      await beginKey(page); await waitFor(() => callCount(state, "native-model-ack") === 1, "unconfirmed Main ACK");
      await page.locator("[data-model-operation-recovery]").getByText("无法可靠保存或读取原操作编号，当前暂停模型修改。", { exact: true }).waitFor();
      await row(page).waitFor(); assert.equal(await secret(page).locator("button").first().isDisabled(), true);
      const id = state.modelRequests[0].operationId;
      assert.match(await row(page).innerText(), new RegExp(id)); state.nativeFaults = null; state.operationResponse = receipt(id);
      await page.getByRole("button", { name: "重新核对操作清单", exact: true }).click();
      await waitFor(async () => await row(page).getByRole("button", { name: "检查原操作", exact: true }).isEnabled(), "native store retry read");
      await row(page).getByRole("button", { name: "检查原操作", exact: true }).click();
      await waitFor(async () => await secret(page).locator("button").first().isEnabled(), "original journal Main ACK rechecked");
      assert.equal(state.modelRequests.length, 1); assert.equal(callCount(state, "recover-original-model"), 0);
    }); pass("failed/lost/foreign native ACK keeps provider locked and only original GET/ACK can release it");
  }

  await withNative({ stateOverrides: { pendingOperations: [pending()] } }, async ({ page, state }) => {
    const markerGate = hold("retain"); state.nativeHold = markerGate;
    const retains = callCount(state, "native-model-retain");
    await row(page).getByRole("button", { name: "恢复原操作", exact: true }).click();
    await waitFor(() => callCount(state, "native-model-retain") === retains + 1, "manual marker retain");
    assert.equal(callCount(state, "recover-original-model"), 0); assert.equal(state.nativeRows[0].code, undefined);
    markerGate.release(); await waitFor(() => callCount(state, "recover-original-model") === 1, "manual POST after native marker");
    await waitFor(async () => await row(page).getByRole("button", { name: "检查原操作", exact: true }).isEnabled(), "pending recovery response");
    assert.equal(state.nativeRows[0].code, "model_recovery_requested");
    await page.reload({ waitUntil: "domcontentloaded" }); await row(page).waitFor();
    assert.equal(await row(page).getByRole("button", { name: "恢复原操作", exact: true }).count(), 0);
    assert.equal(callCount(state, "recover-original-model"), 1);
  }); pass("manual original POST awaits monotonic native marker, and reload never restores its dispatch quota");

  await withNative({ stateOverrides: { pendingOperations: [pending()] } }, async ({ page, state }) => {
    state.nativeFaults = { retain: { after: true } };
    await row(page).getByRole("button", { name: "恢复原操作", exact: true }).click();
    await page.locator("[data-model-operation-recovery]").getByText("无法可靠保存或读取原操作编号，当前暂停模型修改。", { exact: true }).waitFor();
    assert.equal(callCount(state, "recover-original-model"), 0); assert.equal(state.nativeRows[0].code, "model_recovery_requested");
    state.nativeFaults = null; await page.reload({ waitUntil: "domcontentloaded" }); await row(page).waitFor();
    assert.equal(await row(page).getByRole("button", { name: "恢复原操作", exact: true }).count(), 0);
  }); pass("unconfirmed marker retention keeps ID/marker but never dispatches manual POST");

  const cache = { cookies: [], origins: [{ origin: baseUrl, localStorage: [{ name: STORE, value: JSON.stringify({ version: 1,
    operations: [nativeRow(original, "unconfirmed"), { ...nativeRow("cache-only"), providerKey: "other-provider" }] }) }] }] };
  await withNative({ storageState: cache, stateOverrides: { nativeRevision: 2,
    nativeRows: [nativeRow(original, "cleanup_pending", "model_recovery_requested"), { ...nativeRow("hermes-main"), backendId: "hermes" }] } }, async ({ page, state }) => {
    await row(page).waitFor(); assert.equal(state.nativeRows.length, 3);
    assert.equal(state.nativeRows.find(row => row.operationId === original).code, "model_recovery_requested");
    assert.equal(state.nativeRows.find(row => row.operationId === original).status, "cleanup_pending");
    assert.equal(callCount(state, "native-model-retain"), 1, "import only the absent safe ID");
    assert.equal(state.modelRequests.length, 0); assert.equal(callCount(state, "recover-original-model"), 0);

  }); pass("Main/cache union preserves global IDs and markers without stale status overwrite");

  await withNative({ stateOverrides: { nativeRows: [nativeRow()], nativeRevision: 2 } }, async ({ page, state }) => {
    state.nativeFaults = { read: { value: { version: 1, revision: 1, operations: [] } } };
    const rejected = await page.evaluate(async () => {
      const { initializeModelOperationRecoveryStorage } = await import("/src/pages/models/model-operation-recovery.ts");
      try { await initializeModelOperationRecoveryStorage(); return false; } catch { return true; }
    });
    assert.equal(rejected, true); await row(page).waitFor();
    assert.equal(await secret(page).locator("button").first().isDisabled(), true); assert.equal(state.nativeRows[0].operationId, original);
    assert.equal(state.modelRequests.length, 0); assert.equal(callCount(state, "recover-original-model"), 0);
  }); pass("same-renderer decreasing Main revision is unknown without erasing the prior original ID");

  const legacy = await createHarness(browser, baseUrl, "hermes", { nativeMode: "missing" });
  try {
    assert.equal(await secret(legacy.page).locator("button").first().isEnabled(), true);
    await beginKey(legacy.page); await waitFor(() => callCount(legacy.state, "save-provider-secret") === 1, "Hermes legacy write unaffected");
    assert.equal(callCount(legacy.state, "native-model-read"), 0); assert.equal(callCount(legacy.state, "native-model-retain"), 0);
    assertHarnessClean(legacy);
  } finally { await legacy.context.close(); }
  pass("Hermes legacy tab retains its original behavior without an unrelated OpenClaw journal readiness gate");

  const standaloneContext = await browser.newContext({ locale: "zh-CN" }), standalonePage = await standaloneContext.newPage();
  const standaloneState = createState("openclaw"); standaloneState.managed = true;
  try {
    await installNativeRecoveryFixture(standalonePage, standaloneState);
    await installApiFake(standalonePage, standaloneState);
    await standalonePage.route("**/__native_controller_fixture", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><html><body>isolated controller</body></html>" }));
    await standalonePage.goto(`${baseUrl}/__native_controller_fixture`);
    const result = await standalonePage.evaluate(async () => {
      const { createOpenClawEndpointController } = await import("/src/pages/models/openclaw-endpoint-controller.ts");
      const { createEndpointMutationSession } = await import("/src/pages/models/endpoint-controller.ts");
      const controller = createOpenClawEndpointController("openclaw"); await controller.list();
      try { await controller.save({ id: "openrouter", name: "openrouter", baseUrl: "https://api.example.test/v1", api: "openai-responses", model: "fixture-model" },
        createEndpointMutationSession("openclaw", "create")); return false; }
      catch (error) { return error.message === "model_operation_storage_unverified"; }
    });
    assert.equal(result, true); assert.equal(callCount(standaloneState, "native-model-read"), 0);
    assert.equal(callCount(standaloneState, "native-model-retain"), 0); assert.equal(standaloneState.modelRequests.length, 0);
    assert.deepEqual(standaloneState.unexpectedRequests, []);
  } finally { await standaloneContext.close(); }
  pass("standalone managed single-model controller cannot bypass an uncalled initial Main read");

  await withNative({}, async ({ page, state }) => {
    await page.evaluate(key => { const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function(name, value) { if (name === key) throw new Error("cache unavailable"); return original.call(this, name, value); }; }, STORE);
    await beginKey(page); await waitFor(async () => state.modelRequests.length === 1 && await secret(page).locator("button").first().isEnabled(), "durable Main independent of auxiliary cache write");
    assert.equal(callCount(state, "native-model-retain-confirmed"), 1); assert.equal(callCount(state, "native-model-ack-confirmed"), 1);
  }); pass("confirmed Main persistence remains authoritative when auxiliary localStorage writes fail");

  const source = await createHarness(browser, baseUrl, "openclaw", { managed: true, nextResult: { status: "applied", lostAck: true } });
  let originalId, retainedState;
  try { await beginKey(source.page); await row(source.page).waitFor(); originalId = source.state.modelRequests[0].operationId;
    retainedState = source.state; assert.equal(retainedState.nativeRows[0].operationId, originalId); }
  finally { await source.context.close(); }
  const originProxy = http.createServer(async (request, response) => {
    try { const upstream = await fetch(`${baseUrl}${request.url}`); response.writeHead(upstream.status,
      { "content-type": upstream.headers.get("content-type") || "text/plain" }); response.end(Buffer.from(await upstream.arrayBuffer())); }
    catch { response.writeHead(503); response.end("fixture unavailable"); }
  });
  await new Promise(resolve => originProxy.listen(0, "127.0.0.1", resolve));
  try {
    const otherOrigin = `http://127.0.0.1:${originProxy.address().port}`;
    const changed = await createHarness(browser, otherOrigin, "openclaw", { managed: true, state: retainedState });
    try {
      assert.notEqual(otherOrigin, baseUrl); assert.equal(await changed.page.evaluate(key => localStorage.getItem(key) !== null, STORE), true);
      await row(changed.page).waitFor(); assert.match(await row(changed.page).innerText(), new RegExp(originalId));
      await screenshot(changed.page, "new-origin-original");
      assert.equal(callCount(retainedState, "recover-original-model"), 0); assert.equal(retainedState.modelRequests.length, 1);
      retainedState.operationResponse = receipt(originalId);
      await row(changed.page).getByRole("button", { name: "检查原操作", exact: true }).click();
      await waitFor(async () => await secret(changed.page).locator("button").first().isEnabled(), "new origin Main read original GET/ACK");
      assert.equal(retainedState.modelRequests.length, 1); assertHarnessClean(changed);
    } finally { await changed.context.close(); }
  } finally { await new Promise(resolve => originProxy.close(resolve)); }
  pass("fresh context at a different real loopback origin reads original Main ID without old localStorage or POST");
  console.log(`managed native persistence UI regression: PASS (${count} cases; controlled preload + rendered React + loopback origins)`);
}

async function exerciseToolHarness(harness) {
  const { backend, page, state } = harness;
  const row = page.locator("[data-tool-key-row]").filter({ hasText: "EXA_API_KEY" }).first();
  const readButtons = await actionButtonOrder(row);
  assert.deepEqual(
    readButtons,
    ["查看明文", "替换", "清除"],
    `${backend}: 工具密钥读态按钮顺序`,
  );
  const valueDisplay = row.getByText(REDACTED, { exact: true });
  assert.equal(
    await valueDisplay.evaluate((element) => element.closest("button") === null),
    true,
    `${backend}: 工具密钥值必须是只读展示，不能兼作编辑按钮`,
  );

  await row.getByRole("button", { name: "查看明文", exact: true }).click();
  await row.getByText(REVEALED_SENTINEL, { exact: true }).waitFor();
  assertSingleCall(state, "reveal-tool-secret", {
    method: "POST",
    backend,
    key: "EXA_API_KEY",
    valueMatchesExpected: true,
  });
  await row.getByRole("button", { name: "隐藏", exact: true }).click();
  await row.getByRole("button", { name: "查看明文", exact: true }).waitFor();

  await row.getByRole("button", { name: "替换", exact: true }).click();
  const input = row.locator("input");
  await input.waitFor();
  const editButtons = await actionButtonOrder(row);
  assert.deepEqual(
    editButtons,
    backend === "hermes" ? ["保存", "校验", "取消"] : ["保存", "取消"],
    `${backend}: 工具密钥编辑态按钮顺序`,
  );
  await input.fill(INPUT_SENTINEL);
  await input.press("Escape");
  await input.waitFor({ state: "hidden" });
  assert.equal(callCount(state, "save-tool-secret"), 0, `${backend}: Escape 不得保存工具密钥`);

  await row.getByRole("button", { name: "替换", exact: true }).click();
  await input.fill(INPUT_SENTINEL);
  await input.press("Enter");
  await waitFor(() => callCount(state, "save-tool-secret") === 1, `${backend} Enter 保存工具密钥`);
  assertSingleCall(state, "save-tool-secret", {
    method: "PUT",
    backend,
    key: "EXA_API_KEY",
    valueMatchesExpected: true,
  });

  await row.getByRole("button", { name: "清除", exact: true }).click();
  await confirmClear(page);
  await waitFor(() => callCount(state, "clear-tool-secret") === 1, `${backend} 清除工具密钥`);
  assertSingleCall(state, "clear-tool-secret", {
    method: "DELETE",
    backend,
    key: "EXA_API_KEY",
    valueMatchesExpected: true,
  });
  assertHarnessClean(harness);

  return {
    readButtons,
  };
}

async function exerciseDelayedRevealHarness(harness) {
  const { backend, page } = harness;
  const row = page.locator("[data-tool-key-row]").filter({ hasText: LATE_KEY }).first();
  await row.getByRole("button", { name: "查看明文", exact: true }).click();
  await row.getByRole("button", { name: "替换", exact: true }).click();
  const input = row.locator("input");
  await input.fill(INPUT_SENTINEL);
  await input.press("Enter");
  await row.getByText(REDACTED_AFTER_SAVE, { exact: true }).waitFor();
  await page.waitForTimeout(450);
  assert.equal(
    await row.getByText(REVEALED_SENTINEL, { exact: true }).count(),
    0,
    `${backend}: 行身份变化后迟到 reveal 不得重新显示明文`,
  );
}

async function exerciseOpenClawAdd(harness) {
  const { page, state } = harness;
  const card = page.getByRole("heading", { name: "工具密钥", exact: true })
    .locator("xpath=ancestor::section");
  const addButton = card.getByRole("button", { name: "添加变量", exact: true });

  await addButton.click();
  let inputs = card.locator("input");
  await inputs.nth(0).fill("temporary_key");
  await inputs.nth(1).fill("temporary-value");
  await inputs.nth(1).press("Escape");
  await inputs.nth(0).waitFor({ state: "hidden" });

  await addButton.click();
  inputs = card.locator("input");
  await inputs.nth(0).waitFor();
  assert.deepEqual(
    await inputs.evaluateAll((elements) => elements.map((element) => element.value)),
    ["", ""],
    "OpenClaw: Escape 取消新增后必须立即清空 key/value",
  );

  await inputs.nth(0).fill(ADDED_KEY);
  await inputs.nth(1).fill(ADDED_VALUE);
  state.delayNextAdd = true;
  await card.getByRole("button", { name: "保存", exact: true }).click();
  assert.equal(
    await card.getByRole("button", { name: "取消", exact: true }).isDisabled(),
    true,
    "OpenClaw: 新增请求在途时必须禁用取消，避免迟到响应恢复敏感表单状态",
  );
  await waitFor(() => callCount(state, "add-tool-secret") === 1, "OpenClaw 添加工具密钥");
  assertSingleCall(state, "add-tool-secret", {
    method: "PUT",
    backend: "openclaw",
    key: ADDED_KEY,
    valueMatchesExpected: true,
  });
  await page.locator("[data-tool-key-row]").filter({ hasText: ADDED_KEY }).waitFor();
  await page.getByText("改动已保存到配置。重启网关后新模型才会出现在聊天可用列表。", {
    exact: true,
  }).waitFor();
}

async function toolKeysScenario(browser, baseUrl) {
  await withHarnesses(browser, baseUrl, async (harnesses) => {
    const markerCounts = Object.fromEntries(
      await Promise.all(
        harnesses.map(async ({ backend, page }) => [
          backend,
          await page.locator("[data-tool-key-row]").filter({ hasText: "EXA_API_KEY" }).count(),
        ]),
      ),
    );
    assert.deepEqual(
      markerCounts,
      { hermes: 0, openclaw: 0 },
      "工具密钥隐藏时两后端都不得渲染 data-tool-key-row",
    );
    for (const { backend, page, state } of harnesses) {
      assert.equal(
        await page.getByRole("heading", { name: "工具密钥", exact: true }).count(),
        0,
        `${backend}: 工具密钥卡片必须保持可逆隐藏`,
      );
      assert.equal(
        state.calls.some(({ kind }) => kind.includes("tool-secret")),
        false,
        `${backend}: 隐藏工具密钥不得触发读取或写入`,
      );
    }
  });
}

const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const server = spawn(
  process.execPath,
  [viteBin, "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
  { cwd: uiRoot, stdio: ["ignore", "pipe", "pipe"] },
);
let serverLog = "";
server.stdout.on("data", (chunk) => {
  serverLog += chunk;
});
server.stderr.on("data", (chunk) => {
  serverLog += chunk;
});

let browser;
let serverStoppedByHarness = false;
const failures = [];
try {
  await waitFor(async () => {
    if (server.exitCode !== null) throw new Error(`Vite 提前退出 (${server.exitCode})`);
    try {
      return (await fetch(baseUrl)).ok;
    } catch {
      return false;
    }
  }, "Vite 服务启动", 10_000);
  browser = await chromium.launch({ channel: "chrome" });

  if (runProvider) {
    try {
      await providerScenario(browser, baseUrl);
    } catch (error) {
      failures.push(`provider: ${formatError(error)}`);
    }
  }
  if (runManagedProvider) {
    try { await managedProviderScenario(browser, baseUrl); }
    catch (error) { failures.push(`managed-provider: ${formatError(error)}`); }
  }
  if (runManagedRecovery) {
    try { await managedRecoveryScenario(browser, baseUrl); }
    catch (error) { failures.push(`managed-recovery: ${formatError(error)}`); }
  }
  if (runManagedNative) {
    try { await managedNativeScenario(browser, baseUrl); }
    catch (error) { failures.push(`managed-native: ${formatError(error)}`); }
  }
  if (runToolKeys) {
    try {
      await toolKeysScenario(browser, baseUrl);
    } catch (error) {
      failures.push(`tool-keys: ${formatError(error)}`);
    }
  }
} catch (error) {
  failures.push(`runtime: ${formatError(error)}`);
} finally {
  let browserCloseError;
  try {
    if (browser) await browser.close();
  } catch (error) {
    browserCloseError = error;
  } finally {
    try {
      serverStoppedByHarness = !processExited(server);
      await stopProcess(server);
    } catch (error) {
      failures.push(`vite cleanup: ${formatError(error)}`);
    }
  }
  if (browserCloseError) failures.push(`browser cleanup: ${formatError(browserCloseError)}`);
}

if (!serverStoppedByHarness && server.exitCode && server.exitCode !== 0) {
  failures.push(`Vite exited with ${server.exitCode}${serverLog ? `\n${serverLog}` : ""}`);
}
if (failures.length > 0) {
  console.error(`models provider parity regression: FAIL (${failures.length})`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  const scenarios = [runProvider && "provider", runManagedProvider && "managed-provider", runManagedRecovery && "managed-recovery", runManagedNative && "managed-native", runToolKeys && "tool-keys"].filter(Boolean);
  console.log(`models provider parity regression: PASS (${scenarios.join(", ")})`);
}
