#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const uiRoot = path.join(root, "app/manage-ui");
const viteBin = path.join(uiRoot, "node_modules/vite/bin/vite.js");
const flags = new Set(process.argv.slice(2));
const known = new Set(["--state", "--controller"]);
for (const flag of flags) {
  if (!known.has(flag)) throw new Error(`unknown option: ${flag}`);
}
const runState = flags.size === 0 || flags.has("--state");
const runController = flags.size === 0 || flags.has("--controller");

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

function chromium() {
  const require = createRequire(import.meta.url);
  for (const candidate of [
    path.join(root, "node_modules/playwright"),
    path.join(uiRoot, "node_modules/playwright"),
    path.join(os.homedir(), "node_modules/playwright"),
    path.join(os.homedir(), ".openclaw/workspace/node_modules/playwright"),
  ]) {
    try {
      return require(candidate).chromium;
    } catch (error) {
      if (error?.code !== "MODULE_NOT_FOUND") throw error;
    }
  }
  throw new Error("找不到 Playwright");
}

function launchOptions() {
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ].filter(Boolean);
  const executablePath = candidates.find((candidate) => existsSync(candidate));
  return executablePath ? { headless: true, executablePath } : { headless: true };
}

async function waitForVite(url, child, stderr) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Vite 提前退出: ${stderr.join("")}`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // 尚未监听。
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Vite 启动超时: ${stderr.join("")}`);
}

async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 1_500);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const stderr = [];
const vite = spawn(process.execPath, [viteBin, "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
  cwd: uiRoot,
  stdio: ["ignore", "ignore", "pipe"],
});
vite.stderr.on("data", (chunk) => stderr.push(String(chunk)));

let browser;
try {
  await waitForVite(baseUrl, vite, stderr);
  browser = await chromium().launch(launchOptions());
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });

  if (runState) {
    const state = await page.evaluate(async () => {
      const module = await import("/src/pages/models/endpoint-mutation-state.ts");
      let value = module.createEndpointMutationState("root-1", "openclaw", "create");
      value = module.reduceEndpointMutationState(value, {
        type: "request_started",
        operationId: "root-1:provider",
      });
      value = module.reduceEndpointMutationState(value, {
        type: "phase_result",
        step: {
          operationId: "root-1:provider",
          status: "applied",
          stage: "commit",
        },
      });
      value = module.reduceEndpointMutationState(value, {
        type: "activation_emitted",
        kind: "gateway_restart",
      });
      return {
        value,
        complete: module.isEndpointStepApplied(value, "root-1:provider"),
      };
    });
    assert.equal(state.complete, true);
    assert.equal(state.value.requestsStarted, 1);
    assert.deepEqual(state.value.emittedActivationKinds, ["gateway_restart"]);
    assert.doesNotMatch(JSON.stringify(state), /apiKey|secret|credential/i);
    console.log("openclaw endpoint mutation state regression: PASS");
  }

  if (runController) {
    const result = await page.evaluate(async () => {
      const controllerModule = await import("/src/pages/models/openclaw-endpoint-controller.ts");
      const shared = await import("/src/pages/models/endpoint-controller.ts");
      const calls = [];
      const endpoint = (models, extra = {}) => ({
        id: "fixture",
        name: "fixture",
        baseUrl: "https://fixture.test/v1",
        model: models[0] ?? "",
        models,
        api: "openai-completions",
        hasApiKey: true,
        canRevealApiKey: true,
        canClearApiKey: true,
        discoverModels: false,
        ...extra,
      });
      let snapshots = [];
      let deleteMode = "normal";
      let modelDeleteMode = "normal";
      let providerMode = "normal";
      let providerUpdateMode = "normal";
      const activations = [];
      const deps = {
        listCustomEndpoints: async () => {
          calls.push(["list"]);
          const next = snapshots.shift();
          if (next instanceof Error) throw next;
          return next ?? {
            supported: true,
            endpoints: [],
            form: {
              apiOptions: ["openai-completions", "openai-responses"],
              defaultApi: "openai-completions",
              nameEditable: false,
              firstModelIsDefault: false,
            },
          };
        },
        validateCustomEndpoint: async () => ({
          ok: true,
          reachable: true,
          message: "",
          models: ["one"],
        }),
        addModelConfig: async (_backend, spec, operationId) => {
          calls.push(["add", operationId, {
            providerKey: spec.providerKey,
            baseUrl: spec.baseUrl,
            modelId: spec.model?.id,
            secretSubmitted: Boolean(spec.apiKey),
          }]);
          if (providerMode === "needs-secret" && !spec.apiKey) {
            return { operationId, status: "needs_secret", stage: "commit", code: "needs_secret" };
          }
          return {
            operationId,
            status: "applied",
            stage: "commit",
            activation: { kind: "gateway_restart", available: true },
          };
        },
        updateModelProvider: async (_backend, id, patch, operationId) => {
          calls.push(["provider", operationId, id, {
            ...(patch.baseUrl !== undefined ? { baseUrl: patch.baseUrl } : {}),
            ...(patch.api !== undefined ? { api: patch.api } : {}),
            ...(patch.clearApiKey !== undefined ? { clearApiKey: patch.clearApiKey } : {}),
            ...(patch.apiKey !== undefined ? { secretSubmitted: true } : {}),
          }]);
          if (providerUpdateMode === "needs-secret" && patch.apiKey) {
            return { operationId, status: "needs_secret", stage: "commit", code: "needs_secret" };
          }
          return { operationId, status: "applied", stage: "commit" };
        },
        applyModelBatch: async (_backend, items, operationId) => {
          calls.push(["batch", operationId, items]);
          return { operationId, status: "applied", stage: "commit" };
        },
        removeModelConfig: async (_backend, id, model, operationId, force) => {
          calls.push(["delete-model", operationId, id, model, force]);
          if (modelDeleteMode === "references-force-lost" && force) {
            modelDeleteMode = "normal";
            throw { code: "response_lost", stage: "request" };
          }
          if (["references", "references-force-lost", "references-hard"].includes(modelDeleteMode) && !force) {
            throw {
              status: 409,
              code: "references_exist",
              stage: "preflight",
              canForce: modelDeleteMode !== "references-hard",
              safeBlockers: [{ code: "references_exist" }, { code: "runtime_apply_unsupported" }],
              safeReferences: [{ store: "config", referenceKey: "agents.defaults.model.fallbacks[7]" }],
            };
          }
          if (modelDeleteMode === "hard-preflight") {
            throw {
              status: 409,
              code: "policy_denied",
              stage: "preflight",
              safeBlockers: [{ code: "policy_denied" }],
            };
          }
          return { operationId, status: "applied", stage: "commit" };
        },
        removeModelProvider: async (_backend, id, operationId, force) => {
          calls.push(["delete-provider", operationId, id, force]);
          if (deleteMode === "lost-once") {
            deleteMode = "normal";
            throw { code: "response_lost", stage: "request" };
          }
          if (deleteMode === "references-force-lost" && force) {
            deleteMode = "normal";
            throw { code: "response_lost", stage: "request" };
          }
          if (["references", "references-force-lost"].includes(deleteMode) && !force) {
            throw {
              status: 409,
              code: "references_exist",
              stage: "preflight",
              safeBlockers: [{ code: "references_exist" }],
              safeReferences: [{
                store: "agents.json",
                referenceKey: "model.primary",
                agent: "safe-agent",
              }],
            };
          }
          return { operationId, status: "applied", stage: "commit" };
        },
        revealModelProviderKey: async () => ({ apiKey: "sk-revealed" }),
      };

      const controller = controllerModule.createOpenClawEndpointController(
        "openclaw",
        deps,
        (activation) => activations.push(activation.kind),
      );
      await controller.list();
      const createSession = shared.createEndpointMutationSession("openclaw", "create", "create-root");
      snapshots = [
        new Error("lost snapshot response"),
        { supported: true, endpoints: [endpoint(["one", "two", "three"])] },
      ];
      const createInput = {
        id: "fixture",
        name: "Fixture",
        baseUrl: "https://fixture.test/v1",
        api: "openai-completions",
        apiKey: "sk-must-never-leak",
        model: "one",
        models: ["one", "two", "three"],
        discoverModels: false,
      };
      const createFirst = await controller.save(createInput, createSession);
      const writesAfterFirst = calls.filter((call) => ["add", "batch"].includes(call[0])).length;
      const createRetry = await controller.retry(createSession);
      const writesAfterRetry = calls.filter((call) => ["add", "batch"].includes(call[0])).length;

      snapshots = [
        { supported: true, endpoints: [endpoint(["a", "b"])] },
        { supported: true, endpoints: [endpoint(["b", "c"])] },
      ];
      await controller.list();
      const editSession = shared.createEndpointMutationSession("openclaw", "edit", "edit-root");
      const edit = await controller.save({
        id: "fixture",
        name: "fixture",
        baseUrl: "https://fixture.test/v1",
        model: "b",
        models: ["b", "c"],
        discoverModels: false,
      }, editSession);

      snapshots = [
        { supported: true, endpoints: [endpoint(["b", "c"])] },
        { supported: true, endpoints: [endpoint(["b", "c"])] },
      ];
      await controller.list();
      const mismatchSession = shared.createEndpointMutationSession("openclaw", "edit", "mismatch-root");
      const mismatch = await controller.save({
        id: "fixture",
        name: "fixture",
        baseUrl: "https://changed.test/v1",
        api: "openai-responses",
        apiKey: "sk-another-secret",
        model: "b",
        models: ["b", "c"],
        discoverModels: false,
      }, mismatchSession);

      snapshots = [
        { supported: true, endpoints: [endpoint(["b", "c"])] },
        { supported: true, endpoints: [endpoint(["b", "c"])] },
      ];
      await controller.list();
      providerUpdateMode = "needs-secret";
      const replaceKeySession = shared.createEndpointMutationSession(
        "openclaw",
        "edit",
        "replace-key-root",
      );
      const replaceKey = await controller.save({
        id: "fixture",
        name: "fixture",
        baseUrl: "https://fixture.test/v1",
        apiKey: "sk-replace-secret",
        model: "b",
        models: ["b", "c"],
        discoverModels: false,
      }, replaceKeySession);
      providerUpdateMode = "normal";

      snapshots = [{ supported: true, endpoints: [endpoint(["a", "b"])] }];
      await controller.list();
      modelDeleteMode = "references";
      snapshots = [{ supported: true, endpoints: [endpoint(["a", "b"])] }];
      const modelDeleteSession = shared.createEndpointMutationSession("openclaw", "edit", "model-delete-root");
      const modelDeleteFirst = await controller.save({
        id: "fixture",
        name: "fixture",
        baseUrl: "https://fixture.test/v1",
        model: "b",
        models: ["b"],
        discoverModels: false,
      }, modelDeleteSession);
      modelDeleteMode = "normal";
      snapshots = [{ supported: true, endpoints: [endpoint(["b"])] }];
      const modelDeleteForced = await controller.confirmBlockedRemoval(
        modelDeleteSession,
        modelDeleteFirst.recovery.blockedRemoval.operationId,
      );

      const selectionInput = { id: "fixture", name: "fixture", baseUrl: "https://fixture.test/v1", model: "b", models: ["b"], discoverModels: false };
      snapshots = [{ supported: true, endpoints: [endpoint(["a", "b"])] }];
      await controller.list();
      modelDeleteMode = "references-hard";
      snapshots = [{ supported: true, endpoints: [endpoint(["a", "b"])] }];
      const hardReferences = await controller.save(selectionInput,
        shared.createEndpointMutationSession("openclaw", "edit", "hard-refs-root"));

      snapshots = [{ supported: true, endpoints: [endpoint(["a", "b"])] }];
      await controller.list();
      modelDeleteMode = "references-force-lost";
      const lostModelSession = shared.createEndpointMutationSession("openclaw", "edit", "lost-model-root");
      snapshots = [{ supported: true, endpoints: [endpoint(["a", "b"])] }];
      const lostModelBlocked = await controller.save(selectionInput, lostModelSession);
      snapshots = [{ supported: true, endpoints: [endpoint(["a", "b"])] }];
      const lostModelForced = await controller.confirmBlockedRemoval(lostModelSession, lostModelBlocked.recovery.blockedRemoval.operationId);
      snapshots = [{ supported: true, endpoints: [endpoint(["b"])] }];
      const lostModelRetry = await controller.retry(lostModelSession);

      snapshots = [{ supported: true, endpoints: [endpoint(["a", "b"])] }];
      await controller.list();
      snapshots = [{ supported: true, endpoints: [endpoint(["a", "b"])] }];
      const reordered = await controller.save({ ...selectionInput, models: ["b", "a"] },
        shared.createEndpointMutationSession("openclaw", "edit", "reordered-root"));

      snapshots = [{ supported: true, endpoints: [endpoint(["a", "b"])] }];
      await controller.list();
      modelDeleteMode = "hard-preflight";
      snapshots = [new Error("zero-write snapshot unavailable")];
      const unlockedSession = shared.createEndpointMutationSession("openclaw", "edit", "unlock-root");
      const unlockedFirst = await controller.save({
        id: "fixture",
        name: "fixture",
        baseUrl: "https://fixture.test/v1",
        model: "b",
        models: ["b"],
        discoverModels: false,
      }, unlockedSession);
      modelDeleteMode = "normal";
      snapshots = [{ supported: true, endpoints: [endpoint(["a", "b"])] }];
      const unlockedSecond = await controller.save({
        id: "fixture",
        name: "fixture",
        baseUrl: "https://fixture.test/v1",
        model: "a",
        models: ["a", "b"],
        discoverModels: false,
      }, unlockedSession);

      providerMode = "needs-secret";
      snapshots = [
        { supported: true, endpoints: [] },
        { supported: true, endpoints: [] },
        { supported: true, endpoints: [endpoint(["one"], {
          id: "secret-fixture",
          name: "Secret fixture",
          baseUrl: "https://secret.test/v1",
        })] },
      ];
      await controller.list();
      const secretSession = shared.createEndpointMutationSession("openclaw", "create", "secret-root");
      const secretFirst = await controller.save({
        id: "secret-fixture",
        name: "Secret fixture",
        baseUrl: "https://secret.test/v1",
        model: "one",
        models: ["one"],
        discoverModels: false,
      }, secretSession);
      providerMode = "normal";
      const secretRetry = await controller.retry(secretSession, { apiKey: "sk-supplement-only" });
      controller.release(secretSession);

      snapshots = [
        new Error("clear snapshot unavailable"),
        { supported: true, endpoints: [endpoint(["b", "c"], { hasApiKey: false })] },
      ];
      const clearSession = shared.createEndpointMutationSession("openclaw", "clear-key", "clear-root");
      const clearFirst = await controller.clearApiKey(endpoint(["b", "c"]), clearSession);
      const clear = await controller.retry(clearSession);
      const revealed = await controller.revealApiKey(endpoint(["b", "c"]));

      deleteMode = "lost-once";
      snapshots = [new Error("delete snapshot unavailable"), { supported: true, endpoints: [] }];
      const deleteLostSession = shared.createEndpointMutationSession(
        "openclaw",
        "delete",
        "delete-lost-root",
      );
      const deleteLostFirst = await controller.remove(
        endpoint(["b", "c"]),
        deleteLostSession,
        false,
      );
      const deleteLostRetry = await controller.retry(deleteLostSession);

      deleteMode = "references";
      snapshots = [
        { supported: true, endpoints: [endpoint(["b", "c"])] },
        { supported: true, endpoints: [] },
      ];
      const deleteSession = shared.createEndpointMutationSession("openclaw", "delete", "delete-root");
      const deleteFirst = await controller.remove(endpoint(["b", "c"]), deleteSession, false);
      const deleteForced = await controller.remove(endpoint(["b", "c"]), deleteSession, true);

      deleteMode = "references-force-lost";
      snapshots = [
        { supported: true, endpoints: [endpoint(["b", "c"])] },
        new Error("forced delete snapshot unavailable"),
        { supported: true, endpoints: [] },
      ];
      const forceLostSession = shared.createEndpointMutationSession(
        "openclaw",
        "delete",
        "force-lost-root",
      );
      const forceLostBlocked = await controller.remove(
        endpoint(["b", "c"]),
        forceLostSession,
        false,
      );
      const forceLostFirst = await controller.remove(
        endpoint(["b", "c"]),
        forceLostSession,
        true,
      );
      const forceLostRetry = await controller.retry(forceLostSession);

      // The backend may commit before returning partial/failed or losing the
      // response. A public readback must never turn the same child operation
      // from provider-create into provider-update, or attest to the secret.
      const uncertainCreates = [];
      for (const mode of ["lost", "partial", "failed"]) {
        for (const models of [["one"], ["one", "two", "three"]]) {
          let visible = [];
          let attempts = 0;
          const requests = [];
          const identity = new Map();
          let changedIdentity = false;
          const record = (kind, operationId, spec) => {
            const fingerprint = JSON.stringify({ kind, spec });
            if (identity.has(operationId) && identity.get(operationId) !== fingerprint) changedIdentity = true;
            identity.set(operationId, fingerprint);
            requests.push({ kind, operationId, providerMode: spec.providerMode, models: spec.model ? [spec.model.id] : spec.map?.(item => item.model.id), secretSubmitted: Boolean(spec.apiKey) });
          };
          const uncertain = controllerModule.createOpenClawEndpointController("openclaw", {
            ...deps,
            listCustomEndpoints: async () => ({ supported: true, endpoints: visible }),
            addModelConfig: async (_backend, spec, operationId) => {
              record("create", operationId, spec);
              visible = [endpoint(["one"])];
              if (++attempts === 1) {
                if (mode === "lost") throw { code: "response_lost", stage: "request" };
                return { operationId, status: mode, code: "apply_failed", stage: "apply" };
              }
              return { operationId, status: "applied", stage: "commit" };
            },
            updateModelProvider: async (_backend, _id, patch, operationId) => {
              record("update", operationId, patch);
              return { operationId, status: "blocked", code: "operation_reused", stage: "validate" };
            },
            applyModelBatch: async (_backend, items, operationId) => {
              record("batch", operationId, items);
              visible = [endpoint(models)];
              return { operationId, status: "applied", stage: "commit" };
            },
          });
          await uncertain.list();
          const rootId = `uncertain-${mode}-${models.length}`;
          const session = shared.createEndpointMutationSession("openclaw", "create", rootId);
          const first = await uncertain.save({ ...createInput, model: models[0], models }, session);
          const retry = await uncertain.retry(session);
          uncertainCreates.push({ mode, models, first, retry, requests, changedIdentity });
        }
      }

      let batchVisible = [];
      let batchAttempts = 0;
      const uncertainBatchCalls = [];
      const uncertainBatchController = controllerModule.createOpenClawEndpointController("openclaw", {
        ...deps,
        listCustomEndpoints: async () => ({ supported: true, endpoints: batchVisible }),
        addModelConfig: async (_backend, spec, operationId) => {
          uncertainBatchCalls.push(["create", operationId, spec.model.id]);
          batchVisible = [endpoint(["one"])];
          return { operationId, status: "applied", stage: "commit" };
        },
        updateModelProvider: async () => { throw new Error("a create retry must never become update"); },
        applyModelBatch: async (_backend, items, operationId) => {
          uncertainBatchCalls.push(["batch", operationId, items]);
          batchVisible = [endpoint(["one", "two", "three"])];
          if (++batchAttempts === 1) throw { code: "response_lost", stage: "request" };
          return { operationId, status: "applied", stage: "commit" };
        },
      });
      await uncertainBatchController.list();
      const uncertainBatchSession = shared.createEndpointMutationSession("openclaw", "create", "uncertain-batch");
      const uncertainBatchFirst = await uncertainBatchController.save(createInput, uncertainBatchSession);
      const uncertainBatchRetry = await uncertainBatchController.retry(uncertainBatchSession);

      // Freeze the edit baseline as well: applying an earlier step (or mutating
      // a caller's snapshot) cannot change later additions/deletion indices.
      const originalEdit = endpoint(["old-a", "keep", "old-b"]);
      let editVisible = [originalEdit];
      const uncertainEditCalls = [];
      const editAttempts = new Map();
      const editFingerprints = new Map();
      let editChangedIdentity = false;
      const editStep = (kind, operationId, spec) => {
        uncertainEditCalls.push([kind, operationId, spec]);
        const fingerprint = JSON.stringify({ kind, spec });
        if (editFingerprints.has(operationId) && editFingerprints.get(operationId) !== fingerprint) editChangedIdentity = true;
        editFingerprints.set(operationId, fingerprint);
        const count = (editAttempts.get(operationId) ?? 0) + 1;
        editAttempts.set(operationId, count);
        if (count === 1) return { operationId, status: "partial", code: "response_lost", stage: "request" };
        return { operationId, status: "applied", stage: "commit" };
      };
      const editTarget = { ...createInput, baseUrl: "https://changed.test/v1", api: "openai-responses", apiKey: undefined,
        model: "keep", models: ["keep", "new-a", "new-b"] };
      const uncertainEditController = controllerModule.createOpenClawEndpointController("openclaw", {
        ...deps,
        listCustomEndpoints: async () => ({ supported: true, endpoints: editVisible }),
        addModelConfig: async () => { throw new Error("an edit retry must never become create"); },
        updateModelProvider: async (_backend, _id, patch, operationId) => {
          editVisible = [endpoint(originalEdit.models, { baseUrl: editTarget.baseUrl, api: editTarget.api })];
          return editStep("update", operationId, patch);
        },
        applyModelBatch: async (_backend, items, operationId) => {
          editVisible = [endpoint(["old-a", "keep", "old-b", "new-a", "new-b"], { baseUrl: editTarget.baseUrl, api: editTarget.api })];
          return editStep("batch", operationId, items);
        },
        removeModelConfig: async (_backend, _id, model, operationId, force) => {
          editVisible = [endpoint(editVisible[0].models.filter(item => item !== model), { baseUrl: editTarget.baseUrl, api: editTarget.api })];
          return editStep("delete", operationId, { model, force });
        },
      });
      await uncertainEditController.list();
      const uncertainEditSession = shared.createEndpointMutationSession("openclaw", "edit", "uncertain-edit");
      const uncertainEditFirst = await uncertainEditController.save(editTarget, uncertainEditSession);
      // Simulate a refresh/cache consumer mutating the previously returned row.
      originalEdit.baseUrl = editTarget.baseUrl;
      originalEdit.api = editTarget.api;
      originalEdit.models.splice(0, originalEdit.models.length, "keep", "new-a", "new-b");
      const uncertainEditRetries = [];
      for (let index = 0; index < 4; index++) uncertainEditRetries.push(await uncertainEditController.retry(uncertainEditSession));

      const providerRenames = [];
      for (const loseResponse of [false, true]) {
        const source = endpoint(["keep", "remove"], { id: "old", name: "old" });
        let visible = [source];
        let attempts = 0;
        const writes = [];
        const renamed = controllerModule.createOpenClawEndpointController("openclaw", {
          ...deps,
          listCustomEndpoints: async () => ({ supported: true, endpoints: visible, form: { batchModelSelection: true } }),
          addModelConfig: async () => { throw new Error("renaming must never create a separate endpoint"); },
          updateModelProvider: async (_backend, id, patch, operationId) => {
            writes.push({ kind: "rename", id, patch, operationId });
            visible = [endpoint(source.models, { id: "new", name: "new" })];
            return { operationId, status: loseResponse && attempts++ === 0 ? "partial" : "applied", code: "response_lost" };
          },
          applyModelBatch: async (_backend, items, operationId) => {
            writes.push({ kind: "selection", items, operationId });
            visible = [endpoint(["keep", "added"], { id: "new", name: "new" })];
            return { operationId, status: "applied" };
          },
        });
        await renamed.list();
        const session = shared.createEndpointMutationSession("openclaw", "edit", `provider-rename-${loseResponse}`);
        const first = await renamed.save({ ...source, id: "new", name: "new", model: "keep", models: ["keep", "added"] }, session, source);
        const final = loseResponse ? await renamed.retry(session) : first;
        providerRenames.push({ first, final, writes });
      }

      return {
        calls,
        createFirst,
        createRetry,
        activations,
        writesAfterFirst,
        writesAfterRetry,
        edit,
        mismatch,
        replaceKey,
        modelDeleteFirst,
        modelDeleteForced,
        hardReferences, lostModelForced, lostModelRetry, reordered,
        uniqueReferences: shared.endpointOutcomeReferences(modelDeleteFirst),
        unlockedFirst,
        unlockedSecond,
        secretFirst,
        secretRetry,
        clearFirst,
        clear,
        revealed,
        deleteLostFirst,
        deleteLostRetry,
        deleteFirst,
        deleteForced,
        forceLostBlocked,
        forceLostFirst,
        forceLostRetry,
        uncertainCreates,
        uncertainBatchCalls,
        uncertainBatchFirst,
        uncertainBatchRetry,
        uncertainEditCalls,
        uncertainEditFirst,
        uncertainEditRetries,
        editChangedIdentity,
        providerRenames,
      };
    });

    for (const rename of result.providerRenames) {
      assert.equal(rename.final.status, "applied");
      assert.equal(rename.final.sync, "synced");
      const writes = rename.writes.filter(write => write.kind === "rename");
      assert.ok(writes.every(write => write.id === "old" && write.patch.renameTo === "new"));
      assert.equal(new Set(writes.map(write => write.operationId)).size, 1, "retry must reuse the rename operation");
      assert.equal(rename.writes.filter(write => write.kind === "selection").length, 1);
      assert.ok(rename.writes.find(write => write.kind === "selection").items.every(item => item.providerKey === "new"));
    }

    assert.equal(result.createFirst.status, "applied");
    assert.equal(result.createFirst.sync, "pending");
    assert.equal(result.createRetry.status, "applied");
    assert.equal(result.createRetry.sync, "synced");
    assert.equal(result.writesAfterFirst, 2);
    assert.equal(result.writesAfterRetry, 2, "snapshot retry rewrote provider/models");
    assert.deepEqual(
      result.calls.filter((call) => call[0] === "add" && call[1].startsWith("create-root"))
        .map((call) => call[1]),
      ["create-root:provider"],
    );
    assert.deepEqual(
      result.calls.filter((call) => call[0] === "add" && call[1].startsWith("secret-root"))
        .map((call) => call[1]),
      ["secret-root:provider", "secret-root:provider"],
      "needs_secret may retry only the unapplied provider step",
    );
    assert.deepEqual(
      result.calls.filter((call) => call[0] === "batch").map((call) => call[1]),
      ["create-root:add", "edit-root:add"],
    );
    assert.deepEqual(
      result.calls.filter((call) => call[0] === "delete-model" && call[1].startsWith("edit-root"))
        .map((call) => call.slice(1, 4)),
      [["edit-root:delete:0", "fixture", "a"]],
    );
    assert.equal(result.calls.some((call) => call[0] === "provider" && call[1] === "edit-root:provider"), false);
    assert.deepEqual(
      result.activations,
      ["gateway_restart", "gateway_restart"],
      "activation must emit once per root and kind",
    );
    assert.equal(result.createFirst.activation, undefined, "sink delivery must be immediate, not outcome-delayed");
    assert.equal(result.createRetry.activation, undefined, "activation was emitted twice");
    assert.equal(result.edit.sync, "synced");
    assert.equal(result.mismatch.sync, "pending", "URL/API/key mismatch must not be marked synced");
    assert.ok(result.mismatch.snapshot, "snapshot mismatch must still return the fresh snapshot");
    assert.equal(result.replaceKey.status, "needs_secret");
    assert.equal(result.replaceKey.sync, "synced");
    assert.equal(
      result.replaceKey.recovery.locked,
      true,
      "an existing hasApiKey flag cannot prove that the replacement secret was applied",
    );
    assert.equal(result.modelDeleteFirst.status, "blocked");
    assert.equal(result.modelDeleteFirst.recovery.blockedRemoval.modelId, "a");
    assert.equal(result.modelDeleteForced.sync, "synced");
    assert.equal(result.modelDeleteFirst.canForce, true);
    assert.equal(result.uniqueReferences.length, 1, "recovery/step 引用必须去重");
    assert.equal(result.hardReferences.recovery.blockedRemoval, undefined);
    assert.equal(result.hardReferences.recovery.locked, false);
    assert.equal(result.lostModelForced.status, "partial");
    assert.equal(result.lostModelRetry.sync, "synced");
    assert.deepEqual(result.calls.filter(call => call[0] === "delete-model" && call[1].startsWith("lost-model-root"))
      .map(call => [call[1], call[4]]), [
        ["lost-model-root:delete:0", false], ["lost-model-root:delete:0", true], ["lost-model-root:delete:0", true],
      ], "确认后的断线重试必须保留同一子操作授权");
    assert.equal(result.reordered.status, "applied");
    assert.equal(result.reordered.sync, "synced");
    assert.equal(result.calls.some(call => String(call[1]).startsWith("reordered-root")), false, "重选相同模型集合不能写配置");

    assert.equal(result.unlockedFirst.recovery.locked, false, "proven zero-write preflight must unlock");
    assert.equal(result.unlockedSecond.sync, "synced");
    assert.equal(
      result.calls.filter((call) => call[0] === "delete-model" && call[1].startsWith("unlock-root")).length,
      1,
      "unlocked retry must accept the edited baseline instead of replaying the frozen delete",
    );
    assert.deepEqual(
      result.calls.filter((call) => call[0] === "delete-model" && call[1].startsWith("model-delete-root"))
        .map((call) => [call[1], call[4]]),
      [["model-delete-root:delete:0", false], ["model-delete-root:delete:0", true]],
      "forced model removal must reuse the exact child operation id",
    );
    assert.equal(result.secretFirst.status, "needs_secret");
    assert.equal(result.secretFirst.recovery.needsSecret, true);
    assert.equal(result.secretRetry.sync, "synced");
    assert.equal(result.clear.sync, "synced");
    assert.equal(result.clearFirst.sync, "pending");
    assert.deepEqual(
      result.calls.filter((call) => call[0] === "provider" && call[1] === "clear-root:clear-key")
        .map((call) => call[1]),
      ["clear-root:clear-key"],
      "clear retry must reuse the clear session without rewriting",
    );
    assert.equal(result.revealed, "sk-revealed");
    assert.equal(result.deleteLostFirst.sync, "pending");
    assert.equal(result.deleteLostRetry.sync, "synced");
    assert.deepEqual(
      result.calls.filter((call) => call[0] === "delete-provider" && call[1].startsWith("delete-lost-root"))
        .map((call) => call[1]),
      ["delete-lost-root:delete:provider", "delete-lost-root:delete:provider"],
      "lost provider delete must retain the root and child operation ids",
    );
    assert.equal(result.deleteFirst.status, "blocked");
    assert.equal(result.deleteFirst.recovery.references[0].referenceKey, "model.primary");
    assert.equal(result.deleteForced.sync, "synced");
    assert.equal(result.forceLostBlocked.status, "blocked");
    assert.equal(result.forceLostFirst.sync, "pending");
    assert.equal(result.forceLostRetry.sync, "synced");
    assert.deepEqual(
      result.calls.filter((call) => call[0] === "delete-provider" && call[1].startsWith("force-lost-root"))
        .map((call) => [call[1], call[3]]),
      [
        ["force-lost-root:delete:provider", false],
        ["force-lost-root:delete:provider", true],
        ["force-lost-root:delete:provider", true],
      ],
      "lost forced delete must replay force=true with the same child operation id",
    );
    assert.deepEqual(
      result.calls.filter((call) => call[0] === "delete-provider" && call[1].startsWith("delete-root"))
        .map((call) => [call[1], call[3]]),
      [["delete-root:delete:provider", false], ["delete-root:delete:provider", true]],
    );
    for (const sample of result.uncertainCreates) {
      const rootId = `uncertain-${sample.mode}-${sample.models.length}`;
      assert.equal(sample.first.status, sample.mode === "lost" ? "partial" : sample.mode);
      assert.equal(sample.first.recovery.locked, true, "snapshot presence cannot attest to an uncertain provider/secret write");
      assert.ok(sample.first.recovery.baseline, "the current public row remains available for display");
      if (sample.models.length === 1) assert.equal(sample.first.sync, "synced");
      assert.equal(sample.changedIdentity, false, "a child operation id cannot change mutation type or spec");
      assert.deepEqual(sample.requests.slice(0, 2), [0, 1].map(() => ({
        kind: "create", operationId: `${rootId}:provider`, providerMode: "new", models: ["one"], secretSubmitted: true,
      })));
      assert.equal(sample.requests.some(request => request.kind === "update"), false);
      assert.deepEqual(sample.requests.filter(request => request.kind === "batch").map(request => [request.operationId, request.models]),
        sample.models.length > 1 ? [[`${rootId}:add`, ["two", "three"]]] : []);
      assert.equal(sample.retry.status, "applied");
      assert.equal(sample.retry.sync, "synced");
    }
    assert.equal(result.uncertainBatchFirst.status, "partial");
    assert.equal(result.uncertainBatchFirst.sync, "synced");
    assert.equal(result.uncertainBatchRetry.status, "applied");
    assert.equal(result.uncertainBatchRetry.sync, "synced");
    assert.equal(result.uncertainBatchCalls.filter(call => call[0] === "create").length, 1, "an applied provider step is not rewritten");
    const batchRetries = result.uncertainBatchCalls.filter(call => call[0] === "batch");
    assert.equal(batchRetries.length, 2);
    assert.deepEqual(batchRetries[0], batchRetries[1], "uncertain multi-model additions must retain the complete original batch and operation id");
    assert.equal(result.uncertainEditFirst.status, "partial");
    assert.equal(result.editChangedIdentity, false);
    assert.equal(result.uncertainEditRetries.at(-1).status, "applied");
    assert.equal(result.uncertainEditRetries.at(-1).sync, "synced");
    assert.deepEqual(result.uncertainEditCalls.map(call => call.slice(0, 2)), [
      ["update", "uncertain-edit:provider"], ["update", "uncertain-edit:provider"],
      ["batch", "uncertain-edit:add"], ["batch", "uncertain-edit:add"],
      ["delete", "uncertain-edit:delete:0"], ["delete", "uncertain-edit:delete:0"],
      ["delete", "uncertain-edit:delete:1"], ["delete", "uncertain-edit:delete:1"],
    ], "all edit steps retain their original order and identity across partial writes");
    assert.deepEqual(result.uncertainEditCalls.filter(call => call[0] === "delete").map(call => call[2].model),
      ["old-a", "old-a", "old-b", "old-b"], "a refreshed baseline cannot skip or reorder original removals");
    assert.doesNotMatch(JSON.stringify({
      calls: result.calls,
      createFirst: result.createFirst,
      createRetry: result.createRetry,
      edit: result.edit,
      clear: result.clear,
    }), /sk-(?:must-never-leak|another-secret|replace-secret|supplement-only)/);
    assert.deepEqual(pageErrors, []);
    console.log("openclaw endpoint controller regression: PASS");
  }
} finally {
  await browser?.close().catch(() => {});
  await stop(vite);
}
