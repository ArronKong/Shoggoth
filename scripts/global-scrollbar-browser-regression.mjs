#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const uiRoot = path.join(root, "app/manage-ui");
const viteBin = path.join(uiRoot, "node_modules/vite/bin/vite.js");
const outputRoot = path.join(root, "output/playwright/global-scrollbar");
const host = "127.0.0.1";
const port = 41937;
const baseUrl = `http://${host}:${port}`;
const selfTests = new Set();
const cssomMutations = new Set();
for (const argument of process.argv.slice(2)) {
  const [flag, raw = ""] = argument.split("=", 2);
  const target = flag === "--self-test" ? selfTests : flag === "--mutate-cssom" ? cssomMutations : null;
  if (!target || !raw) throw new Error(`未知参数：${argument}`);
  for (const value of raw.split(",").filter(Boolean)) target.add(value);
}
for (const value of selfTests) {
  assert.ok(["fetch-external-post", "ws-write", "reduced-write"].includes(value), `未知 self-test：${value}`);
}
for (const value of cssomMutations) {
  assert.ok(["drop-clip", "drop-radius", "wrong-radius-computed"].includes(value), `未知 CSSOM mutation：${value}`);
}
const report = {
  startedAt: new Date().toISOString(),
  baseUrl,
  playwright: null,
  browser: null,
  writes: [],
  cases: [],
  failures: [],
  cleanup: {},
  testHooks: { selfTests: [...selfTests], cssomMutations: [...cssomMutations] },
};

function processExited(child) {
  return !child || child.exitCode !== null || child.signalCode !== null;
}

async function waitForProcessExit(child, timeoutMs) {
  if (processExited(child)) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

async function stopOwnProcess(child) {
  if (processExited(child)) return;
  child.kill("SIGTERM");
  if (await waitForProcessExit(child, 2_000)) return;
  child.kill("SIGKILL");
  assert.equal(await waitForProcessExit(child, 2_000), true, "Vite 子进程无法退出");
}

async function probePortAvailable() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host, port, exclusive: true }, resolve);
  });
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function waitForPortReleased(timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      await probePortAvailable();
      return true;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`端口 ${port} 未释放：${lastError?.message || "unknown error"}`);
}

async function waitForVite(child, logs) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (processExited(child)) throw new Error(`Vite 提前退出\n${logs.join("")}`);
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {
      // preview 尚未开始监听。
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`等待 Vite preview 超时\n${logs.join("")}`);
}

function loadChromium() {
  const require = createRequire(import.meta.url);
  const candidates = [
    path.join(root, "node_modules/playwright"),
    path.join(uiRoot, "node_modules/playwright"),
    path.join(os.homedir(), ".openclaw/workspace/node_modules/playwright"),
  ];
  const errors = [];
  for (const candidate of candidates) {
    try {
      const loaded = require(candidate);
      if (!loaded.chromium) throw new Error("模块未导出 chromium");
      report.playwright = { path: candidate, version: require(path.join(candidate, "package.json")).version };
      return loaded.chromium;
    } catch (error) {
      errors.push(`${candidate}: ${error?.message || error}`);
    }
  }
  throw new Error(`找不到可用 Playwright chromium：\n${errors.join("\n")}`);
}

function launchOptions() {
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ].filter(Boolean);
  const executablePath = candidates.find((candidate) => existsSync(candidate));
  return executablePath ? { headless: true, executablePath } : { headless: true };
}

async function installReadOnlyFixture(context) {
  // Binding 活过同 context 内的 SPA reload/navigation，写请求不能因新 document 覆盖数组而漏报。
  await context.exposeFunction("__recordScrollbarRegressionWrite", (write) => report.writes.push(write));
  await context.addInitScript(() => {
    const writes = [];
    Object.defineProperty(window, "__scrollbarRegressionWrites", { value: writes });
    const nativeFetch = window.fetch.bind(window);
    const json = (body, status = 200) => new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
    window.fetch = async (input, init = {}) => {
      const request = input instanceof Request ? input : null;
      const method = String(init.method || request?.method || "GET").toUpperCase();
      const rawUrl = request?.url || String(input);
      let url;
      try { url = new URL(rawUrl, location.href); } catch { url = null; }
      if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
        const write = {
          transport: "fetch",
          method,
          url: url?.href || rawUrl,
          path: url?.pathname || null,
          search: url?.search || null,
        };
        writes.push(write);
        await window.__recordScrollbarRegressionWrite(write);
        return json({ ok: false, error: "read-only browser regression" }, 405);
      }
      if (!url || url.origin !== location.origin || !url.pathname.startsWith("/__api/")) {
        throw new Error(`fixture blocked external read: ${method} ${url?.href || rawUrl}`);
      }
      if (url.pathname === "/__api/config") {
        return json({ config: {
          gatewayUrl: "ws://fixture.invalid",
          token: "fixture-token",
          locale: "zh-CN",
          theme: "light",
          hermesMode: "remote",
          hermesRemotes: [{ profile: "default", baseUrl: "http://fixture.invalid" }],
          hermesKeepAlive: false,
          disabledBackends: [],
          notifications: { chat: false, cron: false, task: false },
          setupCompletedAt: 1,
        } });
      }
      if (url.pathname === "/__api/status") {
        return json({ backends: [
          { id: "openclaw", name: "OpenClaw", connected: true, info: { agents: 1, cronJobs: 0 } },
          { id: "hermes", name: "Hermes", connected: true, info: { agents: 1, cronJobs: 0 } },
        ] });
      }
      if (url.pathname.startsWith("/__api/cron/jobs")) return json({ jobs: [] });
      if (url.pathname === "/__api/agents") return json({ agents: [] });
      if (url.pathname === "/__api/sessions") return json({ sessions: [] });
      if (url.pathname === "/__api/models") return json({ models: [] });
      if (url.pathname === "/__api/dashboard") return json({ summary: {} });
      if (url.pathname === "/__api/dashboard/activities") return json({ activities: [], nextCursor: null });
      if (url.pathname.startsWith("/__api/")) return json({ items: [], rows: [], data: [], supported: false });
      return nativeFetch(input, init);
    };

    class FixtureWebSocket extends EventTarget {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      CONNECTING = 0;
      OPEN = 1;
      CLOSING = 2;
      CLOSED = 3;
      readyState = 0;
      bufferedAmount = 0;
      extensions = "";
      protocol = "";
      binaryType = "blob";
      constructor(url) {
        super();
        this.url = String(url);
        queueMicrotask(() => {
          this.readyState = 1;
          this.dispatchEvent(new Event("open"));
          this.onopen?.(new Event("open"));
        });
      }
      send(raw) {
        let frame;
        try { frame = JSON.parse(String(raw)); } catch { return; }
        if (frame?.type !== "req") return;
        const readOnlyMethods = new Set(["sessions.list", "sessions.subscribe", "chat.history"]);
        if (!readOnlyMethods.has(frame.method)) {
          const write = { transport: "websocket", method: frame.method || null, id: frame.id ?? null };
          writes.push(write);
          void window.__recordScrollbarRegressionWrite(write);
          queueMicrotask(() => {
            const event = new MessageEvent("message", { data: JSON.stringify({
              type: "res",
              id: frame.id,
              ok: false,
              error: { code: "read_only_fixture", message: `fixture blocked WebSocket RPC: ${frame.method || "unknown"}` },
            }) });
            this.dispatchEvent(event);
            this.onmessage?.(event);
          });
          return;
        }
        let payload = {};
        if (frame.method === "sessions.list") {
          payload = {
            sessions: [{
              key: "agent:fixture:main",
              agentId: "fixture",
              backendId: "openclaw",
              updatedAt: Date.now(),
              model: "fixture-model",
            }],
            rows: [],
            hasMore: false,
            defaults: { contextTokens: 128000 },
          };
        } else if (frame.method === "chat.history") {
          payload = { messages: [] };
        }
        queueMicrotask(() => {
          const event = new MessageEvent("message", { data: JSON.stringify({ type: "res", id: frame.id, ok: true, payload }) });
          this.dispatchEvent(event);
          this.onmessage?.(event);
        });
      }
      close() {
        this.readyState = 3;
        const event = new CloseEvent("close", { code: 1000, wasClean: true });
        this.dispatchEvent(event);
        this.onclose?.(event);
      }
      onopen = null;
      onmessage = null;
      onerror = null;
      onclose = null;
    }
    window.WebSocket = FixtureWebSocket;
  });
}

async function waitForWriteCount(expected, label) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (report.writes.length >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${label}: 写探针未进入 Node report.writes`);
}

async function injectWriteSelfTests(page, requested) {
  const tests = [...requested];
  if (tests.length === 0) return;
  const before = report.writes.length;
  await page.evaluate(async (enabled) => {
    for (const test of enabled) {
      if (test === "fetch-external-post" || test === "reduced-write") {
        await fetch(`https://fixture.invalid/${test}`, { method: "POST", body: "blocked" });
      }
    }
    if (enabled.includes("ws-write")) {
      await new Promise((resolve) => {
        const socket = new WebSocket(`ws://${location.host}/__chatws`);
        socket.addEventListener("open", () => {
          socket.send(JSON.stringify({ type: "req", id: "write-probe", method: "sessions.patch", params: { key: "agent:fixture:main" } }));
          setTimeout(() => { socket.close(); resolve(); }, 20);
        }, { once: true });
      });
    }
  }, tests);
  await waitForWriteCount(before + tests.length, `self-test ${tests.join(",")}`);
}

function fixtureStyle(kind) {
  const base = "box-sizing:border-box;position:fixed;left:20px;top:20px;z-index:2147483646;background:transparent";
  if (kind === "compact") return `${base};width:120px;height:96px;overflow-y:auto;overflow-x:hidden`;
  if (kind === "board") return `${base};top:140px;width:320px;height:180px;overflow-x:auto;overflow-y:hidden`;
  if (kind === "corner") return `${base};left:360px;top:140px;width:160px;height:120px;overflow:auto`;
  if (kind === "hidden") return `${base};width:160px;height:48px;overflow-x:auto;overflow-y:hidden;white-space:nowrap`;
  return base;
}

async function addSyntheticFixtures(page) {
  await page.evaluate((styles) => {
    const make = (tag, kind) => {
      const element = document.createElement(tag);
      element.dataset.scrollbarFixture = kind;
      element.setAttribute("style", styles[kind]);
      document.body.append(element);
      return element;
    };
    const compact = make("div", "compact");
    compact.innerHTML = `<svg width="16" height="16" aria-hidden="true"><path d="M0 0h12v12H0z" /></svg>${"<div>compact row</div>".repeat(16)}`;

    const textarea = make("textarea", "textarea");
    textarea.style.cssText = "position:fixed;left:160px;top:20px;width:180px;height:96px;overflow:auto;z-index:2147483646";
    textarea.value = `${"textarea line\n".repeat(30)}${"x".repeat(300)}`;

    const pre = make("pre", "pre");
    pre.style.cssText = "position:fixed;left:360px;top:20px;width:180px;height:96px;overflow:auto;white-space:pre;z-index:2147483646";
    pre.textContent = `${"pre-line\n".repeat(20)}${"wide".repeat(160)}`;

    const board = make("div", "board");
    board.className = "wb-board";
    const boardContent = document.createElement("div");
    boardContent.style.cssText = "flex:0 0 900px;width:900px;height:160px";
    board.append(boardContent);

    const corner = make("div", "corner");
    const cornerContent = document.createElement("div");
    cornerContent.style.cssText = "width:500px;height:500px";
    corner.append(cornerContent);

    const iframe = document.createElement("iframe");
    iframe.dataset.scrollbarFixture = "iframe";
    iframe.setAttribute("sandbox", "allow-scripts");
    iframe.srcdoc = "<!doctype html><title>isolated fixture</title>";
    iframe.hidden = true;
    document.body.append(iframe);
  }, {
    compact: fixtureStyle("compact"),
    textarea: fixtureStyle("textarea"),
    pre: fixtureStyle("pre"),
    board: fixtureStyle("board"),
    corner: fixtureStyle("corner"),
    hidden: fixtureStyle("hidden"),
    iframe: fixtureStyle("iframe"),
  });
}

async function cssEvidence(locator, theme, expectedOverflow) {
  return locator.evaluate((element, args) => {
    const rootStyle = getComputedStyle(document.documentElement);
    const base = getComputedStyle(element);
    const scrollbar = getComputedStyle(element, "::-webkit-scrollbar");
    const thumb = getComputedStyle(element, "::-webkit-scrollbar-thumb");
    const vertical = getComputedStyle(element, "::-webkit-scrollbar-thumb:vertical");
    const horizontal = getComputedStyle(element, "::-webkit-scrollbar-thumb:horizontal");
    const corner = getComputedStyle(element, "::-webkit-scrollbar-corner");
    const cssomDirectional = { vertical: [], horizontal: [], accessErrors: [] };
    const declaration = (style) => ({
      borderTopWidth: style.getPropertyValue("border-top-width").trim(),
      borderRightWidth: style.getPropertyValue("border-right-width").trim(),
      borderBottomWidth: style.getPropertyValue("border-bottom-width").trim(),
      borderLeftWidth: style.getPropertyValue("border-left-width").trim(),
      backgroundClip: style.getPropertyValue("background-clip").trim(),
      borderRadius: style.getPropertyValue("border-radius").trim(),
    });
    const collectRules = (rules, sheetHref) => {
      for (const rule of rules) {
        if (rule.selectorText && rule.style) {
          const selectors = rule.selectorText.split(",").map((selector) => selector.trim());
          const entry = { selectorText: rule.selectorText, cssText: rule.cssText, declarations: declaration(rule.style), sheetHref };
          if (selectors.some((selector) => selector === "*::-webkit-scrollbar-thumb:vertical" || selector === "::-webkit-scrollbar-thumb:vertical")) cssomDirectional.vertical.push(entry);
          if (selectors.some((selector) => selector === "*::-webkit-scrollbar-thumb:horizontal" || selector === "::-webkit-scrollbar-thumb:horizontal")) cssomDirectional.horizontal.push(entry);
        }
        if (rule.cssRules) collectRules(rule.cssRules, sheetHref);
      }
    };
    for (const sheet of document.styleSheets) {
      let rules;
      try { rules = sheet.cssRules; } catch (error) {
        cssomDirectional.accessErrors.push({ href: sheet.href, name: error?.name || "Error", message: error?.message || String(error) });
        continue;
      }
      collectRules(rules, sheet.href);
    }
    for (const mutation of args.cssomMutations) {
      for (const entry of [...cssomDirectional.vertical, ...cssomDirectional.horizontal]) {
        if (mutation === "drop-clip") entry.declarations.backgroundClip = "";
        if (mutation === "drop-radius") entry.declarations.borderRadius = "";
        if (mutation === "wrong-radius-computed") entry.declarations.borderRadius = "0px";
      }
    }
    return {
      vars: {
        thumb: rootStyle.getPropertyValue("--ui-scrollbar-thumb-size").trim(),
        inset: rootStyle.getPropertyValue("--ui-scrollbar-edge-inset").trim(),
        track: rootStyle.getPropertyValue("--ui-scrollbar-track-size").trim(),
        radius: rootStyle.getPropertyValue("--ui-scrollbar-radius").trim(),
        fade: rootStyle.getPropertyValue("--ui-scrollbar-fade-duration").trim(),
        visible: base.getPropertyValue("--ui-scrollbar-thumb-visible").trim(),
      },
      scrollbar: { width: scrollbar.width, height: scrollbar.height, display: scrollbar.display },
      thumb: { color: thumb.backgroundColor, clip: thumb.backgroundClip, radius: thumb.borderRadius },
      vertical: {
        top: args.cssomMutations.includes("wrong-radius-computed") ? "0px" : vertical.borderTopWidth,
        right: args.cssomMutations.includes("wrong-radius-computed") ? "8px" : vertical.borderRightWidth,
        bottom: args.cssomMutations.includes("wrong-radius-computed") ? "0px" : vertical.borderBottomWidth,
        left: args.cssomMutations.includes("wrong-radius-computed") ? "0px" : vertical.borderLeftWidth,
        clip: args.cssomMutations.includes("wrong-radius-computed") ? "content-box" : vertical.backgroundClip,
        radius: args.cssomMutations.includes("wrong-radius-computed") ? "0px" : vertical.borderRadius,
      },
      horizontal: {
        top: args.cssomMutations.includes("wrong-radius-computed") ? "0px" : horizontal.borderTopWidth,
        right: args.cssomMutations.includes("wrong-radius-computed") ? "0px" : horizontal.borderRightWidth,
        bottom: args.cssomMutations.includes("wrong-radius-computed") ? "8px" : horizontal.borderBottomWidth,
        left: args.cssomMutations.includes("wrong-radius-computed") ? "0px" : horizontal.borderLeftWidth,
        clip: args.cssomMutations.includes("wrong-radius-computed") ? "content-box" : horizontal.backgroundClip,
        radius: args.cssomMutations.includes("wrong-radius-computed") ? "0px" : horizontal.borderRadius,
      },
      corner: corner.backgroundColor,
      cssomDirectional,
      geometry: {
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
      },
      expectedOverflow: args.expectedOverflow,
      theme: args.theme,
      hovered: element.matches(":hover"),
      hoveredAncestor: (() => {
        let current = element.parentElement;
        while (current) {
          if (current.matches(":hover")) return `${current.tagName.toLowerCase()}.${current.className}`;
          current = current.parentElement;
        }
        return null;
      })(),
      classes: element.className,
      inlineThumbColor: element.style.getPropertyValue("--ui-scrollbar-thumb-color"),
      animations: element.getAnimations().map((animation) => ({ currentTime: animation.currentTime, playState: animation.playState })),
      ancestorStates: (() => {
        const states = [];
        let current = element;
        while (current) {
          states.push({
            tag: current.tagName.toLowerCase(),
            className: current.className,
            hovered: current.matches(":hover"),
            scrolling: current.classList.contains("scrolling"),
            inlineThumbColor: current.style.getPropertyValue("--ui-scrollbar-thumb-color"),
            animations: current.getAnimations().map((animation) => ({ currentTime: animation.currentTime, playState: animation.playState })),
          });
          current = current.parentElement;
        }
        return states;
      })(),
    };
  }, { theme, expectedOverflow, cssomMutations: [...cssomMutations] });
}

function assertContract(evidence, { hidden = false, immersive = false, caseName = "case" } = {}) {
  assert.equal(evidence.vars.thumb, "4px");
  assert.equal(evidence.vars.inset, "8px");
  assert.ok(evidence.vars.track === "12px" || evidence.vars.track === "calc(4px + 8px)", `track var: ${evidence.vars.track}`);
  assert.equal(evidence.vars.radius, "2px");
  assert.equal(evidence.vars.fade, "400ms");
  const compactColor = evidence.vars.visible.replaceAll(" ", "").replace(",.", ",0.");
  assert.equal(compactColor, immersive || evidence.theme === "dark" ? "rgba(255,255,255,0.16)" : "rgba(0,0,0,0.1)");
  if (hidden) {
    assert.equal(evidence.scrollbar.width, "0px");
    assert.equal(evidence.scrollbar.height, "0px");
    return;
  }
  assert.equal(evidence.scrollbar.width, "12px");
  assert.equal(evidence.scrollbar.height, "12px");
  assert.equal(evidence.thumb.color, "rgba(0, 0, 0, 0)", `${caseName}: 静止 thumb 必须透明（hovered=${evidence.hovered}, ancestor=${evidence.hoveredAncestor}, classes=${evidence.classes}）`);
  assert.match(evidence.corner, /rgba\(0, 0, 0, 0\)|transparent/);
  const compact = (value) => String(value || "").replaceAll(" ", "");
  const variable = (name) => `var(${name})`;
  const verticalExpectedRadius = `${variable("--ui-scrollbar-radius")} calc(${variable("--ui-scrollbar-edge-inset")} + ${variable("--ui-scrollbar-radius")}) calc(${variable("--ui-scrollbar-edge-inset")} + ${variable("--ui-scrollbar-radius")}) ${variable("--ui-scrollbar-radius")} / ${variable("--ui-scrollbar-radius")}`;
  const horizontalExpectedRadius = `${variable("--ui-scrollbar-radius")} / ${variable("--ui-scrollbar-radius")} ${variable("--ui-scrollbar-radius")} calc(${variable("--ui-scrollbar-edge-inset")} + ${variable("--ui-scrollbar-radius")}) calc(${variable("--ui-scrollbar-edge-inset")} + ${variable("--ui-scrollbar-radius")})`;
  const assertDirectional = (label, actual, expected) => {
    assert.equal(actual.length, 1, `${caseName}: CSSOM ${label} 全局规则必须且只能有一条；accessErrors=${JSON.stringify(evidence.cssomDirectional.accessErrors)}`);
    const declarations = actual[0].declarations;
    for (const side of ["Top", "Right", "Bottom", "Left"]) {
      assert.equal(compact(declarations[`border${side}Width`]), compact(expected[`border${side}Width`]), `${caseName}: CSSOM ${label} border-${side.toLowerCase()}-width`);
    }
    assert.equal(declarations.backgroundClip, "content-box", `${caseName}: CSSOM ${label} background-clip`);
    assert.equal(compact(declarations.borderRadius), compact(expected.borderRadius), `${caseName}: CSSOM ${label} border-radius`);
  };
  const directionalComputed = evidence.vertical.right === "8px" && evidence.horizontal.bottom === "8px";
  if (directionalComputed) {
    assert.deepEqual(
      [evidence.vertical.top, evidence.vertical.right, evidence.vertical.bottom, evidence.vertical.left],
      ["0px", "8px", "0px", "0px"],
      `${caseName}: vertical computed 四边`,
    );
    assert.deepEqual(
      [evidence.horizontal.top, evidence.horizontal.right, evidence.horizontal.bottom, evidence.horizontal.left],
      ["0px", "0px", "8px", "0px"],
      `${caseName}: horizontal computed 四边`,
    );
    assert.equal(evidence.vertical.clip, "content-box");
    assert.equal(evidence.horizontal.clip, "content-box");
  }
  // 无条件验证声明源：即使未来 Chromium 开始返回方向 pseudo computed，非空/0px
  // 也不能绕过四边、clip 与精确 directional radius 合同。
  assert.deepEqual(evidence.cssomDirectional.accessErrors, [], `${caseName}: 无法读取样式表 CSSOM`);
  assertDirectional("vertical", evidence.cssomDirectional.vertical, {
    borderTopWidth: "0px", borderRightWidth: variable("--ui-scrollbar-edge-inset"), borderBottomWidth: "0px", borderLeftWidth: "0px",
    borderRadius: verticalExpectedRadius,
  });
  assertDirectional("horizontal", evidence.cssomDirectional.horizontal, {
    borderTopWidth: "0px", borderRightWidth: "0px", borderBottomWidth: variable("--ui-scrollbar-edge-inset"), borderLeftWidth: "0px",
    borderRadius: horizontalExpectedRadius,
  });
}

function assertGeometry(evidence, overflow) {
  const { clientWidth, scrollWidth, clientHeight, scrollHeight } = evidence.geometry;
  if (overflow.includes("x")) assert.ok(scrollWidth > clientWidth, `${overflow}: 缺少横向溢出`);
  else assert.ok(scrollWidth <= clientWidth + 1, `${overflow}: 意外横向溢出`);
  if (overflow.includes("y")) assert.ok(scrollHeight > clientHeight, `${overflow}: 缺少纵向溢出`);
  else assert.ok(scrollHeight <= clientHeight + 1, `${overflow}: 意外纵向溢出`);
}

async function recordCase(page, name, locator, matrix, overflow, options = {}) {
  // 根据真实几何挑一个容器外角落；720px 宽时 800px Modal 会越过左右边界，固定左下并不安全。
  const box = await locator.boundingBox();
  const viewport = page.viewportSize();
  const candidates = [[1, 1], [(viewport?.width || 2) - 1, 1], [1, (viewport?.height || 2) - 1], [(viewport?.width || 2) - 1, (viewport?.height || 2) - 1]];
  const away = candidates.find(([x, y]) => !box || x < box.x || x > box.x + box.width || y < box.y || y > box.y + box.height) || [1, 1];
  await page.mouse.move(away[0], away[1]);
  if (name === "modal-portal" && matrix.width === 720) await page.waitForTimeout(450);
  const evidence = await cssEvidence(locator, matrix.theme, overflow);
  assertContract(evidence, { ...options, caseName: name });
  assertGeometry(evidence, overflow);
  const scroll = await locator.evaluate((element, axes) => {
    if (axes.includes("y")) element.scrollTop = Math.min(80, element.scrollHeight - element.clientHeight);
    if (axes.includes("x")) element.scrollLeft = Math.min(80, element.scrollWidth - element.clientWidth);
    return { top: element.scrollTop, left: element.scrollLeft };
  }, overflow);
  if (overflow.includes("y")) assert.ok(scroll.top > 0, `${name}: scrollTop 不可写`);
  if (overflow.includes("x")) assert.ok(scroll.left > 0, `${name}: scrollLeft 不可写`);
  if (options.hidden) return { evidence, scroll, active: null, ...options };
  await page.waitForFunction((element) => element.classList.contains("scrolling"), await locator.elementHandle(), { timeout: 1_500 });
  const active = await locator.evaluate((element) => ({
    scrolling: element.classList.contains("scrolling"),
    thumbColor: getComputedStyle(element, "::-webkit-scrollbar-thumb").backgroundColor,
    visibleColor: getComputedStyle(element).getPropertyValue("--ui-scrollbar-thumb-visible").trim(),
  }));
  const compactColor = (value) => value.replaceAll(" ", "").replace(",.", ",0.");
  assert.equal(active.scrolling, true, `${name}: 真实滚动事件未加 .scrolling`);
  assert.equal(
    compactColor(active.thumbColor),
    options.immersive || matrix.theme === "dark" ? "rgba(255,255,255,0.16)" : "rgba(0,0,0,0.1)",
    `${name}: active thumb theme color`,
  );
  return { evidence, scroll, active, ...options };
}

async function assertNoDocumentOverflow(page, matrix) {
  const evidence = await page.evaluate(() => ({
    innerWidth,
    documentElementScrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
    overflowPx: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth,
  }));
  assert.ok(evidence.overflowPx <= 1, `${matrix.width}/${matrix.theme}: document 横溢出 ${evidence.overflowPx}px`);
  return evidence;
}

async function captureCase(page, name, matrix, run) {
  try {
    const evidence = await run();
    const entry = { name, status: "passed", matrix, ...(evidence ?? {}) };
    report.cases.push(entry);
    return entry;
  } catch (error) {
    const message = error?.message || String(error);
    report.cases.push({ name, status: "failed", matrix, error: message });
    report.failures.push({ case: name, matrix, message, stack: error?.stack || null });
    await page.screenshot({ path: path.join(outputRoot, `${matrix.width}-${matrix.theme}-${name}-failed.png`), fullPage: true }).catch(() => {});
    return undefined;
  }
}

async function runMotionContract(page, target) {
  const evidence = {};
  report.motion = evidence;
  const sample = () => target.evaluate((element) => ({
    hovered: element.matches(":hover"),
    color: getComputedStyle(element, "::-webkit-scrollbar-thumb").backgroundColor,
    customColor: getComputedStyle(element).getPropertyValue("--ui-scrollbar-thumb-color").trim(),
    animations: element.getAnimations().map((animation) => ({ currentTime: animation.currentTime, playState: animation.playState })),
  }));
  const startedAt = Date.now();
  await target.evaluate((element) => { element.scrollTop = 0; element.scrollTop = 31; });
  await page.waitForFunction((element) => element.classList.contains("scrolling"), await target.elementHandle());
  const immediateColor = await target.evaluate((element) => getComputedStyle(element, "::-webkit-scrollbar-thumb").backgroundColor);
  evidence.immediateColor = immediateColor;
  assert.notEqual(immediateColor, "rgba(0, 0, 0, 0)");
  await page.waitForTimeout(850);
  assert.equal(await target.evaluate((element) => element.classList.contains("scrolling")), true, "≤900ms 时 scrolling 不应清理");
  await page.waitForFunction((element) => !element.classList.contains("scrolling"), await target.elementHandle(), { timeout: 1_000 });
  const removedAtMs = Date.now() - startedAt;
  evidence.removedAtMs = removedAtMs;
  assert.ok(removedAtMs >= 1100 && removedAtMs <= 1700, `scrolling 清理耗时 ${removedAtMs}ms 超界`);
  await page.waitForTimeout(160);
  const midpoint = await target.evaluate((element) => ({
    color: getComputedStyle(element, "::-webkit-scrollbar-thumb").backgroundColor,
    animations: element.getAnimations().map((animation) => ({ currentTime: animation.currentTime, playState: animation.playState })),
  }));
  evidence.midpoint = midpoint;
  assert.ok(midpoint.animations.length > 0, "普通 motion 应注册 400ms fade WAAPI");
  assert.notEqual(midpoint.color, "rgba(0, 0, 0, 0)", "fade 中间帧不应已完全透明");
  assert.notEqual(midpoint.color, immediateColor, "fade 中间帧不应仍为完整主题色");
  await page.waitForTimeout(360);
  assert.equal(await target.evaluate((element) => element.getAnimations().length), 0, "fade 完成后 animation 必须清理");

  // 上一段保留了非零 scrollTop；Playwright 为 hover 顶部 SVG 自动 scrollIntoView 会制造新 scroll timer。
  // 先归零并完整等完 1200+400ms，确保下面是纯 hover-only 生命周期。
  await target.evaluate((element) => { element.scrollTop = 0; });
  await page.waitForFunction((element) => element.classList.contains("scrolling"), await target.elementHandle());
  await page.waitForFunction((element) => !element.classList.contains("scrolling"), await target.elementHandle(), { timeout: 1_700 });
  await page.waitForFunction((element) => element.getAnimations().length === 0, await target.elementHandle(), { timeout: 900 });
  const svg = target.locator("svg path").first();
  await page.evaluate(() => {
    window.__scrollbarPointerEvidence = [];
    const describe = (value) => value instanceof Element
      ? { tag: value.tagName.toLowerCase(), id: value.id, className: typeof value.className === "string" ? value.className : value.getAttribute("class") || "" }
      : value ? { type: value.constructor?.name || typeof value } : null;
    for (const type of ["pointerover", "pointerout", "pointerenter", "pointerleave"]) {
      document.addEventListener(type, (event) => {
        const scroller = document.querySelector('[data-scrollbar-fixture="compact"]');
        const entry = {
          type,
          target: describe(event.target),
          relatedTarget: describe(event.relatedTarget),
          path: event.composedPath().slice(0, 6).map(describe),
          syncHovered: scroller?.matches(":hover") ?? null,
          microtaskHovered: null,
          rafHovered: null,
        };
        window.__scrollbarPointerEvidence.push(entry);
        queueMicrotask(() => { entry.microtaskHovered = scroller?.matches(":hover") ?? null; });
        requestAnimationFrame(() => { entry.rafHovered = scroller?.matches(":hover") ?? null; });
      }, true);
    }
  });
  const svgBox = await svg.boundingBox();
  assert.ok(svgBox, "SVG path 必须具有真实几何");
  await page.mouse.move(svgBox.x + svgBox.width / 2, svgBox.y + svgBox.height / 2);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const hoverSample = await sample();
  evidence.hoverSample = hoverSample;
  assert.equal(hoverSample.hovered, true, "真实 mouse.move 进入 SVG 后 scroll ancestor 必须匹配 :hover");
  assert.notEqual(hoverSample.color, "rgba(0, 0, 0, 0)", "SVG 后代 hover 必须显色");
  const targetBox = await target.boundingBox();
  const viewport = page.viewportSize();
  const away = [[1, 1], [(viewport?.width || 2) - 1, (viewport?.height || 2) - 1]].find(([x, y]) => !targetBox || x < targetBox.x || x > targetBox.x + targetBox.width || y < targetBox.y || y > targetBox.y + targetBox.height) || [1, 1];
  await page.mouse.move(away[0], away[1]);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const leftSample = await sample();
  evidence.leftSample = leftSample;
  assert.equal(leftSample.hovered, false, "真实 mouse.move 离开后 scroll ancestor 不应匹配 :hover");
  await page.waitForTimeout(40);
  const fadeSample = await sample();
  evidence.fadeSample = fadeSample;
  evidence.pointerEvents = await page.evaluate(() => window.__scrollbarPointerEvidence || []);
  assert.ok(fadeSample.animations.length > 0, `hover-only 离场必须渐隐：${JSON.stringify({ hoverSample, leftSample, fadeSample })}`);
  await page.waitForTimeout(430);
  return evidence;
}

async function runMatrix(browser, matrix) {
  const context = await browser.newContext({
    viewport: { width: matrix.width, height: 900 },
    colorScheme: matrix.theme,
    reducedMotion: "no-preference",
  });
  await installReadOnlyFixture(context);
  const page = await context.newPage();
  page.setDefaultTimeout(12_000);
  try {
    const response = await page.goto(`${baseUrl}/#/components`, { waitUntil: "domcontentloaded" });
    assert.equal(response?.status(), 200, "components 根文档应返回 200");
    await page.locator(".components-page").waitFor({ state: "visible" });
    await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, matrix.theme);
    const pageMeasurement = await page.locator("main.content").evaluate((element) => {
      const fixture = document.createElement("div");
      fixture.dataset.scrollbarFixture = "page";
      fixture.style.height = "2000px";
      fixture.style.width = "1px";
      fixture.style.flex = "0 0 auto";
      element.append(fixture);
      return {
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        documentOverflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth,
      };
    });
    await captureCase(page, "page", matrix, async () => {
      assert.ok(pageMeasurement.scrollHeight > pageMeasurement.clientHeight, "main.content 必须形成纵向溢出");
      assert.ok(pageMeasurement.scrollWidth <= pageMeasurement.clientWidth + 1, "main.content 不应横向溢出");
      const result = await recordCase(page, "page", page.locator("main.content"), matrix, "y");
      if (matrix.width === 720) result.documentOverflow = await assertNoDocumentOverflow(page, matrix);
      return result;
    });

    await addSyntheticFixtures(page);
    for (const [name, selector, overflow] of [
      ["compact", '[data-scrollbar-fixture="compact"]', "y"],
      ["textarea", '[data-scrollbar-fixture="textarea"]', "y"],
      ["pre", '[data-scrollbar-fixture="pre"]', "xy"],
      ["board", '.wb-board[data-scrollbar-fixture="board"]', "x"],
      ["corner", '[data-scrollbar-fixture="corner"]', "xy"],
    ]) {
      await captureCase(page, name, matrix, async () => {
        const result = await recordCase(page, name, page.locator(selector), matrix, overflow);
        if (matrix.width === 720 && name === "board") result.documentOverflow = await assertNoDocumentOverflow(page, matrix);
        return result;
      });
    }
    await captureCase(page, "hidden", matrix, async () => {
      const hiddenWheel = page.locator('.components-page [role="tablist"][data-scrollbar="hidden"]').first();
      await hiddenWheel.evaluate((element) => { element.style.width = "160px"; element.style.maxWidth = "160px"; });
      const result = await recordCase(page, "hidden", hiddenWheel, matrix, "x", { hidden: true, realFilterTabs: true });
      await hiddenWheel.hover();
      await page.mouse.wheel(0, 80);
      assert.ok(await hiddenWheel.evaluate((element) => element.scrollLeft) > 0, "hidden FilterTabs 必须支持竖轮横滑");
      assert.equal(await page.locator('iframe[data-scrollbar-fixture="iframe"]').getAttribute("sandbox"), "allow-scripts");
      return result;
    });
    await captureCase(page, "modal-portal", matrix, async () => {
      await page.locator('[data-gallery="open-modal"]').click();
      const dialog = page.locator('[role="dialog"]:visible');
      await dialog.waitFor();
      assert.equal(await dialog.evaluate((element) => document.body.contains(element) && !document.querySelector(".app")?.contains(element)), true, "Modal 必须位于 body Portal");
      const modalBody = dialog.locator("header + div");
      await modalBody.evaluate((element) => {
        element.style.height = "160px";
        element.style.maxHeight = "160px";
        element.style.overflow = "auto";
        element.insertAdjacentHTML("beforeend", `<div data-scrollbar-fixture="modal" style="height:1000px;min-height:1000px;width:1px;flex:none"></div>`);
      });
      const result = await recordCase(page, "modal-portal", modalBody, matrix, "y");
      await page.keyboard.press("Escape");
      return result;
    });
    await captureCase(page, "select-portal", matrix, async () => {
      await page.keyboard.press("Escape");
      await page.locator('.components-page [role="combobox"]').first().click();
      const listbox = page.locator('[role="listbox"]:visible');
      await listbox.waitFor();
      assert.equal(await listbox.evaluate((element) => document.body.contains(element) && !document.querySelector(".app")?.contains(element)), true, "Select 必须位于 body Portal");
      await listbox.evaluate((element) => {
        element.style.maxHeight = "120px";
        element.style.overflowY = "auto";
        for (let i = 0; i < 20; i += 1) {
          const option = document.createElement("div");
          option.setAttribute("role", "option");
          option.textContent = `read-only option ${i}`;
          option.style.height = "28px";
          element.append(option);
        }
      });
      const result = await recordCase(page, "select-portal", listbox, matrix, "y");
      await page.keyboard.press("Escape");
      return result;
    });

    if (matrix.width === 1380) {
      await captureCase(page, "menu-portal", matrix, async () => {
        await page.goto(`${baseUrl}/#/cron`, { waitUntil: "domcontentloaded" });
        await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, matrix.theme);
        const cronButton = page.locator(".cron-new");
        await cronButton.waitFor({ state: "visible" });
        await cronButton.click();
        const menu = page.locator(".cron-menu-popup:visible");
        await menu.waitFor();
        assert.equal(await menu.evaluate((element) => document.body.contains(element) && !document.querySelector(".app")?.contains(element)), true, "Cron Menu 必须位于 body Portal");
        await menu.evaluate((element) => {
          element.style.maxHeight = "100px";
          element.style.overflowY = "auto";
          for (let i = 0; i < 16; i += 1) element.insertAdjacentHTML("beforeend", `<div class="cron-menu-item">read-only ${i}</div>`);
        });
        const result = await recordCase(page, "menu-portal", menu, matrix, "y");
        await page.keyboard.press("Escape");
        return result;
      });
    }

    await captureCase(page, "chat", matrix, async () => {
      await page.goto(`${baseUrl}/#/chat`, { waitUntil: "domcontentloaded" });
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, matrix.theme);
      await page.locator(".chat-shell").waitFor({ state: "visible" });
      const thread = page.locator(".chat-thread");
      await thread.waitFor({ state: "visible" });
      await thread.evaluate((element) => {
        const message = document.createElement("div");
        message.dataset.scrollbarFixture = "chat";
        message.style.cssText = "height:2400px;width:1px;flex:0 0 auto";
        element.append(message);
      });
      const result = await recordCase(page, "chat", thread, matrix, "y");
      if (matrix.width === 720) result.documentOverflow = await assertNoDocumentOverflow(page, matrix);
      return result;
    });

    if (matrix.width === 1380) {
      await captureCase(page, "immersive", matrix, async () => {
        const immersiveButton = page.locator('.chat-headbtn[title="沉浸模式"], .chat-headbtn[title="Immersive"]').first();
        await immersiveButton.click();
        await page.locator("body[data-immersive]").waitFor();
        const immersiveThread = page.locator('body[data-immersive] [data-glass-clip]').first();
        await immersiveThread.waitFor({ state: "visible" });
        await immersiveThread.evaluate((element) => {
          const message = document.createElement("div");
          message.dataset.scrollbarFixture = "immersive-chat";
          message.style.cssText = "height:2400px;width:1px;flex:0 0 auto";
          element.append(message);
        });
        const result = await recordCase(page, "immersive", immersiveThread, matrix, "y", { immersive: true });
        const exit = page.locator('button[title="退出沉浸模式"], button[title="Exit immersive"]').first();
        await exit.click();
        await page.waitForFunction(() => !document.body.hasAttribute("data-immersive"));
        return result;
      });
    }

    if (matrix.width === 1380 && matrix.theme === "light") {
      await captureCase(page, "motion", matrix, async () => {
        await page.goto(`${baseUrl}/#/components`, { waitUntil: "domcontentloaded" });
        await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
        await addSyntheticFixtures(page);
        const motionTarget = page.locator('[data-scrollbar-fixture="compact"]');
        await page.locator('[data-scrollbar-fixture]:not([data-scrollbar-fixture="compact"])').evaluateAll((elements) => {
          for (const element of elements) element.style.pointerEvents = "none";
        });
        report.motion = await runMotionContract(page, motionTarget);
        return { evidence: report.motion };
      });
    }
    await captureCase(page, "document-overflow", matrix, async () => {
      return { documentOverflow: await assertNoDocumentOverflow(page, matrix) };
    });
  } catch (error) {
    const filename = `${matrix.width}-${matrix.theme}-failed.png`;
    await page.screenshot({ path: path.join(outputRoot, filename), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    await context.close();
  }
}

async function runReducedMotion(browser) {
  const context = await browser.newContext({ viewport: { width: 1380, height: 900 }, colorScheme: "light", reducedMotion: "reduce" });
  await installReadOnlyFixture(context);
  const page = await context.newPage();
  try {
    await page.goto(`${baseUrl}/#/components`, { waitUntil: "domcontentloaded" });
    await page.locator(".components-page").waitFor({ state: "visible" });
    await addSyntheticFixtures(page);
    await captureCase(page, "reduced-motion", { width: 1380, theme: "light", reducedMotion: true }, async () => {
      const target = page.locator('[data-scrollbar-fixture="compact"]');
      await target.evaluate((element) => { element.scrollTop = 20; });
      await page.waitForFunction((element) => element.classList.contains("scrolling"), await target.elementHandle());
      await page.waitForFunction((element) => !element.classList.contains("scrolling"), await target.elementHandle(), { timeout: 1_700 });
      assert.equal(await target.evaluate((element) => element.getAnimations().length), 0, "reduced motion 不应创建 fade animation");
      return { animations: 0 };
    });
    if (selfTests.has("reduced-write")) await injectWriteSelfTests(page, new Set(["reduced-write"]));
  } finally {
    await context.close();
  }
}

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });
let vite;
let browser;
let exitCode = 0;
const serverLogs = [];
try {
  assert.equal(existsSync(viteBin), true, `Vite 不存在：${viteBin}`);
  await probePortAvailable();
  const chromium = loadChromium();
  vite = spawn(
    process.execPath,
    [viteBin, "preview", "--host", host, "--port", String(port), "--strictPort"],
    { cwd: uiRoot, stdio: ["ignore", "pipe", "pipe"] },
  );
  vite.stdout.on("data", (chunk) => serverLogs.push(String(chunk)));
  vite.stderr.on("data", (chunk) => serverLogs.push(String(chunk)));
  await waitForVite(vite, serverLogs);
  const options = launchOptions();
  browser = await chromium.launch(options);
  report.browser = { version: browser.version(), executablePath: options.executablePath || "playwright-default" };
  for (const matrix of [
    { width: 1380, theme: "light" },
    { width: 1380, theme: "dark" },
    { width: 720, theme: "light" },
  ]) {
    try {
      await runMatrix(browser, matrix);
      if (matrix.width === 1380 && matrix.theme === "light") {
        // 写负例使用独立 context，避免污染真实矩阵的页面/事件状态。
        const requested = new Set([...selfTests].filter((test) => test !== "reduced-write"));
        if (requested.size > 0) {
          const selfContext = await browser.newContext({ viewport: { width: 800, height: 600 } });
          await installReadOnlyFixture(selfContext);
          const selfPage = await selfContext.newPage();
          try {
            await selfPage.goto(`${baseUrl}/#/components`, { waitUntil: "domcontentloaded" });
            await injectWriteSelfTests(selfPage, requested);
          } finally {
            await selfContext.close();
          }
        }
      }
    } catch (error) {
      exitCode = 1;
      report.cases.push({ name: "matrix", status: "failed", matrix, error: error?.message || String(error) });
      report.failures.push({ matrix, message: error?.message || String(error), stack: error?.stack || null });
    }
  }
  try {
    await runReducedMotion(browser);
  } catch (error) {
    exitCode = 1;
    report.cases.push({ name: "reduced-motion", status: "failed", error: error?.message || String(error) });
    report.failures.push({ case: "reduced-motion", message: error?.message || String(error), stack: error?.stack || null });
  }
} catch (error) {
  exitCode = 1;
  report.failures.push({ message: error?.message || String(error), stack: error?.stack || null, serverLogs });
} finally {
  if (browser) await browser.close().catch((error) => report.failures.push({ message: `browser close: ${error.message}` }));
  if (vite) await stopOwnProcess(vite).catch((error) => report.failures.push({ message: `vite cleanup: ${error.message}` }));
  try {
    report.cleanup.portReleased = await waitForPortReleased();
  } catch (error) {
    exitCode = 1;
    report.cleanup.portReleased = false;
    report.failures.push({ message: error?.message || String(error) });
  }
  report.finishedAt = new Date().toISOString();
  if (report.writes.length > 0) {
    exitCode = 1;
    report.failures.push({ case: "read-only-write-gate", message: `检测到 ${report.writes.length} 个写操作`, writes: report.writes });
  }
  report.status = exitCode === 0 && report.failures.length === 0 && report.writes.length === 0 ? "passed" : "failed";
  await writeFile(path.join(outputRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
}

if (report.status === "passed") console.log(`global scrollbar browser regression: PASS (${report.cases.length} cases)`);
else console.error(`global scrollbar browser regression: FAIL\n${report.failures.map((failure) => failure.message).join("\n")}`);
process.exit(exitCode || (report.failures.length > 0 ? 1 : 0));
