import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { NavigationGuardProvider } from "../../app/manage-ui/src/lib/navigation-guard";
import SettingsWeb from "../../app/manage-ui/src/pages/settings/SettingsWeb";
import i18n from "../../app/manage-ui/src/i18n";
import "../../app/manage-ui/src/styles.css";
import "../../app/manage-ui/src/manage-skin.css";
import "../../app/manage-ui/src/pages/SettingsPage.css";
import "../../app/manage-ui/src/pages/settings/SettingsCards.css";
import "../../app/manage-ui/src/pages/settings/SettingsLayout.css";
const state = window as any, calls: any[] = [];
let revision = 0, secretRevision = 0, config = { searchProvider: "exa", fetchProvider: "direct" };
const credentials = Object.fromEntries(["exa", "brave", "tavily", "tinyfish"].map(provider => [provider, { configured: false, revision: null as number | null }]));
state.webSettingsFixture = { calls, i18n, failNext: false };
window.fetch = async (url, options) => {
  const method = options?.method || "GET", body = options?.body ? JSON.parse(String(options.body)) : {};
  calls.push({ url: String(url), method, body });
  if (state.webSettingsFixture.failNext) { state.webSettingsFixture.failNext = false; return new Response(JSON.stringify({ error: "private transport detail", code: "WEB_SETTINGS_CONFLICT" }), { status: 409 }); }
  if (method === "PUT" && String(url).endsWith("credentials")) {
    if (body.expectedRevision !== credentials[body.provider].revision) throw Error("Stale credential");
    credentials[body.provider] = { configured: true, revision: ++secretRevision };
  } else if (method === "DELETE") credentials[body.provider] = { configured: false, revision: null };
  else if (method === "PUT") { if (body.expectedRevision !== revision) throw Error("Stale config"); config = body.config; revision++; }
  return new Response(JSON.stringify({ revision, config, credentials }), { headers: { "Content-Type": "application/json" } });
};
void i18n.changeLanguage("zh-CN");
createRoot(document.getElementById("root")!).render(<MemoryRouter><NavigationGuardProvider>
  <main className="management-page settings-page" style={{ maxWidth: 1040, margin: "0 auto", padding: "24px", boxSizing: "border-box", width: "100%" }}><SettingsWeb /></main>
</NavigationGuardProvider></MemoryRouter>);
