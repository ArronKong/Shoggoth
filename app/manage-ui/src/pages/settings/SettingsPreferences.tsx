import type { Dispatch, SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import type { AppConfig } from "../../types";
import { Field, Option, Select, Switch } from "../../components/Field";
import { useToast } from "../../components/ui";
import { fireNotification } from "../../lib/notify";
import { applyTheme } from "../../lib/theme";
import ThemePicker from "./ThemePicker";
import SettingsDesktopPrinter from "./SettingsDesktopPrinter";

// Keep the theme preference and picker implementation available for a later
// re-enable, but do not expose theme switching in Settings for now.
const SHOW_THEME_PICKER = false;

export default function SettingsPreferences({ cfg, setCfg, disabled, themeLoaded }: {
  cfg: AppConfig;
  setCfg: Dispatch<SetStateAction<AppConfig>>;
  disabled: boolean;
  themeLoaded: boolean;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  return (
    <div className="settings-preferences">
      {/* Common preferences stay together and are visible on first entry. */}
      <section className="settings-section" id="settings-appearance">
        <header className="settings-section-head">
          <h3 className="settings-h">{t("settings.appearanceSection")}</h3>
          <p className="settings-sech">{t("settings.appearanceSectionDesc")}</p>
        </header>
        <div className="settings-card">
          <div className="settings-prefs-row">
            {SHOW_THEME_PICKER && (
              <ThemePicker
                value={cfg.theme}
                disabled={disabled || !themeLoaded}
                onChange={(theme) => {
                  setCfg({ ...cfg, theme });
                  applyTheme(theme);
                }}
              />
            )}
            <Field label={t("settings.langLabel")} hint={t("settings.langHint")}>
              <Select disabled={disabled} value={cfg.locale} onChange={(v) => setCfg({ ...cfg, locale: v })}>
                <Option value="">{t("settings.langAuto")}</Option>
                <Option value="zh-CN">简体中文</Option>
                <Option value="en">English</Option>
              </Select>
            </Field>
          </div>
        </div>
      </section>

      <SettingsDesktopPrinter disabled={disabled} />

      {/* Notifications — native macOS desktop notifications, per category */}
      <section className="settings-section" id="settings-notif">
        <header className="settings-section-head">
          <h3 className="settings-h">{t("settings.notifSection")}</h3>
          <p className="settings-sech">{t("settings.notifSectionDesc")}</p>
        </header>
        <div className="settings-card">
          <div className="settings-switch-list">
            <div className="settings-switch-row">
              <Switch
                disabled={disabled}
                checked={cfg.notifications.chat}
                onChange={(v) => setCfg({ ...cfg, notifications: { ...cfg.notifications, chat: v } })}
                label={<span className="settings-notification-copy"><span>{t("settings.notifChat")}</span><small>{t("settings.notifChatDesc")}</small></span>}
              />
            </div>
            <div className="settings-switch-row">
              <Switch
                disabled={disabled}
                checked={cfg.notifications.cron}
                onChange={(v) => setCfg({ ...cfg, notifications: { ...cfg.notifications, cron: v } })}
                label={<span className="settings-notification-copy"><span>{t("settings.notifCron")}</span><small>{t("settings.notifCronDesc")}</small></span>}
              />
            </div>
            <div className="settings-switch-row">
              <Switch
                disabled={disabled}
                checked={cfg.notifications.task}
                onChange={(v) => setCfg({ ...cfg, notifications: { ...cfg.notifications, task: v } })}
                label={<span className="settings-notification-copy"><span>{t("settings.notifTask")}</span><small>{t("settings.notifTaskDesc")}</small></span>}
              />
            </div>
          </div>
          <p className="ui-hint">{t("settings.notifHint")}</p>
          <div className="settings-actions">
            <button
              className="ui-cbtn ui-cbtn--sm"
              onClick={async () => {
                const sent = await fireNotification({ category: "chat", title: t("notif.testTitle"), body: t("notif.testBody"), force: true });
                if (sent) toast.success(t("settings.notifTestOk"));
                else toast.error(t("settings.notifTestFailed"));
              }}
            >
              {t("settings.notifTest")}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
