import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ApiError, getManagedAgentFile, listAgentArtifacts, listManagedAgentFiles, managedAgentFileUrl,
  mutateManagedAgentFile, revealManagedAgentFile, revealPath,
} from "../../api/client";
import type { AgentManagedFile, AgentManagedFilesPage } from "../../types";
import { usePageCache } from "../../lib/usePageCache";
import { Field, TextInput } from "../../components/Field";
import Modal from "../../components/Modal";
import { useConfirm, useToast } from "../../components/ui";
import s from "../AgentsPage.module.css";
import styles from "./AgentFilesPanel.module.css";

const RASTER = /\.(png|jpe?g|gif|webp)$/iu;
const TEXT = /\.(txt|md|csv|tsv|json)$/iu;

export default function AgentFilesPanel({ backend, agentId, hasManagedFiles }: {
  backend: string;
  agentId: string;
  hasManagedFiles: boolean;
}) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const confirm = useConfirm();
  const errorId = useId();
  const workspace = usePageCache(`agent-artifacts:${backend}:${agentId}:${hasManagedFiles}`,
    () => listAgentArtifacts(backend, agentId, undefined, hasManagedFiles), { loadingOnEmptyRefresh: true });
  const managed = usePageCache(`agent-managed-files:${backend}:${agentId}:0`,
    () => listManagedAgentFiles(backend, agentId), { enabled: hasManagedFiles, loadingOnEmptyRefresh: true });
  const [moreFiles, setMoreFiles] = useState<AgentManagedFilesPage | null>(null);
  const [selected, setSelected] = useState<AgentManagedFile | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  const errorText = (failure: unknown) => {
    const code = failure instanceof ApiError ? failure.code : undefined;
    return code ? t(`agents.managedFiles.errors.${code}`, { defaultValue: t("agents.managedFiles.unavailable") })
      : t("agents.managedFiles.unavailable");
  };

  const previewUrl = selected?.status === "available"
    ? managedAgentFileUrl(backend, agentId, selected.fileId, true) : null;
  const imagePreview = !!previewUrl && !!selected && RASTER.test(selected.name);
  const textPreview = !!previewUrl && !!selected && TEXT.test(selected.name) && selected.sizeBytes <= 256 * 1024;
  useEffect(() => {
    setPreview(null);
    setPreviewFailed(false);
    if (!textPreview || !previewUrl) return;
    const controller = new AbortController();
    void fetch(previewUrl, { signal: controller.signal, cache: "no-store" }).then(async (response) => {
      if (!response.ok || !response.headers.get("content-type")?.startsWith("text/plain")) throw new Error();
      const body = await response.text();
      if (!controller.signal.aborted) setPreview(body);
    }).catch(() => { if (!controller.signal.aborted) setPreviewFailed(true); });
    return () => controller.abort();
  }, [previewUrl, textPreview, selected?.revision]);

  const refreshManagedFiles = () => {
    setMoreFiles(null);
    return managed.refresh();
  };
  const refreshFiles = async () => {
    setBusy(true);
    try {
      await Promise.all([refreshManagedFiles(), workspace.refresh()]);
    } finally { setBusy(false); }
  };
  const nextCursor = (moreFiles ?? managed.data)?.nextCursor;
  const loadMore = async () => {
    if (busy || nextCursor == null) return;
    setBusy(true);
    try {
      const page = await listManagedAgentFiles(backend, agentId, { cursor: nextCursor });
      setMoreFiles(previous => ({ ...page, items: [...(previous?.items ?? []), ...page.items] }));
    } catch (failure) { toast.error(errorText(failure)); }
    finally { setBusy(false); }
  };
  const inspect = async (fileId: string) => {
    setBusy(true);
    try {
      const { file } = await getManagedAgentFile(backend, agentId, fileId);
      setSelected(file);
      setName(file.name);
      setError(null);
    } catch (failure) { toast.error(errorText(failure)); }
    finally { setBusy(false); }
  };
  const rename = async () => {
    if (!selected || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { file } = await mutateManagedAgentFile(backend, agentId, selected, name);
      setSelected(file);
      setName(file.name);
      toast.success(t("agents.saved"));
      await refreshManagedFiles();
    } catch (failure) { setError(errorText(failure)); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    if (!selected || busy) return;
    const file = selected;
    setBusy(true);
    try {
      const approved = await confirm({ title: t("agents.managedFiles.deleteTitle"),
        message: t("agents.managedFiles.deleteConfirm", { name: file.name }),
        confirmLabel: t("common.delete"), focusCancel: true, danger: true });
      if (!approved) return;
      await mutateManagedAgentFile(backend, agentId, file);
      setSelected(null);
      toast.success(t("agents.managedFiles.deleted"));
      await refreshManagedFiles();
    } catch (failure) { setError(errorText(failure)); }
    finally { setBusy(false); }
  };

  const managedUnavailable = hasManagedFiles && Boolean(managed.error);
  const managedFiles = new Map<string, AgentManagedFile>();
  if (hasManagedFiles && !managedUnavailable) {
    for (const file of moreFiles?.items ?? []) managedFiles.set(file.fileId, file);
    for (const file of managed.data?.items ?? []) managedFiles.set(file.fileId, file);
  }
  const workspaceFiles = workspace.data?.supported ? workspace.data.items : [];
  const workspaceTotal = workspace.data?.supported ? (workspace.data.total ?? workspaceFiles.length) : 0;
  const workspaceUnavailable = Boolean(workspace.error) || workspace.data?.supported === false;
  const remote = workspace.data?.reason === "remote";
  const loading = workspace.loading || (hasManagedFiles && managed.loading);
  const rows = [
    ...Array.from(managedFiles.values(), file => ({
      key: `file:${file.fileId}`, name: file.name, title: file.name,
      badge: t(`agents.managedFiles.source.${file.source.kind}`),
      time: file.updatedAt, size: file.sizeBytes, missing: file.status === "missing", disabled: busy,
      open: () => void inspect(file.fileId),
    })),
    ...workspaceFiles.map(file => ({
      key: `path:${file.path}`, name: file.name, title: `${t("chat.artifactsRevealInFolder")} · ${file.path}`,
      badge: file.kind, time: file.mtimeMs, size: file.size, missing: false, disabled: false,
      open: () => void revealPath(file.path).catch(failure =>
        toast.error(failure instanceof Error ? failure.message : String(failure))),
    })),
  ].sort((a, b) => b.time - a.time);
  const workspaceTruncated = workspaceTotal > workspaceFiles.length;
  const incomplete = hasManagedFiles && (loading || nextCursor != null || managedUnavailable
    || workspaceUnavailable || workspace.data?.partial || workspaceTruncated);
  const count = incomplete ? rows.length : managedFiles.size + workspaceTotal;

  return (
    <>
      {count > 0 && <div className={styles.head}>
        <p className={styles.summary}>
          {t(incomplete ? "agents.filesShown" : "agents.artifactsCount", { count })}
          {!hasManagedFiles && workspaceTruncated && t("agents.artifactsShown", { shown: workspaceFiles.length })}
        </p>
      </div>}
      {workspaceUnavailable && <p className={`${s.paneNote} ${styles.state}`} role="status">
        {t(remote ? "agents.artifactsUnsupported" : "chat.agentArtifactsUnavailable")}
        {!remote && <button type="button" className="btn-subtle btn-sm" disabled={busy}
          onClick={() => void workspace.refresh()}>{t("common.retry")}</button>}
      </p>}
      {managedUnavailable && <p className={`${s.paneNote} ${styles.state}`} role="status">
        {t("agents.managedFiles.unavailable")}
        <button type="button" className="btn-subtle btn-sm" disabled={busy}
          onClick={() => void refreshFiles()}>{t("common.retry")}</button>
      </p>}
      {workspace.data?.partial && <p className={s.paneNote} role="status">{t("chat.agentArtifactsPartial")}</p>}
      {loading && <p className={s.dim} role="status">{t("common.loading")}</p>}
      {rows.length > 0 ? (
        <ul className={`${s.rowList} ${styles.list}`} aria-label={t("agents.tabArtifacts")}>
          {rows.map(file => (
            <li key={file.key}>
              <button type="button" className={`${s.row} ${s.rowClickable}`} title={file.title}
                disabled={file.disabled} onClick={file.open}>
                <span className={`${s.rowTitle} ${s.rowMonoTitle}`}>{file.name}</span>
                <span className={s.chip}>{file.badge}</span>
                <span className={`${s.rowMeta} ${styles.fileMeta}${file.missing ? ` ${styles.missing}` : ""}`}>
                  {file.missing ? t("agents.managedFiles.missing") : [
                    file.size != null ? formatSize(file.size) : null,
                    new Date(file.time).toLocaleDateString(i18n.resolvedLanguage),
                  ].filter(Boolean).join(" · ")}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : !loading && !workspaceUnavailable && !workspace.data?.partial && !managedUnavailable && (
        <p className={s.dim}>{t(hasManagedFiles ? "agents.managedFiles.empty" : "agents.artifactsEmpty")}</p>
      )}
      {hasManagedFiles && !managedUnavailable && nextCursor != null && (
        <button type="button" className={`btn-subtle btn-sm ${styles.more}`}
          disabled={busy || managed.loading} onClick={() => void loadMore()}>{t("common.loadMore")}</button>
      )}

      {selected && <Modal open title={selected.name} width={560} dismissible={!busy}
        onClose={() => setSelected(null)}
        footer={<div className={styles.footer}>
          {selected.status !== "deleted" && <button type="button" className={styles.danger}
            disabled={busy} onClick={() => void remove()}>{t("common.delete")}</button>}
          <div className={styles.actions}>
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => setSelected(null)}>{t("common.close")}</button>
            {selected.status === "available" && <button type="button" className="btn-primary"
              disabled={busy || !name.trim() || name === selected.name} onClick={() => void rename()}>{t("common.save")}</button>}
          </div>
        </div>}>
        {selected.status === "available" ? <>
          {previewFailed ? <p className={styles.state}>{t("agents.managedFiles.previewUnavailable")}</p>
            : imagePreview ? <img className={styles.preview} src={previewUrl!} alt={selected.name} onError={() => setPreviewFailed(true)} />
              : textPreview ? <pre className={styles.previewText}>{preview ?? t("common.loading")}</pre> : null}
          <div className={styles.actions}>
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => {
              void revealManagedAgentFile(backend, agentId, selected.fileId, true).catch(failure => setError(errorText(failure)));
            }}>{t("agents.managedFiles.open")}</button>
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => {
              void revealManagedAgentFile(backend, agentId, selected.fileId).catch(failure => setError(errorText(failure)));
            }}>{t("chat.artifactsRevealInFolder")}</button>
            <a className="btn-secondary" href={managedAgentFileUrl(backend, agentId, selected.fileId)} download>
              {t("agents.managedFiles.download")}
            </a>
          </div>
          <Field label={t("agents.managedFiles.filename")} error={error} errorId={errorId}>
            <TextInput value={name} disabled={busy} aria-invalid={!!error}
              aria-describedby={error ? errorId : undefined}
              onChange={(event) => { setName(event.target.value); setError(null); }}
              onKeyDown={(event) => { if (event.key === "Enter" && name.trim() && name !== selected.name) void rename(); }} />
          </Field>
        </> : <p className={styles.state} role="status">{error || t(selected.status === "deleted"
          ? "agents.managedFiles.errors.AGENT_FILE_DELETED" : "agents.managedFiles.missing")}</p>}
      </Modal>}
    </>
  );
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
