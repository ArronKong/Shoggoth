import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Field, Option, Select } from "../components/Field";
import ChatMarkdown from "../components/ChatMarkdown";
import FusionLoader from "../components/FusionLoader";
import { getGroupChatMemberRole, getGroupChatMemberRoleHistory } from "../api/client";
import type { GroupChatMemberRole, GroupChatMemberRoleRevision } from "../types";
import styles from "./GroupChatPanel.module.css";
import documentStyles from "./GroupChatRoleDocument.module.css";

type RolePage = Extract<GroupChatMemberRole, { ok: true }>;

/** 公开角色文档按固定版本读完；跨版本不能拼接，原文完整性与脱敏来源分别标记。 */
export default function GroupChatRoleDocument({ groupId, memberId, variant = "default" }: {
  groupId: string; memberId: string; variant?: "default" | "compact";
}) {
  const { t } = useTranslation();
  const [revision, setRevision] = useState("latest");
  const [history, setHistory] = useState<GroupChatMemberRoleRevision[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [result, setResult] = useState<{ page: RolePage; text: string; verified: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const state = useRef<{ generation: number; busy: boolean; result: typeof result }>({ generation: 0, busy: false, result: null });
  const historyGeneration = useRef(0);
  const loadHistory = useCallback(async (before?: string) => {
    const generation = ++historyGeneration.current;
    try {
      const page = await getGroupChatMemberRoleHistory(groupId, memberId, { before });
      if (historyGeneration.current !== generation) return;
      setHistory(previous => before ? [...previous, ...page.snapshots.filter(item => !previous.some(old => old.id === item.id))] : page.snapshots);
      setHistoryCursor(page.nextCursor);
    } catch { /* 原文仍能读取；下一次打开重新取得版本目录。 */ }
  }, [groupId, memberId]);
  const read = useCallback(async (cursor?: string) => {
    if (state.current.busy) return;
    state.current.busy = true; setLoading(true); setError(null);
    const generation = state.current.generation;
    try {
      const page = await getGroupChatMemberRole(groupId, memberId, { revision, cursor });
      if (state.current.generation !== generation) return;
      if (!page.ok) throw new Error(t(`groupChat.card.code.${page.code}`));
      const previous = cursor ? state.current.result : null;
      const offset = previous ? new TextEncoder().encode(previous.text).length : 0;
      const size = new TextEncoder().encode(page.text).length;
      if ((page.offset !== undefined && page.offset !== offset) || size > 16 * 1024
        || (previous && (page.exportDigest !== previous.page.exportDigest || page.revisionId !== previous.page.revisionId
          || page.totalBytes !== previous.page.totalBytes || page.disclosurePolicyRevision !== previous.page.disclosurePolicyRevision))) {
        throw new Error(t("groupChat.fullResult.mismatch"));
      }
      const text = (previous?.text ?? "") + page.text;
      let verified = false;
      if (page.nextCursor === null && page.totalBytes !== undefined) {
        if (new TextEncoder().encode(text).length !== page.totalBytes) throw new Error(t("groupChat.fullResult.mismatch"));
        const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
        if (Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("") !== page.exportDigest) {
          throw new Error(t("groupChat.fullResult.mismatch"));
        }
        verified = true;
      }
      if (state.current.generation === generation) {
        state.current.result = { page, text, verified }; setResult(state.current.result);
      }
    } catch (cause) {
      if (state.current.generation === generation) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (state.current.generation === generation) { state.current.busy = false; setLoading(false); }
    }
  }, [groupId, memberId, revision, t]);
  useEffect(() => {
    state.current = { generation: state.current.generation + 1, busy: false, result: null };
    setResult(null); void read();
    return () => { state.current.generation++; state.current.busy = false; };
  }, [read]);
  useEffect(() => {
    void loadHistory();
    return () => { historyGeneration.current++; };
  }, [loadHistory]);

  const versionControls = <>
    <Field label={t("groupChat.card.documentVersion")}>
      <Select value={revision} onChange={setRevision} title={t("groupChat.card.documentVersion")}>
        <Option value="latest">{t("groupChat.card.latest")}</Option>
        {history.map(item => <Option key={item.id} value={item.id}>
          {t("groupChat.card.savedVersion", { version: item.sourceRevision ?? item.id.slice(0, 8) })}
        </Option>)}
      </Select>
    </Field>
    {historyCursor && <button type="button" className="btn-sm" onClick={() => void loadHistory(historyCursor)}>{t("groupChat.card.moreVersions")}</button>}
  </>;
  const verification = <>
    {result?.page.totalBytes !== undefined && <p className={styles.muted}>
      {t("groupChat.fullResult.progress", { loaded: new TextEncoder().encode(result.text).length, total: result.page.totalBytes })}
    </p>}
    {result?.verified && <p className={styles.muted}>{t("groupChat.fullResult.verified")}</p>}
  </>;
  if (variant === "compact") return <div className={documentStyles.compact}>
    {result?.page.disclosure === "redacted" && <p className={styles.muted}>{t("groupChat.card.redacted")}</p>}
    {result && <div className={documentStyles.text}>{result.text}</div>}
    {loading && <FusionLoader size="sm" />}
    {error && <p className={styles.error} role="alert">{error}</p>}
    {result?.page.nextCursor && !error && <button type="button" className={`btn ${documentStyles.more}`} disabled={loading}
      onClick={() => void read(result.page.nextCursor!)}>{t("groupChat.fullResult.more")}</button>}
    <details className={documentStyles.metadata}>
      <summary>{t("groupChat.card.documentVersion")}</summary>
      <div>{versionControls}{verification}</div>
    </details>
  </div>;

  return <>
    {versionControls}
    {result?.page.disclosure === "redacted" && <p className={styles.muted}>{t("groupChat.card.redacted")}</p>}
    <div className={styles.cardShared}>
      {result && <ChatMarkdown text={result.text} className="chat-md" />}
      {loading && <FusionLoader size="sm" />}
      {error && <p className={styles.error} role="alert">{error}</p>}
    </div>
    {result?.page.totalBytes !== undefined && <p className={styles.muted}>
      {t("groupChat.fullResult.progress", { loaded: new TextEncoder().encode(result.text).length, total: result.page.totalBytes })}
    </p>}
    {result?.page.nextCursor && !error && <button type="button" className="btn" disabled={loading}
      onClick={() => void read(result.page.nextCursor!)}>{t("groupChat.fullResult.more")}</button>}
    {result?.verified && <p className={styles.muted}>{t("groupChat.fullResult.verified")}</p>}
  </>;
}
