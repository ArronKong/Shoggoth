import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter, Link, Route, Routes } from "react-router-dom";
import ModelsPage from "../../app/manage-ui/src/pages/ModelsPage";
import { UiProvider } from "../../app/manage-ui/src/components/ui";
import { NavigationGuardProvider } from "../../app/manage-ui/src/lib/navigation-guard";
import { applyDisabledBackends } from "../../app/manage-ui/src/lib/backends";
import { runPageRefresh } from "../../app/manage-ui/src/lib/page-refresh";
import { applyConfiguredLocale } from "../../app/manage-ui/src/i18n";
import "../../app/manage-ui/src/styles.css";
import "../../app/manage-ui/src/manage-skin.css";

// Every API call terminates here. This fixture never contacts an installed App,
// a real Gateway, credentials or a model provider.
const counts: Record<string, number> = {};
const receipts = new Map<string, object>();
const configuration = { providers: 0, writes: 0 };
let publish = () => {};
const endpoint = (id: string) => ({ id, name: id, baseUrl: "https://fixture.invalid/v1",
  api: "openai-completions", models: ["shared-model"], model: "shared-model", hasApiKey: false });
let endpoints = [endpoint("xmxm"), endpoint("unused")];
const references = [
  { store: "config", referenceKey: "agents.entries.travelplanner.model.primary" },
  ...Array.from({ length: 10 }, (_, index) => ({ store: "cron", referenceKey: `fixture-cron-${index}` })),
];
const locale = new URLSearchParams(location.search).get("locale") === "en" ? "en" : "zh-CN";
const transport = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
  if (!url.pathname.startsWith("/__api/")) return transport(input, init);
  const backend = url.searchParams.get("backend") || "openclaw";
  const key = `${init?.method ?? "GET"} ${url.pathname} ${backend}`;
  counts[key] = (counts[key] ?? 0) + 1;
  publish();
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body),
    { status, headers: { "Content-Type": "application/json" } });
  if (url.pathname === "/__api/config") return json({ config: { disabledBackends: [], locale } });
  if (url.pathname === "/__api/backends") return json({ backends: [] });
  if (url.pathname === "/__api/models/config/capabilities") return json({ supported: false,
    providerDirectory: backend === "openclaw", perAgentModelSettings: backend === "hermes",
    blockers: ["runtime_apply_unsupported"], configWrite: { supported: true, create: true, update: true,
      delete: true, updateProvider: true, batch: true, blockers: [] } });
  if (url.pathname === "/__api/models/config/pending-identities") return json({ version: 1, backendId: backend, operations: [] });
  if (url.pathname === "/__api/models/config/operation") return json(receipts.get(url.searchParams.get("operationId") || "")
    ?? { version: 1, backendId: backend, operationId: url.searchParams.get("operationId"),
      providerKey: url.searchParams.get("provider"), status: "not_found", stage: "observe", terminal: false });
  if (url.pathname === "/__api/models/provider-directory") {
    await new Promise(resolve => setTimeout(resolve, 900));
    return json({ supported: true, providers: [] });
  }
  if (url.pathname === "/__api/oauth") {
    await new Promise(resolve => setTimeout(resolve, 300));
    return json({ providers: [{ id: "fixture", name: "Fixture Account", flow: "external",
      status: { loggedIn: false, expiresAt: null }, disconnectable: false }], profiles: [] });
  }
  if (url.pathname === "/__api/env") return json({ vars: [] });
  if (url.pathname === "/__api/models/endpoints") {
    await new Promise(resolve => setTimeout(resolve, 600));
    return json({ supported: true, endpoints: backend === "openclaw" ? endpoints : [endpoint("hermes-fixture")],
      form: { nameIsProviderId: true, nameEditable: false, providerIdEditable: true, firstModelIsDefault: false,
        batchModelSelection: true, allowPrimaryModelRemoval: true, apiOptions: ["openai-completions"] } });
  }
  if (url.pathname === "/__api/models/endpoints/validate") return json({ ok: true, reachable: true, models: ["shared-model"] });
  if (url.pathname === "/__api/models/config" && init?.method === "DELETE") {
    const provider = url.searchParams.get("provider");
    const operationId = url.searchParams.get("operationId") || "";
    if (provider === "xmxm" || provider === "unused") receipts.set(operationId, { version: 1, backendId: backend,
      operationId, providerKey: provider, status: provider === "xmxm" ? "failed" : "applied",
      stage: provider === "xmxm" ? "preflight" : "config-write", terminal: true,
      ...(provider === "xmxm" ? { code: "primary_model_in_use" } : {}) });
    if (provider === "xmxm") return json({ status: "blocked", code: "primary_model_in_use", stage: "preflight",
      canForce: false, references, blockers: [{ code: "references_exist" }, { code: "primary_model_in_use" }] }, 409);
    if (provider !== "unused") return json({ error: "fixture_scope" }, 400);
    endpoints = endpoints.filter(item => item.id !== provider);
    configuration.writes += 1; publish();
    return json({ status: "applied", stage: "config-write", operationId: url.searchParams.get("operationId") });
  }
  // An unused catalog must never delay the provider page.
  if (url.pathname === "/__api/models") {
    await new Promise(resolve => setTimeout(resolve, 5_000));
    return json({ models: [], catalogRevision: "fixture" });
  }
  return json({ error: `Unexpected fixture API: ${url.pathname}` }, 404);
};
applyDisabledBackends([]);
await applyConfiguredLocale(locale);
document.documentElement.dataset.theme = "light";

function Fixture() {
  const [, redraw] = useState(0);
  publish = () => redraw(value => value + 1);
  return <HashRouter><UiProvider><NavigationGuardProvider>
    <aside style={{ padding: 16, borderBottom: "1px solid var(--ui-hairline)" }}>
      <p>隔离验证 · 配置和任务均为合成数据 · 真实 Provider 调用 0</p>
      <nav style={{ display: "flex", gap: 20, marginBottom: 8 }}>
        <Link to="/models">模型页</Link><Link to="/away">其他页面</Link>
        <button className="ui-cbtn" onClick={() => void runPageRefresh("/models")}>手动刷新</button>
      </nav>
      <output style={{ display: "block", fontSize: 12, overflowWrap: "anywhere" }}>
        {JSON.stringify({ requests: counts, fixtureWrites: configuration.writes })}
      </output>
    </aside>
    <main className="page management-page" style={{ margin: "0 auto", maxWidth: 1120, padding: 24 }}>
      <Routes><Route path="/models" element={<ModelsPage />} /><Route path="*" element={<p>其他页面；模型页已卸载。</p>} /></Routes>
    </main>
  </NavigationGuardProvider></UiProvider></HashRouter>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
