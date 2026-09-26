import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import ModelAccounts from "../../app/manage-ui/src/pages/models/ModelAccounts";
import ShoggothCustomEndpointPanel from "../../app/manage-ui/src/pages/models/ShoggothCustomEndpointPanel";
import { ShoggothProviderSetup } from "../../app/manage-ui/src/components/ShoggothProviderSetup";
import { UiProvider } from "../../app/manage-ui/src/components/ui";
import { applyConfiguredLocale } from "../../app/manage-ui/src/i18n";
import type { BackendDescriptor, CustomEndpoint, ShoggothProviderConfiguration, ShoggothProviderSnapshot } from "../../app/manage-ui/src/types";
import "../../app/manage-ui/src/styles.css";
import "../../app/manage-ui/src/manage-skin.css";

const params = new URLSearchParams(location.search);
const agent = params.get("view") === "agent";
const fail = params.get("scenario") === "failure";
const existing = params.get("scenario") === "existing";
const locale = params.get("lang") === "en" ? "en" : "zh-CN";
const profileId = agent ? "profile-second" : "profile-default";
let snapshot: ShoggothProviderSnapshot = {
  profile: { id: profileId, name: agent ? "研究助理" : "Shoggoth", isDefault: !agent,
    configuredProviderId: existing ? "provider-custom-existing" : null, defaultModel: existing ? "example-model" : "gpt-example", ready: true },
  providers: [{ id: "chatgpt", kind: "chatgpt", displayName: "ChatGPT", authState: "authenticated", authSource: "native-codex" },
    ...(existing ? [{ id: "provider-custom-existing", kind: "custom-responses", displayName: "Custom Responses",
      baseUrl: "https://gateway.example:8443/openai/v1", baseUrlHost: "gateway.example:8443",
      defaultModel: "example-model", authState: "configured", validationStatus: "protocol_valid" }] : []),
    { id: "other-profile-provider", kind: "custom-responses", displayName: "Other assistant",
      baseUrl: "https://other-assistant.example/v1", baseUrlHost: "other-assistant.example",
      defaultModel: "other-model", authState: "configured" }],
};
let endpoints: CustomEndpoint[] = existing ? [
  { id: "provider-custom-existing", name: "gateway", baseUrl: "https://gateway.example:8443/openai/v1", model: "example-model", models: ["example-model", "example-small"], api: "openai-responses", hasApiKey: true, discoverModels: false },
  { id: "local", name: "local", baseUrl: "http://localhost:11434/v1", model: "local-model", models: ["local-model"], api: "openai-responses", hasApiKey: false, discoverModels: false },
  { id: "research", name: "research", baseUrl: "https://research.example/v1", model: "reasoning-model", models: ["reasoning-model"], api: "openai-responses", hasApiKey: true, discoverModels: false },
] : [];
const endpointSnapshot = () => ({ supported: true, profiles: [snapshot.profile!.name], endpoints: endpoints.map(endpoint => ({ ...endpoint,
  profiles: [snapshot.profile!.name], activeIn: snapshot.profile!.configuredProviderId === endpoint.id ? [snapshot.profile!.name] : [] })),
  form: { apiOptions: ["openai-responses"], defaultApi: "openai-responses", nameEditable: false, firstModelIsDefault: true } });
let calls = 0;
let discoveryCalls = 0;
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json" },
});
const record = (action: string, profile: string | null, id?: string) => {
  calls += 1;
  document.getElementById("preview-result")!.textContent = JSON.stringify({ action, calls, profileId: profile, providerId: id });
};
// All requests stay in memory; neither installed Service nor external APIs are contacted.
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin);
  switch (url.pathname) {
    case "/__api/models/endpoints": {
      if (!init?.method || init.method === "GET") return response(endpointSnapshot());
      if (init.method === "DELETE") {
        const id = url.searchParams.get("id")!;
        record("delete", url.searchParams.get("profile"), id);
        endpoints = endpoints.filter(endpoint => endpoint.id !== id);
        if (snapshot.profile?.configuredProviderId === id) snapshot.profile = { ...snapshot.profile, configuredProviderId: null, defaultModel: null };
        return response(endpointSnapshot());
      }
      const body = JSON.parse(String(init.body));
      record("save", body.profile, body.id);
      if (body.profile !== profileId) return response({ error: "Wrong Profile" }, 400);
      if (fail) return response({ error: "Fixture save failure" }, 409);
      const old = endpoints.find(endpoint => endpoint.id === body.id);
      const endpoint = { ...body, hasApiKey: Boolean(body.apiKey || old?.hasApiKey), discoverModels: false, api: "openai-responses" };
      delete endpoint.apiKey;
      endpoints = [...endpoints.filter(endpoint => endpoint.id !== body.id), endpoint];
      snapshot = { ...snapshot, profile: { ...snapshot.profile!, configuredProviderId: body.id, defaultModel: body.models[0], ready: true } };
      document.getElementById("preview-models")!.textContent = JSON.stringify({ model: body.models[0], models: body.models });
      return response(endpointSnapshot());
    }
    case "/__api/models/endpoints/validate": {
      const body = JSON.parse(String(init?.body));
      discoveryCalls += 1;
      document.getElementById("preview-discovery")!.textContent = `模型目录请求：${discoveryCalls} 次（仅内存模拟）`;
      // Intentionally ignore AbortSignal here: stale responses must still be
      // discarded after the user edits a URL/key or closes the modal.
      await new Promise(resolve => setTimeout(resolve, body.baseUrl.includes("slow") ? 1800 : 80));
      if (body.apiKey === "invalid-key") return response({ ok: false, reachable: true, code: "authentication_failed", models: [] });
      if (body.baseUrl.includes("unavailable")) return response({ ok: false, reachable: true, code: "catalog_unavailable", models: [] });
      if (body.baseUrl.includes("empty")) return response({ ok: true, reachable: true, models: [] });
      const models = body.baseUrl.includes("slow") ? ["stale-model"]
        : body.baseUrl.includes("many") ? Array.from({ length: 40 }, (_, i) => `example-model-${i + 1}`)
          : ["example-small", "example-large", "example-reasoning"];
      return response({ ok: true, reachable: true, message: "", models });
    }
    case "/__api/shoggoth/status": return response({ service: { healthy: true }, background: {} });
    case "/__api/oauth": return response({ providers: [], profiles: [] });
    case "/__api/shoggoth/providers": return response(snapshot);
    case "/__api/shoggoth/chatgpt/models": return response({ models: [
      { id: "gpt-example", displayName: "Example GPT", description: "Isolated fixture", isDefault: true },
    ] });
    case "/__api/shoggoth/providers/configure": {
      const body = JSON.parse(String(init?.body)) as ShoggothProviderConfiguration;
      record("configure", body.profileId, body.provider.id);
      if (body.profileId !== profileId) return response({ code: "WRONG_PROFILE" }, 400);
      if (fail) return response({ code: "PROVIDER_PROTOCOL_CONFIG_INVALID", error: "Fixture save failure" }, 400);
      const provider = { id: body.provider.id, kind: body.provider.kind, displayName: body.provider.name,
        baseUrl: body.provider.baseUrl || undefined, baseUrlHost: body.provider.baseUrl ? new URL(body.provider.baseUrl).host : undefined,
        defaultModel: body.provider.model, authState: "configured", validationStatus: "protocol_valid" };
      snapshot = { profile: { ...snapshot.profile!, configuredProviderId: provider.id, defaultModel: provider.defaultModel, ready: true },
        providers: [...snapshot.providers.filter((entry) => entry.id !== provider.id), provider] };
      return response({ profile: snapshot.profile, provider });
    }
    case "/__api/shoggoth/providers/clear": {
      const body = JSON.parse(String(init?.body));
      record("clear", body.profileId);
      if (body.profileId !== profileId) return response({ code: "WRONG_PROFILE" }, 400);
      snapshot = { ...snapshot, profile: { ...snapshot.profile!, configuredProviderId: null, defaultModel: null, ready: true } };
      return response({ profile: snapshot.profile });
    }
    default: return response({ error: `Unavailable in isolated preview: ${url.pathname}` }, 501);
  }
};

function Preview() {
  const [current, setCurrent] = useState(snapshot);
  const refresh = () => setCurrent({ ...snapshot });
  return <UiProvider>
    <aside style={{ padding: "12px 40px", borderBottom: "1px solid var(--ui-hairline)", fontSize: 12 }}>
      Shoggoth 自定义端口 · 隔离预览　
      <a href="/">模型页</a>　<a href="/?scenario=existing">已有配置</a>　
      <a href="/?view=agent">独立助理</a>　<a href="/?scenario=failure">保存失败</a>
      <output id="preview-result" style={{ display: "block", marginTop: 8 }}>尚无配置请求</output>
      <output id="preview-models" style={{ display: "block" }}>尚未保存模型选择</output>
      <output id="preview-discovery" style={{ display: "block", marginTop: 4 }}>尚无模型目录请求</output>
    </aside>
    <main className="page management-page" style={{ minHeight: "100vh" }}>
      <div className="page-head"><div><h1>{agent ? "研究助理 · 概览" : "模型"}</h1><p>Shoggoth</p></div></div>
      {agent ? <div style={{ display: "grid", gap: 24 }}>
        <ShoggothProviderSetup snapshot={current} profileId={profileId} onConfigured={refresh} />
        <ShoggothCustomEndpointPanel snapshot={current} profileId={profileId} onConfigured={refresh} />
      </div> : <ModelAccounts backend={{ id: "shoggoth", name: "Shoggoth" } as BackendDescriptor}
        refreshKey={0} onChanged={refresh} />}
    </main>
  </UiProvider>;
}
await applyConfiguredLocale(locale);
createRoot(document.getElementById("root")!).render(<React.StrictMode><Preview /></React.StrictMode>);
