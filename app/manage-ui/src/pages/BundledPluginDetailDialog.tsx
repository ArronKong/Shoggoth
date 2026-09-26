import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { getBundledPluginDetail, type BundledPluginDetail,
  type BundledPluginItem } from "../api/client";
import styles from "./BundledPluginDetailDialog.module.css";

const VISIBLE_SKILLS = 5;

export function BundledPluginDetailDialog({ item, busy, returnFocusTo, onClose, onPreview, onManage }: {
  item: BundledPluginItem;
  busy: boolean;
  returnFocusTo: HTMLButtonElement | null;
  onClose: () => void;
  onPreview: (id: string) => void;
  onManage: (installationId: string) => void;
}) {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const previewRequested = useRef(false);
  const [detail, setDetail] = useState<BundledPluginDetail | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const [allSkills, setAllSkills] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    closeRef.current?.focus();
    return () => {
      if (dialog?.open) dialog.close();
      if (!previewRequested.current && returnFocusTo?.isConnected
        && returnFocusTo.offsetParent !== null) returnFocusTo.focus();
    };
  }, [returnFocusTo]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setFailed(false);
    void getBundledPluginDetail(item.id).then(value => {
      if (active) setDetail(value);
    }).catch(() => {
      if (active) setFailed(true);
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [item.id, retry]);

  const icon = item.iconAvailable
    ? <img className={styles.icon} src={`/__api/plugins/bundled-icon/${item.id}`} alt="" />
    : <span className={styles.iconFallback} aria-hidden="true">{item.displayName.slice(0, 1)}</span>;
  const installLabel = item.importStatus !== "previewable" ? t("plugins.adapterPending")
    : item.installationState === "not-installed" ? t("plugins.detailInstallPreview")
      : t("plugins.checkBundledUpdate");

  return createPortal(<dialog ref={dialogRef} className={styles.dialog}
    aria-labelledby="bundled-plugin-detail-title"
    onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className={styles.scroll}>
      <header className={styles.header}>
        <div className={styles.identity}>
          {icon}
          <div className={styles.heading}>
            <span className={styles.eyebrow}>{t("plugins.bundledSource")} · {item.category}</span>
            <h2 id="bundled-plugin-detail-title">{item.displayName}</h2>
            <p>{item.shortDescription}</p>
          </div>
        </div>
        <button ref={closeRef} className={styles.close} type="button" onClick={onClose}
          aria-label={t("plugins.detailClose")}>×</button>
      </header>

      <div className={styles.statusLine}>
        <span className={styles.state} data-state={item.installationState}>
          {item.installationState === "not-installed" ? t("plugins.notInstalled")
            : item.installationState === "enabled" ? t("plugins.desiredEnabled") : t("plugins.disabled")}
        </span>
        <span>{t("plugins.detailVersion", { version: item.version })}</span>
      </div>

      {loading && <p className={styles.message} role="status">{t("plugins.detailLoading")}</p>}
      {failed && <div className={styles.message} role="alert">
        <p>{t("plugins.detailUnavailable")}</p>
        <button type="button" className="btn-secondary" onClick={() => setRetry(value => value + 1)}>
          {t("plugins.externalRetry")}
        </button>
      </div>}
      {detail && <>
        <p className={styles.description}>{detail.longDescription || detail.shortDescription}</p>
        {(detail.unconvertedMcp.length > 0 || detail.apps.length > 0)
          && <p className={styles.adapterNotice} role="status">
            {t(detail.converted.mcp > 0 ? "plugins.detailAccountPartiallyPending"
              : detail.converted.skills > 0 ? "plugins.detailAccountPendingWithSkills"
                : "plugins.detailAccountPending")}
          </p>}
        {item.importStatus === "previewable" && detail.prompts.length > 0 && <section className={styles.promptPanel}
          aria-label={t("plugins.detailExamples")}>
          <span className={styles.panelLabel}>{t("plugins.detailExamples")}</span>
          {detail.prompts.map((prompt, index) => <p key={`${index}-${prompt}`}>
            <span aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>{prompt}
          </p>)}
        </section>}

        {detail.components.skills > 0 && <section className={styles.section}>
          <div className={styles.sectionTitle}><h3>{t("plugins.detailSkills")}</h3>
            <span>{detail.converted.skills} / {detail.components.skills}</span></div>
          <p className={styles.sectionNote}>{t("plugins.detailSkillsNote")}</p>
          <ul className={styles.componentList}>
            {(allSkills ? detail.skills : detail.skills.slice(0, VISIBLE_SKILLS)).map(skill =>
              <li key={skill.name}>
                <span className={styles.componentMark} aria-hidden="true">✦</span>
                <div><strong>{skill.name}</strong><p>{skill.description}</p></div>
                <span className={styles.componentState}>{t("plugins.detailInstallable")}</span>
              </li>)}
          </ul>
          {detail.skills.length > VISIBLE_SKILLS && <button className={styles.showMore} type="button"
            aria-expanded={allSkills} onClick={() => setAllSkills(value => !value)}>
            {t(allSkills ? "plugins.detailShowLess" : "plugins.detailShowAllSkills", { count: detail.skills.length })}
          </button>}
        </section>}

        {detail.components.mcp > 0 && <section className={styles.section}>
          <div className={styles.sectionTitle}><h3>{t("plugins.detailMcp")}</h3>
            <span>{detail.converted.mcp} / {detail.components.mcp}</span></div>
          <p className={styles.sectionNote}>{t("plugins.detailMcpNote")}</p>
          <ul className={styles.componentList}>
            {detail.mcpServers.map(server => <li key={server.name}>
              <span className={styles.componentMark} aria-hidden="true">⌘</span>
              <div><strong>{server.name}</strong><p>{server.type}</p></div>
              <span className={styles.componentState}>{t("plugins.detailInstallable")}</span>
            </li>)}
            {detail.unconvertedMcp.map(server => <li key={server.name}>
              <span className={styles.componentMark} aria-hidden="true">⌘</span>
              <div><strong>{server.name}</strong><p>{t(server.reasonCode === "LEGACY_MCP_FIELD_UNSUPPORTED"
                ? "plugins.bundledMcpUnsupported" : "plugins.bundledMcpInvalid")}</p></div>
              <span className={styles.componentState}>{t("plugins.adapterPending")}</span>
            </li>)}
          </ul>
        </section>}

        {detail.apps.length > 0 && <section className={styles.section}>
          <div className={styles.sectionTitle}><h3>{t("plugins.detailApps")}</h3>
            <span>{detail.apps.length}</span></div>
          <p className={styles.sectionNote}>{t("plugins.detailAppsPending")}</p>
          <ul className={styles.appList}>{detail.apps.map(app => <li key={app}>
            <span className={styles.appGlyph} aria-hidden="true">{app.slice(0, 1).toUpperCase()}</span>
            <strong>{app.replaceAll("_", " ")}</strong>
            <span>{t("plugins.adapterPending")}</span>
          </li>)}</ul>
        </section>}

        <section className={styles.section}>
          <div className={styles.sectionTitle}><h3>{t("plugins.detailInformation")}</h3></div>
          <dl className={styles.infoGrid}>
            {detail.developerName && <><dt>{t("plugins.detailDeveloper")}</dt><dd>{detail.developerName}</dd></>}
            <dt>{t("plugins.detailVersionLabel")}</dt><dd>{detail.version}</dd>
            <dt>{t("plugins.detailCategory")}</dt><dd>{detail.category}</dd>
            {detail.license && <><dt>{t("plugins.detailLicense")}</dt><dd>{detail.license}</dd></>}
            {detail.websiteURL && <><dt>{t("plugins.detailWebsite")}</dt><dd>{detail.websiteURL}</dd></>}
          </dl>
        </section>
      </>}
    </div>
    <footer className={styles.footer}>
      <span>{item.importStatus === "previewable" ? t("plugins.detailInstallNotice")
        : t("plugins.detailAdapterNotice")}</span>
      <div className={styles.footerActions}>
        {item.installationState !== "not-installed" && <button className="btn-secondary" type="button"
          onClick={() => { previewRequested.current = true; onManage(item.installationId); }}>
          {t("plugins.detailManageInstalled")}</button>}
        <button className="btn-secondary" type="button" disabled={busy || item.importStatus !== "previewable"}
          onClick={() => { previewRequested.current = true; onPreview(item.id); }}>
          {busy ? t("plugins.choosing") : installLabel}</button>
      </div>
    </footer>
  </dialog>, document.body);
}
