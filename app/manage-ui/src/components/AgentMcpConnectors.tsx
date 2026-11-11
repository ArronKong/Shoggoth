import { measureTelemetry } from "../lib/productTelemetry";
import McpConnectorIcon from "./McpConnectorIcon";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { listMcpConnectors, listMcpSubjects, formatMcpError, setMcpAgents } from "../api/mcpConnectors";
import { usePageCache } from "../lib/usePageCache";
import { useMcpConnectorRefresh } from "../lib/useMcpConnectorRefresh";
import s from "../pages/ConnectorsPage.module.css";

export default function AgentMcpConnectors({ backendId, agentId }: { backendId: string; agentId: string }) {
  const { t } = useTranslation(); const [profileId, setProfileId] = useState<string | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const list = usePageCache(`agent-mcp:${backendId}:${agentId}`, () => listMcpConnectors());
  useMcpConnectorRefresh(list.refresh);
  useEffect(() => { const controller = new AbortController(); setProfileId(null); void listMcpSubjects(controller.signal).then(subjects => { if (!controller.signal.aborted) setProfileId(subjects.items.find(item => item.backendId === backendId && item.agentId === agentId)?.profileId || null); }).catch(error => { if (!controller.signal.aborted) setError(formatMcpError(error, t)); }); return () => controller.abort(); }, [backendId, agentId]);
  return <section className={s.section}><h3>{t("mcpConnectors.title")}</h3><p className={s.muted}>{t("mcpConnectors.allAgents")}</p>{(error || list.error) && <p className={s.error} role="alert">{error || t("mcpConnectors.loadFailed")} <button className={s.textButton} type="button" onClick={() => { setError(""); void list.refresh(); }}>{t("mcpConnectors.retry")}</button></p>}
    {list.data?.servers.map(server => <label className={s.choice} key={server.id}><input type="checkbox" checked={!!profileId && !server.disabledProfileIds.includes(profileId)} disabled={busy || !profileId} onChange={event => {
      if (!profileId || !list.data) return;
      const enabled = event.target.checked, revision = list.data.revision;
      const disabled = enabled ? server.disabledProfileIds.filter(id => id !== profileId) : [...new Set([...server.disabledProfileIds, profileId])];
      setBusy(true); setError("");
      void measureTelemetry("connector_toggle", backendId, () => setMcpAgents(server.id, disabled, revision))
        .then(() => list.refresh()).catch(error => setError(formatMcpError(error, t))).finally(() => setBusy(false));
    }} /><McpConnectorIcon name={server.name} identity={server.source.kind === "registry" ? server.source.registryName : server.id} compact /><span>{server.name}<small>{t(`mcpConnectors.statuses.${server.status}`)}</small></span></label>)}
  </section>;
}
