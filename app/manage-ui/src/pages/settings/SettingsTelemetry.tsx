import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Switch } from "../../components/Field";
import { getDesktopProductTelemetry } from "../../api/client";
import { changeTelemetrySetting, useTelemetrySettings } from "../../lib/productTelemetry";

export default function SettingsTelemetry() {
  const { t, i18n } = useTranslation();
  const { settings, saving, error } = useTelemetrySettings();
  const [diagnostic, setDiagnostic] = useState<"saving" | "saved" | "failed" | null>(null);
  const bridge = getDesktopProductTelemetry();
  const text = (key: string) => t("settings.telemetry." + key);
  const disabled = saving || !settings?.available || Boolean(settings.disabledReason);
  const hint = settings?.disabledReason ?? (settings?.detailedEnabled === false ? "basicOnly" : "enabledHint");
  const policy = (i18n.resolvedLanguage || i18n.language).startsWith("zh") ? "privacy.md" : "privacy.en.md";
  async function saveDiagnostic() {
    if (!bridge || diagnostic === "saving") return;
    setDiagnostic("saving");
    try {
      const result = await bridge.saveDiagnosticFile();
      setDiagnostic(result === "canceled" ? null : result);
    } catch { setDiagnostic("failed"); }
  }
  return <section className="settings-section" id="settings-telemetry" aria-labelledby="settings-telemetry-title"
    aria-busy={saving} data-product-telemetry-exclude>
    <header className="settings-section-head">
      <h3 className="settings-h" id="settings-telemetry-title">{text("title")}</h3>
    </header>
    <div className="settings-card settings-list-card">
      <div className="settings-list-row settings-list-row--split">
        <div className="settings-list-copy">
          <h4 id="settings-telemetry-enabled">{text("enabled")}</h4>
          <p>{text(hint)}{" "}<a href={`https://github.com/ArronKong/Shoggoth/blob/HEAD/docs/${policy}`}
            target="_blank" rel="noopener noreferrer">{text("policy")}</a></p>
        </div>
        <Switch checked={settings?.enabled === true && !settings.disabledReason} disabled={disabled}
          ariaLabelledBy="settings-telemetry-enabled" onChange={enabled => void changeTelemetrySetting(enabled)} />
      </div>
      <div className="settings-list-row settings-list-row--split">
        <div className="settings-list-copy">
          <h4>{text("diagnostics")}</h4>
          <p role="status">{text(diagnostic === "saved" ? "diagnosticSaved"
            : diagnostic === "failed" ? "diagnosticFailed" : "diagnosticHint")}</p>
        </div>
        <button type="button" className="btn-secondary btn-sm" disabled={!bridge?.saveDiagnosticFile || diagnostic === "saving"}
          onClick={() => void saveDiagnostic()}>{text("createDiagnostic")}</button>
      </div>
    </div>
    {error && <p className="field-error" role="alert">{text(error)}</p>}
  </section>;
}
