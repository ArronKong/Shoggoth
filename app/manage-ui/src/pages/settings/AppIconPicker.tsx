import { useTranslation } from "react-i18next";
import type { AppConfig } from "../../types";
import { SettingsIcon } from "./SettingsIcons";
import shoggothIp from "../../assets/app-icons/shoggoth-ip.png";
import shoggothLogo from "../../assets/app-icons/shoggoth-logo.png";
import styles from "./AppIconPicker.module.css";

type AppIconId = NonNullable<AppConfig["appIcon"]>;

// Icon names are product names and stay the same in every language.
const ICONS: { id: AppIconId; name: string; src: string }[] = [
  { id: "shoggoth-ip", name: "Shoggoth IP", src: shoggothIp },
  { id: "shoggoth-logo", name: "Shoggoth Logo", src: shoggothLogo },
];

export default function AppIconPicker({ value, onChange, disabled }: {
  value: AppConfig["appIcon"];
  onChange: (appIcon: AppIconId) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const selected = value ?? "shoggoth-ip";
  return (
    <div className="settings-list-row settings-list-row--split settings-list-row--icon" id="settings-app-icon">
      <SettingsIcon name="appIcon" />
      <div className="settings-list-copy">
        <h4 id="settings-app-icon-title">{t("settings.appIcon.title")}</h4>
        <p>{t("settings.appIcon.description")}</p>
      </div>
      <fieldset className={styles.options} disabled={disabled} aria-labelledby="settings-app-icon-title">
        {ICONS.map((icon) => (
          <label className={styles.option} key={icon.id}>
            <input type="radio" name="settings-app-icon" value={icon.id} checked={selected === icon.id}
              onChange={() => onChange(icon.id)} />
            <img src={icon.src} alt="" draggable={false} />
            <span>{icon.name}</span>
          </label>
        ))}
      </fieldset>
    </div>
  );
}
