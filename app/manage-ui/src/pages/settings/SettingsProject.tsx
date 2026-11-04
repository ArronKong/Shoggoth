import { useTranslation } from "react-i18next";
import { SettingsIcon } from "./SettingsIcons";

const projectUrl = "https://github.com/ArronKong/Shoggoth";

export default function SettingsProject() {
  const { t } = useTranslation();
  return (
    <section className="settings-section" id="settings-project" aria-labelledby="settings-project-title">
      <header className="settings-section-head">
        <h3 className="settings-h" id="settings-project-title">{t("settings.project.title")}</h3>
      </header>
      <div className="settings-card settings-list-card">
        <div className="settings-list-row settings-list-row--icon settings-project-row">
          <SettingsIcon name="project" />
          <div className="settings-list-copy">
            <h4>{t("settings.project.repository")}</h4>
            <p className="settings-project-repository">
              <a href={projectUrl} target="_blank" rel="noopener noreferrer">{projectUrl}
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true"><path d="M5 3h8v8M13 3 3 13" /></svg>
              </a>
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
