import { useTranslation } from "react-i18next";
import type { ThemePref } from "../../lib/theme";
import "./ThemePicker.css";

const THEMES = ["light", "dark", "system"] as const;

export default function ThemePicker({ value, onChange, disabled }: {
  value: ThemePref;
  onChange: (theme: ThemePref) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const labels = {
    light: t("settings.themeLight"),
    dark: t("settings.themeDark"),
    system: t("settings.themeSystem"),
  };

  return (
    <fieldset className="settings-themes" disabled={disabled} aria-describedby="settings-theme-hint">
      <legend className="field-label">{t("settings.themeLabel")}</legend>
      <div className="settings-theme-options">
        {THEMES.map((theme) => (
          <label className="settings-theme-option" key={theme}>
            <input type="radio" name="settings-theme" value={theme} checked={value === theme} onChange={() => onChange(theme)} />
            <span className={`settings-theme-preview settings-theme-preview--${theme}`} aria-hidden="true">
              <span className="settings-theme-sidebar"><i /><i /><i /></span>
              <span className="settings-theme-window"><i /><span /><span /></span>
            </span>
            <span className="settings-theme-label">{labels[theme]}<span className="settings-theme-check" aria-hidden="true">✓</span></span>
          </label>
        ))}
      </div>
      <p className="field-hint" id="settings-theme-hint">{t("settings.themeHint")}</p>
    </fieldset>
  );
}
