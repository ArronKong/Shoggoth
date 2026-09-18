import React, { lazy, Suspense } from "react";
import ReactDOM from "react-dom/client";
import { HashRouter } from "react-router-dom";
import App from "./App";
import { UiProvider } from "./components/ui";
import { applyConfiguredLocale } from "./i18n";
import "./styles.css";
// 管理面聊天质感皮肤（R68）：靠 import 顺序覆盖 styles.css，须在其后。
import "./manage-skin.css";
// Imported last so debug-inspector tweaks (设置 → 调试 → 保存到源码) win on source order.
import "./debug-overrides.css";
import { initThemeFromCache, setTheme } from "./lib/theme";
import { getConfig } from "./api/client";
import { NavigationGuardProvider } from "./lib/navigation-guard";
import { loadInspirationFonts } from "./pages/inspiration-fonts";
const DesktopInspiration = lazy(async () => {
  const page = await import("./pages/DesktopInspiration");
  await loadInspirationFonts();
  return page;
});
const desktopInspiration = window.location.hash.split('?')[0] === '#/desktop-inspiration';
if (desktopInspiration) document.documentElement.setAttribute('data-desktop-inspiration', '');

// Apply the cached theme before first render (index.html already seeded the
// attribute pre-paint); then re-sync from config — the source of truth.
async function bootstrap() {
  initThemeFromCache();
  try {
    const config = await getConfig();
    setTheme(config.theme || "system");
    await applyConfiguredLocale(config.locale);
  } catch {
    // Config 不可读时沿用 HTML/cache 已建立的主题与语言，页面仍然可用。
  }

  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <HashRouter>
        <NavigationGuardProvider>
          <UiProvider>
            {desktopInspiration ? <Suspense fallback={null}><DesktopInspiration /></Suspense> : <App />}
          </UiProvider>
        </NavigationGuardProvider>
      </HashRouter>
    </React.StrictMode>,
  );
}

void bootstrap();
