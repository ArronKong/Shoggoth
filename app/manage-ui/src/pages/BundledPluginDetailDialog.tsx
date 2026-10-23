import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { getBundledPluginDetail, type BundledPluginDetail,
  type BundledPluginItem } from "../api/client";
import styles from "./BundledPluginDetailDialog.module.css";
import { graphReadOnlyCopy } from "./graphReadOnlyCopy";
import { PluginGraphRegistration, isGraphRegistrationPackage } from "./PluginGraphRegistration";
import { PluginLovableRegistration } from "./PluginLovableRegistration";
import { PluginHiggsfieldRegistration } from "./PluginHiggsfieldRegistration";
import { PluginSlackRegistration } from "./PluginSlackRegistration";
import { PluginGmailRegistration } from "./PluginGmailRegistration";
import { PluginCodexSecurityStatus } from "./PluginCodexSecurityStatus";

const VISIBLE_SKILLS = 5;

export function BundledPluginDetailDialog({ item, busy, returnFocusTo, onClose, onPreview, onManage,
  nativeAgentId = null, embedded = false }: {
  item: BundledPluginItem;
  busy: boolean;
  nativeAgentId?: string | null;
  embedded?: boolean;
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
    if (!embedded) dialog?.showModal();
    if (!embedded) closeRef.current?.focus();
    return () => {
      if (dialog?.open) dialog.close();
      if (!embedded && !previewRequested.current && returnFocusTo?.isConnected
        && returnFocusTo.offsetParent !== null) returnFocusTo.focus();
    };
  }, [returnFocusTo, embedded]);

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
  const installable = item.importStatus === "previewable" || Boolean(item.localAdapter);
  const graphReadOnly = item.localAdapter === "shoggoth-graph-read-only";
  const lovableOfficial = item.localAdapter === "shoggoth-lovable-official-mcp";
  const slackOfficial = item.localAdapter === "shoggoth-slack-official-mcp";
  const gmailGogcli = item.localAdapter === "shoggoth-gogcli-gmail-mcp";
  const graphCopy = graphReadOnlyCopy(item.id);
  const installLabel = !installable ? t("plugins.adapterPending")
    : item.installationState === "not-installed" ? t("plugins.detailInstallPreview")
      : t("plugins.checkBundledUpdate");
  const startInstall = () => { previewRequested.current = true; onPreview(item.id); };

  const content = <>
    <div className={styles.scroll}>
      <header className={styles.header}>
        <div className={styles.identity}>
          {icon}
          <div className={styles.heading}>
            <span className={styles.eyebrow}>{t("plugins.bundledSource")} · {item.category}</span>
            <h2 id="bundled-plugin-detail-title">{item.displayName}</h2>
            <p>{graphReadOnly ? t(graphCopy.short)
              : lovableOfficial ? t("plugins.lovableOfficialShort")
                : slackOfficial ? t("plugins.slackOfficialShort")
                  : gmailGogcli ? t("plugins.gmailGogcliShort") : item.shortDescription}</p>
          </div>
        </div>
        <div className={styles.headerActions}>
          {embedded && <button className="btn-primary" type="button" disabled={busy || !installable}
            onClick={startInstall}>{busy ? t("plugins.choosing") : installLabel}</button>}
          {!embedded && <button ref={closeRef} className={styles.close} type="button" onClick={onClose}
            aria-label={t("plugins.detailClose")}>×</button>}
        </div>
      </header>

      <div className={styles.statusLine}>
        <span className={styles.state} data-state={item.installationState}>
          {item.installationState === "not-installed" ? t("plugins.notInstalled")
            : item.installationState === "enabled" ? t("plugins.detailInstalledEnabled") : t("plugins.disabled")}
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
        <p className={styles.description}>{graphReadOnly
          ? t(graphCopy.description) : lovableOfficial
            ? t("plugins.lovableOfficialDescription") : slackOfficial
              ? t("plugins.slackOfficialDescription") : gmailGogcli
                ? t("plugins.gmailGogcliDescription") : detail.longDescription || detail.shortDescription}</p>
        {item.id === "higgsfield" && <aside className={styles.sourceNotice} role="status">
          <p>{t("plugins.higgsfieldAcceptancePending")}</p>
        </aside>}
        {item.id === "higgsfield" && <div className={styles.registrationPanel}>
          <PluginHiggsfieldRegistration />
        </div>}
        {detail.localAdapter === "shoggoth-graph-read-only" && <aside className={styles.sourceNotice} role="status">
          <strong>{t(graphCopy.badge)}</strong>
          <p>{t(graphCopy.explanation)}</p>
        </aside>}
        {item.id === "codex-security" && <PluginCodexSecurityStatus
          installationId={item.installationState === "not-installed" ? null : item.installationId}
          nativeAgentId={nativeAgentId} />}
        {graphReadOnly && isGraphRegistrationPackage(item.id)
          && <div className={styles.registrationPanel}>
            <PluginGraphRegistration packageId={item.id} />
          </div>}
        {lovableOfficial && <aside className={styles.sourceNotice} role="status">
          <strong>{t("plugins.lovableOfficialBadge")}</strong>
          <p>{t("plugins.lovableOfficialExplanation")}</p>
        </aside>}
        {lovableOfficial && <div className={styles.registrationPanel}>
          <PluginLovableRegistration />
        </div>}
        {slackOfficial && <aside className={styles.sourceNotice} role="status">
          <strong>{t("plugins.slackOfficialBadge")}</strong>
          <p>{t("plugins.slackOfficialExplanation")}</p>
        </aside>}
        {slackOfficial && <div className={styles.registrationPanel}>
          <PluginSlackRegistration />
        </div>}
        {gmailGogcli && <aside className={styles.sourceNotice} role="status">
          <strong>{t("plugins.gmailGogcliBadge")}</strong>
          <p>{t("plugins.gmailGogcliExplanation")}</p>
        </aside>}
        {gmailGogcli && <div className={styles.registrationPanel}>
          <PluginGmailRegistration />
        </div>}
        {item.id !== "codex-security" && (!detail.localAdapter || lovableOfficial || slackOfficial || gmailGogcli)
          && (detail.unconvertedMcp.length > 0 || detail.apps.length > 0)
          && <p className={styles.adapterNotice} role="status">
            {t(gmailGogcli ? "plugins.gmailSourceConnectorPending"
              : slackOfficial ? "plugins.slackOriginalConnectorPending"
              : detail.converted.mcp > 0 ? "plugins.detailAccountPartiallyPending"
                : detail.converted.skills > 0 ? "plugins.detailAccountPendingWithSkills"
                  : "plugins.detailAccountPending")}
          </p>}
        {!gmailGogcli && detail.connectionWarnings.map(warning => <aside key={warning.name}
          className={styles.sourceNotice} role="status">
          <strong>{t("plugins.googleDesktopOAuthWarningTitle")}</strong>
          <p>{t("plugins.googleDesktopOAuthRequired")}</p>
        </aside>)}
        {detail.sourceWarnings?.map(warning => <aside key={`${warning.code}-${warning.source}`}
          className={styles.sourceNotice} role="status">
          <strong>{t("plugins.detailSourceWarningTitle")}</strong>
          <p>{t("plugins.detailSourceMissingReferences", {
            source: warning.source, count: warning.targets.length,
          })}</p>
          <ul>{warning.targets.map(target => <li key={target}><code>{target}</code></li>)}</ul>
          <p>{t("plugins.detailSourceMissingImpact")}</p>
        </aside>)}
        {installable && (graphReadOnly || lovableOfficial || slackOfficial || gmailGogcli || detail.prompts.length > 0) && <section className={styles.promptPanel}
          aria-label={t("plugins.detailExamples")}>
          <span className={styles.panelLabel}>{t("plugins.detailExamples")}</span>
          {(graphReadOnly ? [t(graphCopy.example)] : lovableOfficial
            ? [t("plugins.lovableOfficialExample")] : slackOfficial
              ? [t("plugins.slackOfficialExample")] : gmailGogcli
                ? [t("plugins.gmailGogcliExample")] : detail.prompts).map((prompt, index) => <p key={`${index}-${prompt}`}>
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
            <span>{gmailGogcli ? t("plugins.gmailGogcliMcpCount")
              : `${detail.converted.mcp} / ${detail.components.mcp}`}</span></div>
          <p className={styles.sectionNote}>{t(lovableOfficial
            ? "plugins.lovableOfficialMcpNote" : slackOfficial
              ? "plugins.slackOfficialMcpNote" : gmailGogcli
                ? "plugins.gmailGogcliMcpNote" : "plugins.detailMcpNote")}</p>
          <ul className={styles.componentList}>
            {gmailGogcli ? <li>
              <span className={styles.componentMark} aria-hidden="true">⌘</span>
              <div><strong>gog mcp</strong><p>stdio · gogcli v0.42.0</p></div>
              <span className={styles.componentState}>{t("plugins.gmailGogcliBadge")}</span>
            </li> : detail.mcpServers.map(server => <li key={server.name}>
              <span className={styles.componentMark} aria-hidden="true">⌘</span>
              <div><strong>{server.name}</strong><p>{server.type}</p></div>
              <span className={styles.componentState}>{t("plugins.detailInstallable")}</span>
            </li>)}
            {!gmailGogcli && detail.unconvertedMcp.map(server => <li key={server.name}>
              <span className={styles.componentMark} aria-hidden="true">⌘</span>
              <div><strong>{server.name}</strong><p>{t(server.reasonCode === "LEGACY_MCP_FIELD_UNSUPPORTED"
                ? "plugins.bundledMcpUnsupported" : "plugins.bundledMcpInvalid")}</p></div>
              <span className={styles.componentState}>{t("plugins.adapterPending")}</span>
            </li>)}
          </ul>
        </section>}

        {detail.apps.length > 0 && !gmailGogcli && <section className={styles.section}>
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
          {gmailGogcli && <p className={styles.sectionNote}>{t("plugins.gmailSourceMetadataNotice")}</p>}
          <dl className={styles.infoGrid}>
            {detail.developerName && <><dt>{t("plugins.detailDeveloper")}</dt><dd>{detail.developerName}</dd></>}
            <dt>{t("plugins.detailVersionLabel")}</dt><dd>{detail.version}</dd>
            <dt>{t("plugins.detailCategory")}</dt><dd>{detail.category}</dd>
            {detail.license && <><dt>{t("plugins.detailLicense")}</dt><dd>{detail.license}</dd></>}
            {detail.websiteURL && <><dt>{t("plugins.detailWebsite")}</dt><dd>{detail.websiteURL}</dd></>}
          </dl>
          {detail.license && <p className={styles.sectionNote}>{t("plugins.detailLicenseEvidenceNotice")}</p>}
        </section>
      </>}
    </div>
    <footer className={styles.footer}>
      <span>{lovableOfficial ? t("plugins.lovableOfficialInstallNotice")
        : slackOfficial ? t("plugins.slackOfficialInstallNotice")
        : gmailGogcli ? t("plugins.gmailGogcliInstallNotice")
        : item.localAdapter ? t("plugins.graphAdapterInstallNotice")
        : item.importStatus === "previewable" ? t("plugins.detailInstallNotice")
          : t("plugins.detailAdapterNotice")}</span>
      <div className={styles.footerActions}>
        {item.installationState !== "not-installed" && <button className="btn-secondary" type="button"
          onClick={() => { previewRequested.current = true; onManage(item.installationId); }}>
          {t("plugins.detailManageInstalled")}</button>}
        <button className="btn-primary" type="button" disabled={busy || !installable}
          onClick={startInstall}>
          {busy ? t("plugins.choosing") : installLabel}</button>
      </div>
    </footer>
  </>;

  if (embedded) return <div className={styles.embedded}>{content}</div>;
  return createPortal(<dialog ref={dialogRef} className={styles.dialog}
    aria-labelledby="bundled-plugin-detail-title"
    onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    {content}
  </dialog>, document.body);
}
