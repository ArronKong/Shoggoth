import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Switch } from "../../components/Field";
import Modal from "../../components/Modal";
import ChatMarkdown from "../../components/ChatMarkdown";
import { changeTelemetrySetting, useTelemetrySettings } from "../../lib/productTelemetry";
import { getDesktopProductTelemetry } from "../../api/client";
import privacyZh from "../../../../../docs/privacy.md?raw";
import privacyEn from "../../../../../docs/privacy.en.md?raw";
import s from "./SettingsTelemetry.module.css";

export default function SettingsTelemetry() {
  const { t, i18n } = useTranslation();
  const { settings, saving, error } = useTelemetrySettings();
  const [noticeOpen, setNoticeOpen] = useState(false);
  const text = (key: string) => t("settings.telemetry." + key);
  const desktop = !!getDesktopProductTelemetry();
  const status = !desktop ? "desktopOnly" : !settings ? "loading" : !settings.available ? "unavailable"
    : !settings.enabled ? "disabled" : !settings.collectionAvailable ? "exportDisabled"
    : !settings.detailedEnabled ? "basicOnly" : null;
  const disabled = saving || !settings?.available;
  const privacy = (i18n?.resolvedLanguage || i18n?.language || "en").startsWith("zh") ? privacyZh : privacyEn;
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
      <div className={`settings-list-row settings-list-row--split ${s.footer}`}>
        <div className="settings-list-copy">
          {error ? <p role="alert">{text(error)}</p> : status ? <p role="status">{text(status)}</p> : null}
        </div>
        <button type="button" className="btn-secondary btn-sm" onClick={() => setNoticeOpen(true)}>{text("notice")}</button>
      </div>
    </div>
    <Modal open={noticeOpen} width={720} title={text("notice")} className="product-telemetry-privacy" onClose={() => setNoticeOpen(false)}>
      {noticeOpen && <ChatMarkdown text={privacy.replace(/^# [^\n]+\n+/u, "")} showLinkIcons={false}
        className={s.notice} />}
    </Modal>
  </section>;
}
