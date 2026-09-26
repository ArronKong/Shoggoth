// i18n bootstrap for the React control plane (react-i18next).
//
// Locale source of truth: config.locale. Preload seeds its boot cache in
// localStorage["openclaw.i18n.locale"] (REMOVED for follow-system, so navigator wins).
// This reuses the existing desktop plumbing — preload was already seeding that
// key for the old skin UI's i18n; this module is the consumer the R7 teardown
// removed and never rebuilt.
//
// zh-CN is the source language; en is the translation (typed against zh-CN so
// tsc flags any missing/extra key). SettingsPage applies the saved locale live;
// bootstrap re-applies it before the first React render on the next launch.

import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import zhCN from "./locales/zh-CN";
import en from "./locales/en";
import { slashDescriptionResources } from "./slashDescriptions";

export const I18N_LOCALE_KEY = "openclaw.i18n.locale";
type SupportedLocale = "zh-CN" | "en";

function systemLocale(): SupportedLocale {
  const sys = (navigator.language || "").toLowerCase();
  return sys.startsWith("zh") ? "zh-CN" : "en";
}

export function resolveInitialLng(): SupportedLocale {
  try {
    const seeded = localStorage.getItem(I18N_LOCALE_KEY);
    if (seeded === "zh-CN" || seeded === "en") return seeded;
  } catch {
    /* localStorage unavailable — fall through to navigator */
  }
  return systemLocale();
}

const initialLng = resolveInitialLng();

void i18next.use(initReactI18next).init({
  resources: {
    "zh-CN": { translation: zhCN, slashCommands: slashDescriptionResources["zh-CN"] },
    en: { translation: en, slashCommands: slashDescriptionResources.en },
  },
  lng: initialLng,
  fallbackLng: "zh-CN",
  supportedLngs: ["zh-CN", "en"],
  interpolation: { escapeValue: false }, // React already escapes
  react: { useSuspense: false }, // resources are bundled + synchronous
});

// Keep <html lang> in sync with the active locale. index.html hard-codes
// lang="zh"; without this the attribute never tracks an `en` switch (a11y/SEO,
// and any :lang() CSS hook). Set on boot + on every runtime language change.
function syncHtmlLang(lng: string) {
  try {
    document.documentElement.lang = lng;
  } catch {
    /* no document (non-browser context) — ignore */
  }
}
i18next.on("languageChanged", syncHtmlLang);
syncHtmlLang(initialLng);

// Electron preload 会先写 localStorage；standalone 浏览器没有 preload，必须在首个
// React render 前把 config.locale 应用到同一缓存与 i18next，避免一直沿用旧缓存/系统值。
export async function applyConfiguredLocale(locale: string | null | undefined): Promise<void> {
  const configured = locale === "zh-CN" || locale === "en" ? locale : null;
  try {
    if (configured) localStorage.setItem(I18N_LOCALE_KEY, configured);
    else localStorage.removeItem(I18N_LOCALE_KEY);
  } catch {
    /* localStorage unavailable — runtime language still follows config/system */
  }
  const next = configured || systemLocale();
  await i18next.changeLanguage(next);
  syncHtmlLang(next);
}

export default i18next;
