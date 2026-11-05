import { useTranslation } from "react-i18next";
import type { AppConfig } from "../../types";
import { Field, Option, Select, Switch } from "../../components/Field";
import ThemePicker from "./ThemePicker";
import AppIconPicker from "./AppIconPicker";
import SettingsDesktopPrinter from "./SettingsDesktopPrinter";
import SettingsAppUpdate from "./SettingsAppUpdate";
import SettingsAgentPermission from "./SettingsAgentPermission";
import { SettingsIcon } from "./SettingsIcons";

// Keep the theme preference and picker implementation available for a later
// re-enable, but do not expose theme switching in Settings for now.
const SHOW_THEME_PICKER = false;


export default function SettingsPreferences({ cfg, onChange, disabled, themeLoaded }: {
  cfg: AppConfig;
  onChange: (patch: Partial<AppConfig>) => void;
  disabled: boolean;
  themeLoaded: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="settings-preferences">
      <section className="settings-section settings-preferences-main" id="settings-general" aria-labelledby="settings-general-title">
        <header className="settings-section-head">
          <h3 className="settings-h" id="settings-general-title">{t("settings.category.general")}</h3>
          <p className="settings-sech">{t("settings.generalDesc")}</p>
        </header>
        <div className="settings-card settings-list-card">
          <div className="settings-list-row settings-list-row--icon" id="settings-appearance">
            <SettingsIcon name="language" />
            <div className="settings-prefs-row">
              {SHOW_THEME_PICKER && (
                <ThemePicker
                  value={cfg.theme}
                  disabled={disabled || !themeLoaded}
                  onChange={(theme) => onChange({ theme })}
                />
              )}
              <Field label={t("settings.langLabel")} hint={t("settings.langHint")}>
                <Select disabled={disabled} value={cfg.locale} onChange={(v) => onChange({ locale: v })}>
                  <Option value="">{t("settings.langAuto")}</Option>
                  <Option value="zh-CN">简体中文</Option>
                  <Option value="en">{t("settings.copy.languageEnglish")}</Option>
                </Select>
              </Field>
            </div>
          </div>
          <AppIconPicker value={cfg.appIcon} disabled={disabled} onChange={(appIcon) => onChange({ appIcon })} />
          <SettingsDesktopPrinter disabled={disabled} />
        </div>
      </section>

      <SettingsAgentPermission cfg={cfg} onChange={onChange} disabled={disabled} />

      {/* Notifications — native macOS desktop notifications. */}
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
                onChange={(v) => onChange({ notifications: { ...cfg.notifications, chat: v } })}
                label={<span className="settings-notification-label"><SettingsIcon name="chat" /><span className="settings-notification-copy"><span>{t("settings.notifChat")}</span><small>{t("settings.notifChatDesc")}</small></span></span>}
              />
            </div>
            <div className="settings-switch-row">
              <Switch
                disabled={disabled}
                checked={cfg.notifications.cron && cfg.notifications.task}
                onChange={(v) => onChange({ notifications: { ...cfg.notifications, cron: v, task: v } })}
                label={<span className="settings-notification-label"><SettingsIcon name="task" /><span className="settings-notification-copy"><span>{t("settings.notifTask")}</span><small>{t("settings.notifTaskDesc")}</small></span></span>}
              />
            </div>
          </div>
          <div className="settings-notification-footer">
            <p className="ui-hint">{t("settings.notifHint")}</p>
          </div>
        </div>
      </section>

      <section className="settings-section" id="settings-updates" aria-label={t("settings.appUpdate.title")}>
        <div className="settings-card settings-list-card">
          <SettingsAppUpdate />
        </div>
      </section>
    </div>
  );
}
