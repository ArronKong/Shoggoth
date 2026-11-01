import React from "react";
import { createRoot } from "react-dom/client";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import AppleDeviceConnectors from "../../app/manage-ui/src/components/AppleDeviceConnectors";
import en from "../../app/manage-ui/src/i18n/locales/en";
import zhCN from "../../app/manage-ui/src/i18n/locales/zh-CN";
import "../../app/manage-ui/src/styles.css";
import pageStyle from "../../app/manage-ui/src/pages/ConnectorsPage.module.css";

// Isolated rendering fixture: product component, CSS and API client; fixture-only REST data.
const input = new URLSearchParams(location.search), locale = input.get("locale") === "en" ? "en" : "zh-CN";
document.documentElement.dataset.theme = input.get("theme") === "dark" ? "dark" : "light";
document.documentElement.lang = locale;
await i18next.init({ lng: locale, resources: { en: { translation: en }, "zh-CN": { translation: zhCN } }, interpolation: { escapeValue: false } });
document.body.style.background = "var(--ui-canvas)";
createRoot(document.getElementById("root")!).render(<I18nextProvider i18n={i18next}><main className={pageStyle.page} style={{ margin: "24px auto", width: "calc(100% - 32px)" }}>
  <h1 style={{ margin: "0 0 4px", fontSize: 24 }}>{locale === "en" ? "Connectors" : "连接器"}</h1>
  <p style={{ margin: 0, fontSize: 12, color: "var(--ui-text-2)" }}>{locale === "en" ? "Isolated component rendering fixture · synthetic data" : "独立组件渲染夹具 · 模拟数据"}</p>
  <div className={pageStyle.contentCard}><AppleDeviceConnectors /></div>
</main></I18nextProvider>);
