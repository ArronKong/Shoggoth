#!/usr/bin/env node
"use strict";

// Usage: node scripts/chat-acceptance-recovery-electron.cjs /absolute/path/to/fresh/manage-dist [--group-continuation|--model-selection|--account-model-switch]
// Real production React and Electron, broker, proxy, Backend and Service.
// The Runtime and the transport fault are controlled inside a temporary profile.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const project = path.resolve(__dirname, "..");
const [distInput, ...args] = process.argv.slice(process.versions.electron ? process.argv.indexOf("--fixture") + 1 : 2);
const dist = fs.realpathSync(distInput || "");
assert(fs.statSync(path.join(dist, "index.html")).isFile(), "Pass the freshly built production Manage dist directory");

if (!process.versions.electron) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shoggoth-chat-acceptance-electron-")));
  try {
    const result = spawnSync(require("electron"), [__filename, "--fixture", dist, root, ...args], { env, stdio: "inherit", timeout: 100_000 });
    assert.equal(result.status, 0, String(result.error || result.signal || "Electron fixture failed"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
} else {
  const { app, BrowserWindow, ipcMain } = require("electron");
  const { openHandoffFixture } = require("./fixtures/runtime-handoff-service.cjs");
  const { requestService } = require("../app/agent-service/client");
  const { ShoggothBackend } = require("../app/core/shoggoth-backend");
  const { BackendRegistry } = require("../app/core/backend-registry");
  const { startProxyGateway } = require("../app/core/proxy-gateway");
  const { createWorkAdmissionGate } = require("../app/core/work-admission-gate");
  const { DEFAULT_OPERATOR_SCOPES, generateIdentity } = require("../app/core/device-auth");

  const [root, ...flags] = args;
  assert.ok(root, "The Node launcher must supply a private Electron directory");
  app.setPath("userData", path.join(root, "electron-data"));
  app.setPath("sessionData", path.join(root, "electron-session"));
  app.setName("Shoggoth isolated chat acceptance fixture");
  app.on("window-all-closed", () => {});

  const pendingKey = "shoggoth.chat.pending-native-sends.v1";
  const normalPrompt = "Acceptance fixture waits for preparation";
  const lostPrompt = "Recovery fixture keeps the exact original message";
  const reorderedPrompt = "Reordered frames fixture keeps the original message";
  const stoppedPrompt = "Stop before the accepted message is projected";
  const acceptedFailurePrompt = "Accepted message remains in history when preparation fails";
  const rejectedPrompt = "Rejection fixture restores the exact draft";
  const modelSelectionPrompt = "Send once while saving the model";
  const continuationText = "Exact continuation evidence from saved attachment";
  const continuationFile = { id: "9f90b9a4-3fae-45e9-9abb-333a28821fc3", name: "receipt.txt", mimeType: "text/plain",
    size: Buffer.byteLength(continuationText) };
  const secondContinuationFile = { ...continuationFile, id: "9f90b9a4-3fae-45e9-9abb-333a28821fc4" };
  const lookupNotice = '[data-testid="chat-verification-notice"]';
  const stopNotice = '[data-testid="chat-stop-verification-notice"]';
  const waitingBubble = '.chat-thread [data-live-activity-bubble="waiting"]';
  const sendSelector = mode => `[data-send-entry="${mode === "normal" ? "composerButton" : "immersiveButton"}"]`;

  async function until(check, label, timeoutMs = 12_000) {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      const result = await check();
      if (result) return result;
      await new Promise(resolve => setTimeout(resolve, 35));
    }
    throw new Error(`Timed out waiting for ${label}`);
  }

  function staticServerForDist() {
    // The static server resolves dist relative to itself. Stage just that file
    // and link its normal dependencies to the working source, with a private dist.
    const source = path.join(project, "app"), stage = path.join(root, "asset-server");
    fs.mkdirSync(path.join(stage, "manage-ui"), { recursive: true });
    for (const name of fs.readdirSync(source)) {
      if (!["manage-ui", "static-server.js"].includes(name)) fs.symlinkSync(path.join(source, name), path.join(stage, name));
    }
    fs.copyFileSync(path.join(source, "static-server.js"), path.join(stage, "static-server.js"));
    fs.symlinkSync(dist, path.join(stage, "manage-ui", "dist"));
    return require(path.join(stage, "static-server.js")).startStaticServer;
  }

  async function run() {
    const verifyModelSelection = flags.includes("--model-selection");
    const verifyAccountModelSwitch = flags.includes("--account-model-switch");
    const nextModel = "fixture-model-next";
    const f = await openHandoffFixture({ serviceOptions: { memoryCore: false, durableChatAcceptance: true,
      ...(verifyAccountModelSwitch ? { runtimeSupportDiscover: undefined } : {}) },
      ...(verifyModelSelection || verifyAccountModelSwitch ? { catalogs: { codex: ["fixture-model", nextModel, "other-session-model"], pi: ["fixture-model"],
        "deepseek-harness": ["fixture-model"] } } : {}),
    });
    const { service } = f;
    const registry = new BackendRegistry();
    const gates = new Map(), preparing = new Set(), attempts = [], lookups = [], receipts = new Map(), stops = [];
    let blockedLookup, reorder, heldStopOperation, holdStopProjection = true;
    let proxy, server, win;
    const waitForGate = prompt => new Promise(resolve => gates.set(prompt, resolve));
    const nativeTurns = () => [...f.transport.handles.values()].reduce((total, handle) => total + handle.host.turnStartCalls, 0);
    try {
      if (verifyModelSelection) {
        service.productStore.putAgentProfile({ ...service.productStore.getAgentProfile(f.profile.id), defaultModel: null });
      }
      const session = f.createSession();
      const key = `agent:${f.profile.agentId}:${session.sessionKey}`;
      const otherSession = f.createSession();
      const otherKey = `agent:${f.profile.agentId}:${otherSession.sessionKey}`;
      const appendEvent = service.transcriptStore.appendEvent.bind(service.transcriptStore);
      service.transcriptStore.appendEvent = event => {
        if (holdStopProjection && heldStopOperation && event.content?.operationId === heldStopOperation) {
          throw Object.assign(new Error("Fixture projection unavailable"), { code: "ENOSPC" });
        }
        return appendEvent(event);
      };
      const runtimeConfig = service.nativeRuntimeConfig.read();
      service.nativeRuntimeConfig.apply({ ...runtimeConfig, revision: runtimeConfig.revision + 1,
        flags: { ...runtimeConfig.flags, runtimeAdmissionV1: true } });
      service.contextCompiler.semanticSearch ||= {};
      service.contextCompiler.prepareRelated = async ({ query }) => {
        preparing.add(query);
        if ([normalPrompt, lostPrompt, reorderedPrompt].includes(query)) await waitForGate(query);
      };
      const beforeSessionSend = service.workRunCoordinator.beforeSessionSend;
      service.workRunCoordinator.beforeSessionSend = async input => {
        if (input.prompt === modelSelectionPrompt) await waitForGate(input.prompt);
        if (input.prompt === acceptedFailurePrompt) {
          await waitForGate(input.prompt);
          throw Object.assign(new Error("Fixture preparation denied"), { code: "EXECUTION_CONTRACT_STALE" });
        }
        return beforeSessionSend(input);
      };
      const validateUiAction = service.workRunCoordinator.validateUiAction.bind(service.workRunCoordinator);
      service.workRunCoordinator.validateUiAction = input => {
        if (input.prompt === rejectedPrompt) throw Object.assign(new Error("Fixture admission denied"), { code: "WORK_RUN_SEND_FAILED" });
        return validateUiAction(input);
      };

      const backend = new ShoggothBackend({ paths: f.paths, serviceEventPollMs: 30,
        getLocale: () => "en", requestService: async (paths, request, options) => {
          // Prewarming also reads 64 models. Keep that background read out of the selection probe.
          if (verifyAccountModelSwitch && request.method === "chat.session.prewarm") {
            return { supported: true, state: "unavailable" };
          }
          if (["chat.send.cancel", "chat.abort"].includes(request.method)) stops.push(request);
          if (request.method === "chat.operation.get") {
            lookups.push(request.params.operationId);
            if (request.params.operationId === blockedLookup) throw Object.assign(new Error("Fixture lookup unavailable"), { code: "SERVICE_DISCONNECTED" });
          }
          if (request.method !== "chat.send.accept") return requestService(paths, request, options);
          const { operationId, prompt } = request.params;
          attempts.push({ operationId, prompt });
          if (prompt === stoppedPrompt) heldStopOperation = operationId;
          const response = await requestService(paths, request, options);
          receipts.set(prompt, response);
          if (prompt === lostPrompt) {
            // The real Service has already saved the acceptance. Drop its ACK
            // and briefly withhold exact lookups to exercise browser recovery.
            blockedLookup = operationId;
            throw Object.assign(new Error("Fixture acceptance ACK lost"), { code: "SERVICE_DISCONNECTED" });
          }
          return response;
        } });
      registry.register(backend);
      registry.setChatSecretOwner(backend);
      if (flags.includes("--group-continuation")) registry.setInspirationOwner(backend);
      assert.equal((await registry.start()).get("shoggoth"), true);
      proxy = await startProxyGateway({ port: 0, getUpstreamUrl: () => "", registry, workAdmissionGate: createWorkAdmissionGate() });
      const locale = verifyAccountModelSwitch ? "zh-CN" : "en";
      const config = { locale, effectiveLocale: locale, setupCompletedAt: Date.now(), gatewayUrl: "", token: "", disabledBackends: ["openclaw", "hermes"] };
      const identity = generateIdentity();
      server = await staticServerForDist()(0, { registry, chatUpstreamUrl: proxy.url, chatOrigin: "http://127.0.0.1",
        homeDir: f.root, userDataRoot: path.join(f.root, "desktop-assets"), configStore: { read: () => config },
        authResolver: { resolveConnectAuth: () => ({ ...identity, token: "isolated-chat-acceptance", scopes: DEFAULT_OPERATOR_SCOPES }), storeDeviceToken() {} } });
      ipcMain.on("openclaw:get-config", event => { event.returnValue = config; });
      ipcMain.handle("shoggoth:app-update:get-state", () => null);
      ipcMain.handle("shoggoth:telemetry:get-settings", () => ({ enabled: false, detailed: false }));
      ipcMain.handle("openclaw:notify", () => false);
      win = new BrowserWindow({ show: false, width: 1120, height: 900,
        webPreferences: { preload: path.join(project, "app/preload.js"), sandbox: true, contextIsolation: true,
          nodeIntegration: false, backgroundThrottling: false } });

      const js = code => win.webContents.executeJavaScript(code);
      const state = () => js(`JSON.parse(localStorage.getItem(${JSON.stringify(pendingKey)}) || "[]")`);
      const threadText = () => js("document.body.innerText");
      const notice = () => js(`Array.from(document.querySelectorAll(${JSON.stringify(lookupNotice)})).some(node => node.getClientRects().length)`);
      const stateFor = idem => state().then(entries => entries.find(entry => entry.key === key && entry.idem === idem));
      const chatHash = `#/chat?session=${encodeURIComponent(key)}`;
      const seed = [key, otherKey].map(sessionKey => ({ key: sessionKey, agentId: f.profile.agentId,
        agentName: f.profile.name, backendId: "shoggoth", updatedAt: Date.now(), displayName: "Acceptance fixture", kind: "direct" }));
      await win.loadURL(server.url);
      await js(`localStorage.setItem('shoggoth.chat.sessions.v1',${JSON.stringify(JSON.stringify(seed))});
        localStorage.setItem('shoggoth.chat.lastActive.v1',${JSON.stringify(key)});`);
      async function open(mode, waiting = false) {
        await js(`localStorage.setItem('shoggoth.chat.immersive.v1',${JSON.stringify(mode === "normal" ? "0" : "1")});
          location.hash=${JSON.stringify(chatHash)};`);
        await new Promise(resolve => { win.webContents.once("did-finish-load", resolve); win.webContents.reload(); });
        await until(() => js(`document.querySelector('.chat-thread')?.dataset.historyLoaded === 'true'
          && (!!document.querySelector(${JSON.stringify(sendSelector(mode))})
          || !!document.querySelector(${JSON.stringify(lookupNotice)})
          || !!document.querySelector(${JSON.stringify(stopNotice)})
          || (${waiting} && !!document.querySelector(${JSON.stringify(waitingBubble)})))`), `${mode} chat and current turn state`);
      }
      async function assertContinuationReferenceHidden(selector, text, index = 0) {
        const target = `Array.from(document.querySelectorAll(${JSON.stringify(selector)}))
          .filter(node => node.textContent.trim() === ${JSON.stringify(text)} && node.getClientRects().length)[${index}]`;
        await until(() => js(`!!(${target})`), `reference target ${text}`);
        await js(`(${target}).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 300 }))`);
        const menuItems = "Array.from(document.querySelectorAll('[data-message-menu] [role=menuitem]'))";
        const labels = await js(`${menuItems}.map(button => button.textContent.trim())`);
        assert.ok(labels.includes("Copy"), text);
        assert.ok(labels.includes("Quote"), text);
        assert.equal(labels.includes("Copy continuation reference"), false, text);
        await js("document.querySelector('.chat-ctxmenu__backdrop').click()");
        await until(() => js("!document.querySelector('[data-message-menu]')"), "message menu closes");
      }
      const textarea = mode => mode === "normal" ? "textarea.chat-composer__input" : "[data-chat-composer-dock] textarea";
      async function send(mode, prompt, expectPending = true) {
        await until(() => js(`!!document.querySelector(${JSON.stringify(textarea(mode))})`), `${mode} composer input`);
        await js(`(() => {
          const input = document.querySelector(${JSON.stringify(textarea(mode))});
          input.focus();
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(prompt)});
          input.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);
        const selector = JSON.stringify(sendSelector(mode));
        await until(() => js(`Array.from(document.querySelectorAll(${selector})).some(button => !button.disabled && button.getClientRects().length)`), `${mode} send button enabled`);
        await js(`Array.from(document.querySelectorAll(${selector})).find(button => !button.disabled && button.getClientRects().length).click()`);
        if (!expectPending) return;
        const entry = await until(() => state().then(entries => entries.find(record => record.key === key)), `${mode} pending operation identity`);
        assert.equal(entry.backendId, "shoggoth");
        return entry.idem;
      }
      const countEvents = operationId => service.transcriptStore.listEvents(f.profile.id, session.id)
        .filter(event => event.kind === "user" && event.content.operationId === operationId).length;
      async function complete(prompt, idem, answer, { waitForVisible = true } = {}) {
        const receipt = receipts.get(prompt);
        gates.get(prompt)();
        const run = await until(() => {
          const candidate = service.workRunCoordinator.getRun(receipt.runId);
          return candidate?.status === "running" && candidate;
        }, "native Runtime to start");
        await f.complete(run, answer);
        if (waitForVisible) await until(async () => (await threadText()).includes(answer), "canonical answer in React");
        await until(async () => !(await stateFor(idem)), "terminal receipt settles pending send");
        assert.equal(countEvents(receipt.operationId), 1);
        assert.equal(attempts.filter(attempt => attempt.prompt === prompt).length, 1);
      }

      if (verifyAccountModelSwitch) {
        const endpoint = service.productStore.putModelProvider({ id: "fixture-endpoint", kind: "custom-responses",
          name: "Fixture endpoint", baseUrl: `${server.url}/fixture-endpoint/v1`, model: "endpoint-only", models: ["endpoint-only"],
          credentialRef: null, headers: null, awsRegion: null, awsProfile: null, validationStatus: "protocol_valid" });
        service.productStore.putAgentProfile({ ...service.productStore.getAgentProfile(f.profile.id),
          providerRef: endpoint.id, defaultModel: endpoint.model });
        backend.onConnectionsChanged();
        const first = await f.send(session.sessionKey, "endpoint-turn", "Keep this conversation");
        assert.equal(first.status, "running", first.errorCode);
        await f.complete(first, "Answer from the endpoint");
        const current = () => service.chatSessionStore.getSession(session.sessionKey);
        assert.equal(current().runtimeModelSource.source, endpoint.id);

        const binding = f.binding("codex");
        const handle = [...f.transport.handles.values()].find(entry => entry.runtimeProfileId === binding.runtimeProfileId);
        const models = handle.host.modelList.bind(handle.host);
        let duplicateReads = 0;
        handle.host.modelList = async params => {
          if (params.limit === 64) {
            duplicateReads++;
            // A support probe can outlast its deadline while the selected source's catalog is available.
            await waitForGate("duplicate model probe");
          }
          return models(params);
        };
        await open("normal");
        const picker = ".chat-pill--model:not(:disabled)";
        const model = `.model-menu__list [title="${nextModel}"]:not(:disabled)`;
        await until(() => js(`!!document.querySelector(${JSON.stringify(picker)})`), "account model picker ready");
        await js(`document.querySelector(${JSON.stringify(picker)}).click()`);
        await until(() => js(`!!document.querySelector(${JSON.stringify(model)})`), "ChatGPT model offered next to the endpoint");
        await js(`document.querySelector(${JSON.stringify(model)}).click()`);
        const outcome = await until(async () => {
          if (current().nextRuntimeSelection?.modelProviderRef === "@chatgpt") return "saved";
          const hasUnknownToast = await js(`document.body.textContent.includes('暂时无法确认此运行环境是否可用。')`);
          return hasUnknownToast && "RUNTIME_FACTS_UNKNOWN";
        }, "ChatGPT selection result");
        assert.equal(outcome, "saved");
        assert.equal(duplicateReads, 0);
        assert.equal(current().nextRuntimeSelection.model, nextModel);
        assert.equal(current().runtimeModelSource.source, endpoint.id);
        assert.equal(current().runtimeSessionId, first.runtimeSessionRef.sessionId);
        const prompt = "Continue with ChatGPT";
        const idem = await send("normal", prompt);
        const next = await until(() => {
          const receipt = receipts.get(prompt);
          const run = receipt && service.workRunCoordinator.getRun(receipt.runId);
          if (run?.errorCode) throw new Error(`ChatGPT turn failed: ${run.errorCode}`);
          return run?.status === "running" && run;
        }, "ChatGPT turn starts through the composer");
        const contract = service.workRunCoordinator.runExecutionContracts.get(next.id);
        assert.equal(contract.provider.providerRef, null);
        assert.equal(contract.defaultModel, nextModel);
        assert.equal(current().nextRuntimeSelection, undefined);
        assert.equal(current().modelOverride, nextModel);
        assert.notEqual(current().runtimeSessionId, first.runtimeSessionRef.sessionId);
        assert.equal(current().retiredRuntimeSessions.at(-1).runtimeSessionId, first.runtimeSessionRef.sessionId);
        assert.equal(service.productStore.getAgentProfile(f.profile.id).providerRef, endpoint.id);
        await f.complete(next, "Answer from ChatGPT");
        await until(async () => (await threadText()).includes("Answer from the endpoint")
          && (await threadText()).includes("Answer from ChatGPT"), "both answers in the same chat");
        await until(async () => !(await stateFor(idem)), "ChatGPT send receipt settles");
        assert.equal(countEvents(receipts.get(prompt).operationId), 1);

        const beforeRejectedPick = current();
        const pickAccountModel = async modelId => {
          const query = new URLSearchParams({ backend: "shoggoth", sessionKey: key });
          const response = await fetch(`${server.url}/__api/agents/${f.profile.agentId}/runtime-models?${query}`, {
            method: "PUT", headers: { "Content-Type": "application/json", Origin: server.url },
            body: JSON.stringify({ bindingId: binding.id, model: modelId, modelProviderRef: "@chatgpt",
              revision: beforeRejectedPick.revision, acceptAdjustments: true }),
          });
          return (await response.json()).code;
        };
        assert.equal(await pickAccountModel(endpoint.model), "MODEL_ROUTE_UNSUPPORTED");
        const auth = service.accountAuthManager, readAuth = auth.read;
        try {
          auth.read = async () => ({ account: null, requiresOpenaiAuth: true });
          assert.equal(await pickAccountModel(nextModel), "ACCOUNT_NOT_AUTHENTICATED");
        } finally { auth.read = readAuth; }
        assert.deepEqual(current(), beforeRejectedPick);
        console.log("PASS production React/Electron: switch from a custom endpoint to a ChatGPT account model and continue the conversation without a duplicate catalog probe");
        return;
      }

      if (verifyModelSelection) {
        await open("normal");
        const modelButton = ".chat-pill--model";
        const nextModelVisible = () => js(`Array.from(document.querySelectorAll('${modelButton}:not(:disabled)'))
          .some(button => button.getClientRects().length && button.textContent.includes(${JSON.stringify(nextModel)}))`);
        const modelOption = `Array.from(document.querySelectorAll('.model-menu__list [role=option]'))
          .find(button => button.querySelector('.model-menu__name')?.textContent.trim() === ${JSON.stringify(nextModel)})`;
        await until(() => js(`!!document.querySelector('${modelButton}:not(:disabled)')`), "model picker ready");
        await js(`document.querySelector('${modelButton}').click()`);
        await until(() => js(`!!(${modelOption}) && !(${modelOption}).disabled`), "second model available");
        const coordinator = service.workRunCoordinator;
        const track = coordinator.trackSessionSelectionWrite.bind(coordinator);
        const writes = [];
        coordinator.trackSessionSelectionWrite = (sessionKey, change) => track(sessionKey, async () => {
          writes.push(sessionKey);
          if (sessionKey === session.sessionKey) await waitForGate("model selection");
          return change();
        });
        await js(`(${modelOption}).click()`);
        await until(() => gates.has("model selection"), "model write waiting at the Service");
        await until(nextModelVisible, "chosen model displayed on the enabled picker during the write");

        service.productStore.putModelProvider({ id: "fixture-endpoint", kind: "custom-responses", name: "Endpoint",
          baseUrl: "https://example.invalid/v1", model: "endpoint-only", models: ["endpoint-only"],
          credentialRef: null, headers: null, awsRegion: null, awsProfile: null, validationStatus: "protocol_valid" });
        const auth = service.accountAuthManager, readAuth = auth.read.bind(auth);
        auth.read = async () => { throw new Error("fixture ChatGPT source temporarily unavailable"); };
        backend.onConnectionsChanged();
        await js(`location.hash=${JSON.stringify(`#/chat?session=${encodeURIComponent(otherKey)}`)}`);
        await until(() => js(`!!document.querySelector('${modelButton}:not(:disabled)')`), "second session has its own model picker");
        await js(`document.querySelector('${modelButton}').click()`);
        await until(() => js(`document.querySelector('.model-menu__error')?.textContent.includes('ChatGPT')
          && !!document.querySelector('.model-menu__list [title="endpoint-only"]:not(:disabled)')`), "partial source and usable endpoint");
        assert.equal(service.chatSessionStore.getSession(otherSession.sessionKey).modelOverride, null);
        auth.read = readAuth;
        await until(() => js(`!!document.querySelector('.model-menu__list [title="other-session-model"]:not(:disabled)')
          && !document.querySelector('.model-menu__error')`), "ChatGPT models recover in the open menu");
        await js(`document.querySelector('.model-menu__list [title="other-session-model"]').click()`);
        await until(() => service.chatSessionStore.getSession(otherSession.sessionKey).modelOverride === "other-session-model",
          "second session saves its own model before the first write completes");
        await js(`location.hash=${JSON.stringify(chatHash)}`);
        await until(nextModelVisible, "first session still shows its pending selection");
        const prompt = modelSelectionPrompt;
        await send("normal", prompt, false);
        assert.equal(await js(`document.querySelector(${JSON.stringify(textarea("normal"))}).value`), prompt);
        assert.equal((await state()).some(entry => entry.key === key), false);
        assert.equal(attempts.some(attempt => attempt.prompt === prompt), false);
        assert.equal(nativeTurns(), 0);
        gates.get("model selection")();
        const { idem } = await until(() => state().then(entries => entries.find(entry => entry.key === key && entry.accepted)),
          "one durable acceptance after model save");
        const receipt = receipts.get(prompt);
        await until(() => js(`!!document.querySelector(${JSON.stringify(waitingBubble)})?.getClientRects().length`),
          "normal loading animation during model save");
        await until(() => countEvents(receipt.operationId) === 1, "original user projection");
        assert.equal(await notice(), false);
        assert.equal(nativeTurns(), 0);
        assert.equal(countEvents(receipt.operationId), 1);
        const beforeReconnect = lookups.length;
        await open("normal", true);
        await until(() => lookups.slice(beforeReconnect).includes(receipt.operationId), "renderer reconnects to the same queued operation");
        await until(() => js(`!!document.querySelector(${JSON.stringify(waitingBubble)})?.getClientRects().length`), "normal loading after reconnect");
        await until(() => gates.has(prompt), "accepted message waiting for preparation");
        gates.get(prompt)();
        const run = await until(() => {
          const candidate = coordinator.getRun(receipt.runId);
          return candidate?.status === "running" && candidate;
        }, "original message starts once when model save completes");
        const host = [...f.transport.handles.values()].find(handle => handle.runtime === run.runtimeTurnRef.runtime
          && handle.runtimeProfileId === run.runtimeTurnRef.runtimeProfileId
          && handle.runtimeAccountId === run.runtimeTurnRef.runtimeAccountId)?.host;
        assert.equal(host?.lastTurnStartParams.model, nextModel);
        assert.equal(service.chatSessionStore.getSession(otherSession.sessionKey).modelOverride, "other-session-model");
        assert.deepEqual(writes, [session.sessionKey, otherSession.sessionKey], "a partial catalog never writes an automatic fallback");
        await f.complete(run, "Model change reply");
        await until(async () => (await threadText()).includes("Model change reply") && !(await stateFor(idem)), "reply and settled receipt");
        assert.equal(nativeTurns(), 1);
        assert.equal(attempts.filter(attempt => attempt.prompt === prompt).length, 1);
        assert.equal(countEvents(receipt.operationId), 1);
        assert.equal(await js(`Array.from(document.querySelectorAll('.chat-thread .chat-bubble[data-qp]'))
          .filter(bubble => bubble.textContent.trim() === ${JSON.stringify(prompt)}).length`), 1);
        console.log("PASS production React/Electron: switch sessions during a model write, recover ChatGPT alongside a usable endpoint, save independent models and send once on the first session's choice");
        return;
      }

      if (flags.includes("--group-continuation")) {
        const { readClientToken } = require("../app/agent-service/client");
        const { PROTOCOL_VERSION } = require("../app/agent-service/server");
        const { normalizeCodexEvent } = require("../app/agent-service/codex-event-normalizer");
        const { workRunCoordinator: coordinator, groupChatService, groupChatStore, transcriptStore, chatSessionStore } = service;
        coordinator.beforeMemoryCompaction = null;
        coordinator.getRuntimeModelContextWindow = () => 96_000;
        const currentConfig = service.nativeRuntimeConfig.read();
        service.nativeRuntimeConfig.apply({ ...currentConfig, revision: currentConfig.revision + 1,
          flags: { ...currentConfig.flags, runtimeContextLifecycleV1: true } });
        const { profile: peer } = await requestService(f.paths, {
          token: readClientToken(f.paths), version: PROTOCOL_VERSION, method: "agent.create", params: {
            operationId: "group-continuation-peer", backendId: "shoggoth", name: "Group continuation peer", defaultCwd: null, createdAt: Date.now(),
          },
        }, { timeoutMs: 8_000 });
        const name = "Original group from the saved continuation";
        const prior = await f.send(session.sessionKey, "group-continuation-original", `Create ${name}.`);
        assert.equal(prior.status, "running");
        const authority = { profileId: f.profile.id };
        const request = { clientRequestId: "group-continuation-create", name, purpose: "",
          members: [f.profile, peer].map(profile => ({ backendId: "shoggoth", agentId: profile.agentId })) };
        const { ownerScope, previewDigest } = await groupChatService.agentAccess.query("group_chat_prepare", { action: "create", ...request }, authority);
        const args = { ...request, ownerScope, previewDigest, source: "chat", sourceId: session.sessionKey };
        const host = f.transport.hosts.get("codex");
        host.emit(normalizeCodexEvent({ method: "item/started", params: {
          threadId: prior.runtimeTurnRef.sessionId, turnId: prior.runtimeTurnRef.turnId,
          item: { type: "mcpToolCall", id: "group-continuation-tool", server: "shoggoth", tool: "group_chat_create", arguments: args },
        } }));
        const binding = await groupChatService.agentAccess.prepareManagement("group_chat_create", args, authority, prior.id);
        const receipt = await groupChatService.agentAccess.manage("group_chat_create", args, authority, binding);
        const original = await until(() => transcriptStore.listEvents(session.profileId, session.id, { runId: prior.id })
          .find(event => event.kind === "tool_call"), "saved original group creation tool event");
        await f.complete(prior);
        for (let index = 0; index < 8; index += 1) {
          transcriptStore.appendEvent({ profileId: session.profileId, sessionId: session.id, id: `group-continuation-history-${index}`,
            kind: index % 2 ? "assistant" : "user", content: { text: `Fixture history ${index} ${"ordinary words ".repeat(3400)}` } });
        }
        const current = chatSessionStore.getSession(session.sessionKey);
        chatSessionStore.switchRuntime(session.sessionKey, { bindingId: current.runtimeBindingId,
          revision: current.revision, clearModelOverride: false });
        const verified = await f.send(session.sessionKey, "group-continuation-review", `Read [eventId=${original.id}]`);
        assert.equal(verified.status, "completed", verified.errorCode);
        assert.equal(verified.runtimeTurnRef, null);
        const groupsBefore = groupChatStore.listGroups();
        await open("normal");
        const groupButton = ".chat-continuation-action";
        await until(() => js(`!!document.querySelector(${JSON.stringify(groupButton)})`), "original group action on saved direct-chat answer");
        await js(`document.querySelector(${JSON.stringify(groupButton)}).click()`);
        await until(() => js(`!!document.querySelector('[data-group-timeline]') && document.querySelector('.chat-header')?.textContent.includes(${JSON.stringify(name)})`), "verified original group panel in React");
        assert.deepEqual(groupChatStore.listGroups(), groupsBefore);
        assert.equal(groupsBefore.filter(row => (row.group?.id ?? row.id) === receipt.groupId).length, 1);
        assert.equal(nativeTurns(), 1);
        console.log("PASS production React/Electron: saved continuation opens the verified original group without replaying the tool or starting another Runtime turn (1/1)");
        return;
      }

      await open("normal");
      const normal = await send("normal", normalPrompt);
      await until(() => stateFor(normal).then(entry => entry?.accepted), "React acknowledgement before Runtime dispatch");
      await until(() => preparing.has(normalPrompt), "controlled preparation gate");
      assert.equal(nativeTurns(), 0);
      assert.equal(countEvents(receipts.get(normalPrompt).operationId), 1);
      assert((await threadText()).includes(normalPrompt));
      assert.equal(await notice(), false);
      await complete(normalPrompt, normal, "Normal accepted run completed");

      await open("immersive");
      const lost = await send("immersive", lostPrompt);
      await until(notice, "immersive verification banner for a lost ACK");
      assert.equal((await stateFor(lost)).accepted, undefined);
      assert.equal(service.pendingCommandInbox.get(blockedLookup).runId, receipts.get(lostPrompt).runId);
      assert((await threadText()).includes(lostPrompt));
      const priorLookups = lookups.length;
      await open("immersive");
      await until(notice, "verification banner after Electron renderer reload");
      await until(() => lookups.slice(priorLookups).includes(blockedLookup), "reconnect looks up the same original operation");
      assert.equal((await stateFor(lost)).idem, lost);
      const lostOperation = blockedLookup;
      blockedLookup = undefined;
      await js(`Array.from(document.querySelectorAll(${JSON.stringify(`${lookupNotice} button`)})).find(button => !button.disabled && button.getClientRects().length).click()`);
      await until(() => stateFor(lost).then(entry => entry?.accepted), "exact lookup confirms the original in React");
      await until(async () => !(await notice()), "confirmed active receipt clears uncertainty");
      assert(lookups.includes(lostOperation));
      assert.equal(nativeTurns(), 1);
      await until(() => preparing.has(lostPrompt), "recovered operation reaches its own preparation gate");
      await complete(lostPrompt, lost, "Recovered original run completed");
      assert.equal(nativeTurns(), 2);

      await open("normal");
      const WebSocket = require("ws");
      const originalSend = WebSocket.prototype.send;
      const held = [];
      reorder = { terminalSent: false, release() {
        WebSocket.prototype.send = originalSend;
        for (const send of held.splice(0)) send();
      } };
      WebSocket.prototype.send = function (data, ...args) {
        const frame = this._isServer && (typeof data === "string" || Buffer.isBuffer(data))
          ? JSON.parse(data.toString()) : null;
        const target = frame?.type === "event" && frame.event === "chat" && frame.payload?.sessionKey === key;
        // Hold the Proxy's started result and accepted event on their first hop.
        // The only in-flight chat.send in this fixture targets this session.
        if ((frame?.type === "res" && frame.ok && frame.payload?.status === "started")
          || (target && frame.payload.state === "accepted")) {
          held.push(() => originalSend.call(this, data, ...args));
          return;
        }
        if (target && frame.payload.state === "final") reorder.terminalSent = true;
        return originalSend.call(this, data, ...args);
      };
      const reordered = await send("normal", reorderedPrompt);
      await until(() => held.length === 2 && gates.has(reorderedPrompt), "both replies held before dispatch");
      await js(`location.hash=${JSON.stringify(`#/chat?session=${encodeURIComponent(otherKey)}`)}`);
      await until(async () => !(await threadText()).includes(reorderedPrompt), "other session displayed");
      await complete(reorderedPrompt, reordered, "Reordered terminal reply", { waitForVisible: false });
      await until(() => reorder.terminalSent, "real Proxy terminal delivered before either ACK");
      await js(`location.hash=${JSON.stringify(chatHash)}`);
      await until(async () => (await threadText()).includes("Reordered terminal reply"), "terminal visible after switching back while ACKs are held");
      reorder.release();
      await until(async () => !(await stateFor(reordered)), "late acknowledgements do not revive the settled send");
      await open("normal");
      await until(async () => (await threadText()).includes("Reordered terminal reply"), "terminal answer survives refresh");
      for (const text of [reorderedPrompt, "Reordered terminal reply"]) {
        const occurrences = await js(`Array.from(document.querySelectorAll('.chat-thread [data-message-key]')).filter(node => node.textContent.includes(${JSON.stringify(text)})).length`);
        assert.equal(occurrences, 1);
      }
      assert.equal(await notice(), false);

      const acceptedFailure = await send("normal", acceptedFailurePrompt);
      await until(() => stateFor(acceptedFailure).then(entry => entry?.accepted), "failed preparation has an original acceptance");
      await until(() => gates.has(acceptedFailurePrompt), "failed preparation reaches its controlled gate");
      const failedReceipt = receipts.get(acceptedFailurePrompt);
      gates.get(acceptedFailurePrompt)();
      await until(() => service.workRunCoordinator.getRun(failedReceipt.runId)?.errorCode === "EXECUTION_CONTRACT_STALE",
        "accepted run stores its preparation failure");
      await until(async () => !(await stateFor(acceptedFailure)), "failed Run settles the accepted operation");
      const composerValue = () => js('document.querySelector("textarea.chat-composer__input").value');
      assert.equal(await composerValue(), "");
      assert((await threadText()).includes(acceptedFailurePrompt));
      assert(!(await threadText()).includes("Send failed:"));
      assert.equal(countEvents(failedReceipt.operationId), 1);
      assert.equal(attempts.filter(attempt => attempt.prompt === acceptedFailurePrompt).length, 1);

      await send("normal", rejectedPrompt, false);
      await until(() => attempts.some(attempt => attempt.prompt === rejectedPrompt), "rejection reaches the Service");
      await until(async () => (await composerValue()) === rejectedPrompt, "definite rejection restores the draft");
      assert.equal((await state()).length, 0);
      assert.equal(await notice(), false);
      assert.equal((await threadText()).includes(rejectedPrompt), false);
      assert.equal(nativeTurns(), 3);
      const rejected = attempts.filter(attempt => attempt.prompt === rejectedPrompt);
      assert.equal(rejected.length, 1);
      assert.equal(countEvents(rejected[0].operationId), 0);
      assert(!service.pendingCommandInbox.get(rejected[0].operationId));

      const pendingStopStorage = () => js('JSON.parse(localStorage.getItem("shoggoth.chat.pending-native-stops.v1") || "[]")');
      const stopVisible = () => js(`!!document.querySelector(${JSON.stringify(stopNotice)})?.getClientRects().length`);
      await open("immersive");
      const stopped = await send("immersive", stoppedPrompt);
      await until(() => stateFor(stopped).then(entry => entry?.accepted), "stop case is durably accepted");
      const stopButton = "button[title='Stop generating']";
      await until(() => js(`Array.from(document.querySelectorAll(${JSON.stringify(stopButton)})).some(button => !button.disabled && button.getClientRects().length)`), "immersive Stop is available for the original send");
      await js(`Array.from(document.querySelectorAll(${JSON.stringify(stopButton)})).find(button => !button.disabled && button.getClientRects().length).click()`);
      await until(() => service.pendingCommandInbox.get(heldStopOperation)?.cancelRequested, "Service durable cancellation latch");
      await until(stopVisible, "immersive Stop remains pending until proof");
      assert.deepEqual(await pendingStopStorage(), [{ key, backendId: "shoggoth", idempotencyKey: stopped }]);
      assert.equal(countEvents(heldStopOperation), 0);
      await open("normal");
      await until(stopVisible, "Stop pending after opening the normal chat again");
      assert.deepEqual(await pendingStopStorage(), [{ key, backendId: "shoggoth", idempotencyKey: stopped }]);
      assert.equal(stops.length, 1);
      assert.equal(stops[0].params.operationId, heldStopOperation);
      holdStopProjection = false;
      const stopReceipt = receipts.get(stoppedPrompt);
      await until(() => service.workRunCoordinator.getRun(stopReceipt.runId)?.status === "canceled", "durable terminal from the same Run");
      if (await stopVisible()) {
        await js(`document.querySelector(${JSON.stringify(`${stopNotice} button`)})?.click()`);
      }
      await until(async () => !(await stopVisible()) && !(await stateFor(stopped)), "original Stop verification settles");
      assert.deepEqual(await pendingStopStorage(), []);
      assert.equal(countEvents(heldStopOperation), 1);
      assert.equal(nativeTurns(), 3);
      assert.equal(stops.length, 1);

      const originalEvents = service.transcriptStore.listEvents(f.profile.id, session.id, { runId: receipts.get(normalPrompt).runId });
      const originalUser = originalEvents.find(event => event.kind === "user");
      const originalAnswer = originalEvents.find(event => event.kind === "assistant" && event.content.text === "Normal accepted run completed");
      const attachedRequest = "Original request with two files sharing the same name";
      for (const attachment of [continuationFile, secondContinuationFile]) {
        service.inspirationStore.media.write({ attachment, offset: 0, content: Buffer.from(continuationText).toString("base64") });
      }
      const attached = await service.workRunCoordinator.send({ sessionKey: session.sessionKey,
        operationId: "continuation-file-original", prompt: attachedRequest, attachments: [continuationFile, secondContinuationFile] });
      const fileRun = await until(() => {
        const run = service.workRunCoordinator.getRun(attached.run.id);
        return run?.status === "running" && run;
      }, "attachment source Runtime turn");
      await f.complete(fileRun, "Original attachment answer");
      const attachedUser = service.transcriptStore.listEvents(f.profile.id, session.id, { runId: fileRun.id })
        .find(event => event.kind === "user");
      for (const mode of ["immersive", "normal"]) {
        await open(mode);
        await assertContinuationReferenceHidden("[data-qp]", normalPrompt);
        await assertContinuationReferenceHidden("[data-qp]", "Normal accepted run completed");
        await assertContinuationReferenceHidden(".chat-file-button", continuationFile.name, 1);
      }
      const userReference = { kind: "user_message", eventId: originalUser.id };
      const answerReference = { kind: "assistant_message", eventId: originalAnswer.id };
      const attachmentReference = { kind: "attachment", eventId: attachedUser.id, attachmentId: secondContinuationFile.id };
      const continuationPrompt = `/continue-task\n${JSON.stringify({ version: 1, mode: "referenced",
        goal: "Draft the requested status in this turn", limits: [], decisions: [], pendingDecisions: [],
        evidence: [userReference, answerReference, attachmentReference] })}`;

      const before = service.chatSessionStore.getSession(session.sessionKey);
      const continuationConfig = service.nativeRuntimeConfig.read();
      service.nativeRuntimeConfig.apply({ ...continuationConfig, revision: continuationConfig.revision + 1,
        flags: { ...continuationConfig.flags, runtimeContextLifecycleV1: true } });
      service.chatSessionStore.switchRuntime(session.sessionKey, { bindingId: before.runtimeBindingId,
        revision: before.revision, clearModelOverride: false });
      await send("normal", continuationPrompt, false);
      const continuation = await until(() => receipts.get(continuationPrompt), "structured continuation uses durable chat.send");
      const continued = await until(() => {
        const run = service.workRunCoordinator.getRun(continuation.runId);
        if (run?.status === "failed") throw new Error(run.errorCode);
        return run?.status === "running" && run;
      }, "structured continuation enters its native turn");
      assert.equal(countEvents(continuation.operationId), 1);
      assert.equal(nativeTurns(), 5);
      assert.notEqual(continued.runtimeSessionRef.sessionId, before.runtimeSessionId);
      await f.complete(continued, "Structured continuation returned its status");
      await until(async () => (await threadText()).includes("Structured continuation returned its status"), "continued answer in React");
      assert.doesNotMatch(await threadText(), /BEGIN UNTRUSTED VERIFIED CONTINUATION EVIDENCE/u);
      console.log("PASS production React/Electron: early receipt, immersive recovery after ACK loss and reload, terminal before ACK across session switch, accepted preparation failure, exact draft restoration on rejection, original Stop verification after reload, hidden continuation copy menus in both layouts, and structured continuation with transcript references (7/7)");
    } catch (error) {
      if (win && !win.isDestroyed()) console.error("fixture renderer state", await win.webContents.executeJavaScript(`({
        hash: location.hash, pending: localStorage.getItem(${JSON.stringify(pendingKey)}),
        input: [...document.querySelectorAll('textarea')].map(input => ({ value: input.value, disabled: input.disabled, className: input.className })),
        send: [...document.querySelectorAll('[data-send-entry]')].map(button => ({ entry: button.dataset.sendEntry, disabled: button.disabled, visible: !!button.getClientRects().length })),
        notice: [...document.querySelectorAll('[data-tone]')].map(node => node.textContent),
        thread: document.querySelector('.chat-thread')?.textContent.slice(-500),
      })`).catch(() => null));
      console.error("fixture transport state", { attempts, lookups, receiptCount: receipts.size });
      throw error;
    } finally {
      reorder?.release();
      holdStopProjection = false;
      for (const release of gates.values()) release();
      if (win && !win.isDestroyed()) win.destroy();
      await server?.close();
      await proxy?.close();
      await registry.stop();
      await f.close();
    }
  }

  const timeout = setTimeout(() => { console.error("Chat acceptance fixture timed out"); app.exit(1); }, 90_000);
  app.whenReady().then(run).then(() => 0, error => { console.error(error); return 1; }).then(code => {
    clearTimeout(timeout);
    app.exit(code);
  });
}
