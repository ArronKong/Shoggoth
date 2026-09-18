import AgentAvatarView from "../../components/AgentAvatar";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { getAgent, getAgentFile } from "../../api/client";
import { usePageCache } from "../../lib/usePageCache";
import styles from "./ImmersivePanels.module.css";

// 当前 agent 的档案面板（只读 v1）：getAgent 详情（名/emoji/模型/工作区/profile/
// 身份文件清单）+ 点击文件内联查看（getAgentFile 按需拉取）。文件说明复用
// agents.fileDesc.* 既有文案（按大写词干取）。编辑去「代理」页（YAGNI）。
export default function ImmersiveProfilePanel({
  backendId,
  agentId,
  avatarVersion,
}: {
  backendId: string;
  agentId: string;
  avatarVersion: number;
}) {
  const { t } = useTranslation();
  const { data: detail, loading } = usePageCache(`immersive:profile:${backendId}:${agentId}`, () => getAgent(backendId, agentId));
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [fileBody, setFileBody] = useState<{ name: string; content: string } | null>(null);
  const [fileBusy, setFileBusy] = useState(false);

  const toggleFile = (name: string) => {
    if (openFile === name) {
      setOpenFile(null);
      return;
    }
    setOpenFile(name);
    if (fileBody?.name !== name) {
      setFileBusy(true);
      setFileBody(null);
      getAgentFile(backendId, agentId, name)
        .then((f) => setFileBody({ name, content: f.missing ? t("chat.panelFileMissing") : f.content || "" }))
        .catch((e) => setFileBody({ name, content: e instanceof Error ? e.message : String(e) }))
        .finally(() => setFileBusy(false));
    }
  };

  if (!detail) {
    return <div className={styles.empty}>{loading ? t("common.loading") : t("chat.panelProfileEmpty")}</div>;
  }
  const fileDesc = (name: string): string => {
    const stem = name.replace(/\.md$/i, "").toUpperCase();
    return t(`agents.fileDesc.${stem}`, { defaultValue: t("agents.fileDescDefault") });
  };
  return (
    <div>
      <div className={styles.profileHead}>
        <AgentAvatarView agentId={agentId} name={detail.name} version={avatarVersion} className={styles.profileAvatar} />
        <div>
          <div className={styles.profileName}>
            {detail.emoji ? `${detail.emoji} ` : ""}
            {detail.name || detail.id}
          </div>
          <div className={styles.profileMeta}>
            {detail.backendId}
            {detail.profile ? ` · ${detail.profile}` : ""}
            {detail.isDefault ? ` · ${t("agents.default", { defaultValue: "default" })}` : ""}
          </div>
        </div>
      </div>
      {(detail.model || detail.provider) && (
        <div className={styles.kv}>
          <span className={styles.kvLabel}>{t("chat.panelModel")}</span>
          <span className={styles.kvValue}>
            {detail.provider ? `${detail.provider}/` : ""}
            {detail.model || ""}
          </span>
        </div>
      )}
      {detail.workspace && (
        <div className={styles.kv}>
          <span className={styles.kvLabel}>{t("chat.panelWorkspace")}</span>
          <span className={`${styles.kvValue} ${styles.mono}`}>{detail.workspace}</span>
        </div>
      )}
      {(detail.files?.length ?? 0) > 0 && (
        <>
          <div className={styles.sectionTitle}>{t("chat.panelFiles")}</div>
          <div className={styles.list}>
            {detail.files!.map((f) => (
              <div key={f.name}>
                <button
                  type="button"
                  className={openFile === f.name ? `${styles.fileBtn} ${styles.fileBtnActive}` : styles.fileBtn}
                  onClick={() => toggleFile(f.name)}
                >
                  <span className={styles.fileName}>{f.name}</span>
                  <span className={styles.fileDesc}>{fileDesc(f.name)}</span>
                </button>
                {openFile === f.name &&
                  (fileBusy && fileBody?.name !== f.name ? (
                    <div className={styles.loading}>{t("common.loading")}</div>
                  ) : fileBody?.name === f.name ? (
                    <pre className={styles.fileContent}>{fileBody.content || t("chat.panelFileEmpty")}</pre>
                  ) : null)}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
