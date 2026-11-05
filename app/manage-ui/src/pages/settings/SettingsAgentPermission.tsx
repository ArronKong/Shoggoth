import { useTranslation } from "react-i18next";
import type { AppConfig, GlobalPermissionMode } from "../../types";
import {
  GLOBAL_PERMISSION_MODES,
  GLOBAL_PERMISSION_MODE_TEXT,
  normalizeGlobalPermissionMode,
} from "../../lib/globalPermissionMode";
import s from "./SettingsAgentPermission.module.css";

// One permission choice for every Agent chat. The chat composer no longer
// offers a per-conversation picker; each runtime maps this to its own options.
export default function SettingsAgentPermission({ cfg, onChange, disabled }: {
  cfg: AppConfig;
  onChange: (patch: Partial<AppConfig>) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const selected = normalizeGlobalPermissionMode(cfg.chatPermissionMode);
  const select = (mode: GlobalPermissionMode) => {
    if (!disabled && mode !== selected) onChange({ chatPermissionMode: mode });
  };
  return (
    <section className="settings-section" id="settings-agent-permission" aria-labelledby="settings-agent-permission-title">
      <header className="settings-section-head">
        <h3 className="settings-h" id="settings-agent-permission-title">{t("settings.agentPermission.title")}</h3>
        <p className="settings-sech">{t("settings.agentPermission.description")}</p>
      </header>
      <div className="settings-card settings-list-card">
        <div className={s.options} role="radiogroup" aria-labelledby="settings-agent-permission-title">
          {GLOBAL_PERMISSION_MODES.map((mode) => {
            const text = GLOBAL_PERMISSION_MODE_TEXT[mode];
            const checked = mode === selected;
            return (
              <label key={mode} className={checked ? `${s.option} ${s.active}` : s.option} data-risk={text.risk} data-mode={mode}>
                <input
                  type="radio"
                  name="settings-agent-permission"
                  value={mode}
                  checked={checked}
                  disabled={disabled}
                  onChange={() => select(mode)}
                />
                <span className={s.copy}>
                  <span className={s.name}>{t(`chat.permissionModes.${text.label}`)}</span>
                  <span className={s.description}>{t(`chat.permissionModes.${text.description}`)}</span>
                </span>
                <span className={s.check} aria-hidden="true">{checked ? "✓" : ""}</span>
              </label>
            );
          })}
        </div>
        <p className={`ui-hint ${s.hint}`}>{t("settings.agentPermission.hint")}</p>
      </div>
    </section>
  );
}
