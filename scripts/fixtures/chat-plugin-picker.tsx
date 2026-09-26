import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import ChatPluginPicker, { type ChatPluginSelection } from "../../app/manage-ui/src/pages/ChatPluginPicker";
import { applyConfiguredLocale } from "../../app/manage-ui/src/i18n";
import "../../app/manage-ui/src/styles.css";
import "../../app/manage-ui/src/manage-skin.css";

const scope = window as any;
scope.fixtureErrors = [];
window.addEventListener("error", event => scope.fixtureErrors.push(event.message));
window.addEventListener("unhandledrejection", event => scope.fixtureErrors.push(String(event.reason)));
const rows = [
  { installationId: "alpha", revision: 2, packageName: "Alpha 设计工具", desiredState: "enabled", components: [{ title: "Design", kind: "skill", state: "ready" }] },
  { installationId: "beta", revision: 3, packageName: "Beta", desiredState: "enabled", components: [{ title: "Search", kind: "mcp-server", state: "connection_required" }] },
  { installationId: "disabled", revision: 4, packageName: "Disabled", desiredState: "disabled", components: [{ title: "Old", kind: "skill", state: "installed_inactive" }] },
  { installationId: "empty", revision: 5, packageName: "No capability", desiredState: "enabled", components: [] },
  { installationId: "stuck", revision: 7, packageName: "Stuck", desiredState: "enabled", components: [{ title: "Inactive", kind: "skill", state: "installed_inactive" }] },
  { installationId: "omega", revision: 6, packageName: "Omega long plugin name that must not force horizontal scrolling", desiredState: "enabled", components: [{ title: "Writer", kind: "skill", state: "ready" }] },
];
scope.fixtureReads = [];
window.fetch = async input => {
  const route = String(input);
  scope.fixtureReads.push(route);
  let body: unknown;
  if (route.startsWith("/__api/plugins?")) {
    const params = new URL(route, "https://fixture.invalid").searchParams;
    const cursor = Number(params.get("cursor"));
    body = { page: { supported: true, catalogRevision: "fixed-revision", items: rows.slice(cursor, cursor + 3),
      nextCursor: cursor + 3 < rows.length ? cursor + 3 : null } };
  } else if (route === "/__api/plugins/bundled") {
    body = { batchDigest: "fixture", items: [{ id: "alpha", installationId: "alpha",
      displayName: "Alpha 设计工具", shortDescription: "A converted Skill and an unadapted connector",
      category: "Design", version: "1.0.0", iconAvailable: false,
      components: { skills: 1, mcp: 0, apps: 1 }, converted: { skills: 1, mcp: 0 },
      unconvertedMcp: [], importStatus: "previewable", installationState: "enabled" }] };
  } else throw Error(`unexpected request: ${route}`);
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
};
applyConfiguredLocale("zh-CN");
function Fixture() {
  const [selected, setSelected] = useState<ChatPluginSelection[]>([]);
  return <main style={{ maxWidth: 860, margin: "0 auto", padding: "450px 16px 24px" }}>
    <div id="normal"><ChatPluginPicker sessionKey="agent:shoggoth:one" backendId="shoggoth"
      selected={selected} onChange={setSelected} onBrowse={id => { scope.browsed = id ?? "catalog"; }} /></div>
    <div id="immersive" style={{ marginTop: 28, color: "#eee", background: "#252932", padding: 16, borderRadius: 16 }}>
      <ChatPluginPicker sessionKey="agent:shoggoth:one" backendId="shoggoth"
        selected={selected} onChange={setSelected} onBrowse={id => { scope.browsed = id ?? "catalog"; }} />
    </div>
    <div id="external" style={{ marginTop: 28 }}><ChatPluginPicker sessionKey="agent:hermes:one"
      backendId="hermes" selected={[]} onChange={() => { throw Error("external picker changed"); }}
      onBrowse={() => {}} /></div>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
const pause = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));
async function wait(predicate: () => unknown) {
  const deadline = Date.now() + 4000;
  while (!predicate()) { if (Date.now() > deadline) throw Error("picker fixture timeout"); await pause(); }
}
scope.runChatPluginPickerFixture = async () => {
  await wait(() => document.querySelector<HTMLButtonElement>("#normal button")?.textContent?.includes("插件"));
  const trigger = document.querySelector<HTMLButtonElement>("#normal button")!;
  if (!document.querySelector<HTMLButtonElement>("#external button")?.disabled) throw Error("external host must fail closed");
  trigger.click();
  await wait(() => document.querySelectorAll("#normal label").length === 5);
  const labels = Array.from(document.querySelectorAll<HTMLLabelElement>("#normal label"));
  if (!labels.find(label => label.textContent?.includes("Alpha 设计工具"))?.textContent?.includes("连接器待适配"))
    throw Error("partially available package hides its unadapted connector");
  if (labels.some(label => label.textContent?.includes("No capability"))) throw Error("empty package selectable");
  if (!labels.find(label => label.textContent?.includes("Disabled"))?.querySelector("input")?.disabled)
    throw Error("disabled package selectable");
  const disconnected = labels.find(label => label.textContent?.includes("Beta"));
  if (!disconnected?.querySelector("input")?.disabled || !disconnected.textContent?.includes("连接账号"))
    throw Error("disconnected MCP package selectable or missing setup status");
  const inactive = labels.find(label => label.textContent?.includes("Stuck"));
  if (!inactive?.querySelector("input")?.disabled || !inactive.textContent?.includes("没有可用组件"))
    throw Error("inactive package selectable or presented as an account setup");
  labels[0]!.querySelector<HTMLInputElement>("input")!.click();
  await wait(() => document.querySelector("#immersive")?.textContent?.includes("Alpha 设计工具"));
  if (!scope.fixtureReads.some((read: string) => read.includes("cursor=3"))) throw Error("catalog pagination missing");
  const search = document.querySelector<HTMLInputElement>("#normal input[type=search]")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(search, "Omega"); search.dispatchEvent(new Event("input", { bubbles: true }));
  await wait(() => document.querySelectorAll("#normal label").length === 1);
  search.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await wait(() => !document.querySelector("#normal [role=dialog]"));
  trigger.click();
  await wait(() => !!document.querySelector("#normal [role=dialog]"));
  const searchAgain = document.querySelector<HTMLInputElement>("#normal input[type=search]")!;
  setter.call(searchAgain, ""); searchAgain.dispatchEvent(new Event("input", { bubbles: true }));
  await wait(() => document.querySelectorAll("#normal label").length === 5);
  const prepare = Array.from(document.querySelectorAll<HTMLButtonElement>("#normal [role=dialog] button"))
    .find(button => button.textContent?.includes("前往插件页设置"));
  if (!prepare) throw Error("unavailable MCP setup action missing");
  prepare?.click();
  await wait(() => scope.browsed === "beta" && !document.querySelector("#normal [role=dialog]"));
  trigger.click();
  await wait(() => !!document.querySelector("#normal [role=dialog]"));
  return { sharedSelection: true, pagination: true, disabledHost: true,
    unavailableMcp: true, setupRoute: true, keyboardClose: true };
};
scope.captureChatPluginPicker = (theme: string) => {
  document.documentElement.dataset.theme = theme;
  const panel = document.querySelector("#normal [role=dialog]")!.getBoundingClientRect();
  return { theme, width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
    panel: { left: panel.left, right: panel.right, top: panel.top, bottom: panel.bottom },
    errors: scope.fixtureErrors };
};
