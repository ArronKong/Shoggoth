import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { listMcpTools, type McpToolDescription, type McpToolList } from "../api/mcpConnectors";
import type { ConnectorToolPreview } from "../lib/connectorToolPreviews";
import s from "../pages/ConnectorsPage.module.css";

export default function ConnectorTools({ serverId, checkedAt, status, items, previewId, refreshKey, overview = false, description }: {
  serverId?: string; checkedAt?: number | null; status?: string; items?: McpToolDescription[];
  previewId?: string; refreshKey?: string | number;
  overview?: boolean; description?: string;
}) {
  const { t, i18n } = useTranslation();
  const language = i18n?.resolvedLanguage || i18n?.language || "en";
  const [open, setOpen] = useState(false), [search, setSearch] = useState("");
  const [read, setRead] = useState<{ key: string; data?: McpToolList; error?: boolean; loading?: boolean } | null>(null);
  const [preview, setPreview] = useState<{ id: string; language: string; value?: ConnectorToolPreview; error?: boolean } | null>(null);
  const [retry, setRetry] = useState(0);
  const requestKey = JSON.stringify([serverId, checkedAt, status, refreshKey]);
  useEffect(() => { setSearch(""); }, [serverId, previewId]);
  useEffect(() => {
    setRead(null);
    if (!open || !serverId || items) return;
    const controller = new AbortController(); setRead({ key: requestKey, loading: true });
    void listMcpTools(serverId, controller.signal).then(data => { if (!controller.signal.aborted) setRead({ key: requestKey, data }); })
      .catch(() => { if (!controller.signal.aborted) setRead({ key: requestKey, error: true }); });
    return () => controller.abort();
  }, [open, serverId, requestKey, retry, items]);
  useEffect(() => {
    setPreview(null);
    if ((!open && !overview) || !previewId || items) return;
    let active = true;
    void import("../lib/connectorToolPreviews").then(module => {
      if (active) setPreview({ id: previewId, language, value: module.getConnectorToolPreview(previewId, language) });
    }).catch(() => { if (active) setPreview({ id: previewId, language, error: true }); });
    return () => { active = false; };
  }, [open, overview, previewId, language, retry, items]);
  const currentRead = read?.key === requestKey ? read : null;
  const currentPreview = preview?.id === previewId && preview?.language === language ? preview : null;
  const data = currentRead?.data;
  // A successful service snapshot is authoritative, including an empty list.
  const live = !!data?.available;
  const shownPreview = !items && !live ? currentPreview?.value : undefined;
  const tools = items || (live ? data.items : shownPreview?.items) || [];
  const available = !!items || live || !!shownPreview;
  const loading = currentRead?.loading || !items && !!previewId && !currentPreview;
  const error = currentRead?.error || !items && !live && currentPreview?.error;
  const shown = tools.filter(tool => `${tool.name} ${tool.description}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const capabilities = items || currentPreview?.value?.items || [];
  const namedTools = !!items || currentPreview?.value?.kind === "tools";
  const details = <>
      {loading && !available && <p role="status" className={s.muted}>{t("mcpConnectors.loading")}</p>}
      {error && <p role="alert" className={s.error}>{t("mcpConnectors.loadFailed")} <button type="button" className={s.textButton} onClick={() => setRetry(value => value + 1)}>{t("mcpConnectors.retry")}</button></p>}
      {!loading && !error && !available && <p className={s.muted}>{t("mcpConnectors.flow.toolsAfterCheck")}</p>}
      {available && <>
        <p className={s.muted}>{t(items ? "mcpConnectors.flow.deviceToolsHint" : shownPreview ? shownPreview.kind === "tools" ? "mcpConnectors.flow.toolsPreviewHint" : "mcpConnectors.flow.operationsPreviewHint" : "mcpConnectors.flow.toolsHint")}</p>
        {shownPreview && <p className={s.muted}>{status === "ready" && <>{t("mcpConnectors.flow.refreshPreview")} </>}<a href={shownPreview.sourceUrl} target="_blank" rel="noreferrer">{t("mcpConnectors.flow.previewSource")}</a></p>}
        {tools.length > 6 && <input className={s.actionSearch} type="search" aria-label={t("mcpConnectors.flow.searchTools")} placeholder={t("mcpConnectors.flow.searchTools")} value={search} onChange={event => setSearch(event.target.value)} />}
        <ul className={s.toolList} data-tool-list={shownPreview ? "preview" : items ? "device" : "live"}>{shown.map(tool => <li key={tool.name}><strong>{tool.name}</strong><p>{tool.description || t("mcpConnectors.flow.noToolDescription")}</p></li>)}</ul>
        {!shown.length && <p className={s.muted}>{t("mcpConnectors.flow.noTools")}</p>}
        {live && data && tools.length < data.totalCount && <p className={s.muted}>{t("mcpConnectors.flow.toolsPartial")}</p>}
      </>}
    </>;
  if (overview) return <section className={s.capabilities} data-connector-capabilities>
    <div className={s.capabilityHeading}><h3>{t(open ? "mcpConnectors.flow.toolDetails" : "mcpConnectors.flow.capabilities")}</h3>
      <button type="button" className={s.textButton} aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? t("mcpConnectors.flow.backOverview") : t("mcpConnectors.flow.viewTools")}<span aria-hidden="true">{open ? " ←" : " ›"}</span></button>
    </div>
    {open ? details : <>
      {capabilities.length ? <ul className={s.capabilityList}>{capabilities.slice(0, 3).map(tool => <li key={tool.name}><span className={s.capabilityIcon} aria-hidden="true">✓</span><div><strong>{namedTools ? tool.description || tool.name : tool.name}</strong>{!namedTools && tool.description && <p>{tool.description}</p>}</div></li>)}</ul> : <p className={s.muted}>{description || t("mcpConnectors.flow.toolsAfterCheck")}</p>}
    </>}
  </section>;
  return <details className={s.toolDetails} open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{t(shownPreview ? "mcpConnectors.flow.previewTools" : "mcpConnectors.flow.viewTools")}{tools.length > 0 && <span>{tools.length}</span>}</summary>
    {open && details}
  </details>;
}
