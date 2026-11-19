import { useTranslation } from "react-i18next";
import { Switch } from "../../components/Field";
import { changeTelemetrySetting, useTelemetrySettings } from "../../lib/productTelemetry";

export default function SettingsTelemetry() {
  const { t } = useTranslation();
  const { settings, saving, error } = useTelemetrySettings();
  const text = (key: string) => t("settings.telemetry." + key);
  const disabled = saving || !settings?.available;
  return <section className="settings-section" id="settings-telemetry" aria-labelledby="settings-telemetry-title"
    aria-busy={saving} data-product-telemetry-exclude>
    <header className="settings-section-head">
      <h3 className="settings-h" id="settings-telemetry-title">{text("title")}</h3>
    </header>
    <div className="settings-card settings-list-card">
      <div className="settings-list-row settings-list-row--split">
        <div className="settings-list-copy">
          <h4 id="settings-telemetry-enabled">{text("enabled")}</h4>
          <p>{text("enabledHint")}</p>
        </div>
        <Switch checked={settings?.enabled === true} disabled={disabled} ariaLabelledBy="settings-telemetry-enabled"
          onChange={enabled => void changeTelemetrySetting("enabled", enabled)} />
      </div>
      <div className="settings-list-row settings-list-row--split">
        <div className="settings-list-copy">
          <h4 id="settings-telemetry-detailed">{text("detailed")}</h4>
          <p>{text("detailedHint")}</p>
        </div>
        <Switch checked={settings?.detailedEnabled === true} disabled={disabled || !settings?.enabled}
          ariaLabelledBy="settings-telemetry-detailed" onChange={enabled => void changeTelemetrySetting("detailedEnabled", enabled)} />
      </div>
    </div>
    {error && <p className="field-error" role="alert">{text(error)}</p>}
  </section>;
}
