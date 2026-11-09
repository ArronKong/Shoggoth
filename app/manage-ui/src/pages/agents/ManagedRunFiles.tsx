import { useTranslation } from "react-i18next";
import { listManagedAgentFiles, managedAgentFileUrl } from "../../api/client";
import { useBackendCatalog } from "../../lib/backends";
import { usePageCache } from "../../lib/usePageCache";

export default function ManagedRunFiles({ backend, agentId, runId }: { backend: string; agentId: string; runId: string }) {
  const { t } = useTranslation();
  const supported = useBackendCatalog("agents").some(item => item.id === backend && item.surfaces.agentFiles);
  const { data, error, refresh } = usePageCache(`managed-run-files:${backend}:${agentId}:${runId}`,
    () => listManagedAgentFiles(backend, agentId, { runId }), { enabled: supported });
  if (!supported) return null;
  if (error) return <p role="status">{t("agents.managedFiles.unavailable")}{" "}
    <button className="btn-subtle btn-sm" type="button" onClick={() => void refresh()}>{t("common.retry")}</button></p>;
  if (!data?.items.length) return null;
  return <section aria-label={t("agents.managedFiles.title")}>
    <h4>{t("agents.managedFiles.title")}</h4>
    <ul>{data.items.map(file => <li key={file.fileId}>
      {file.status === "available" ? <a href={managedAgentFileUrl(backend, agentId, file.fileId)} download>{file.name}</a>
        : <span>{file.name} · {t("agents.managedFiles.missing")}</span>}
    </li>)}</ul>
  </section>;
}
