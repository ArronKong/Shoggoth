import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import Modal from "../components/Modal";
import GroupChatMarkdown from "./GroupChatMarkdown";
import FusionLoader from "../components/FusionLoader";
import { readGroupChatMessage } from "../api/groupReads";
import type { GroupChatMember, GroupChatMessage, GroupResultPage } from "../types";
import { groupReplyBody } from "../lib/groupReply";
import styles from "./GroupChatPanel.module.css";

/** 按不可变消息读取正文，每次最多一页；最后一页校验全文，跨群切换会废弃在途响应。 */
export default function GroupChatFullMessage({ groupId, message, onClose = () => {}, members, onMemberClick }: {
  groupId: string; message: GroupChatMessage; onClose?(): void;
  members?: GroupChatMember[]; onMemberClick?(memberId: string): void;
}) {
  const { t } = useTranslation();
  const [result, setResult] = useState<{ page: GroupResultPage; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [offset, setOffset] = useState(0);
  const pages = useRef(new Map<number, string>());
  const version = useRef<{ digest: string; bytes: number } | null>(null);
  const expectedDigest = message.fullResult?.digest ?? null;
  const expectedBytes = message.fullResult?.bytes;
  useEffect(() => { pages.current.clear(); version.current = null; setResult(null); setOffset(0); }, [groupId, message.id]);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    void (async () => {
      const pinned = expectedDigest ? { digest: expectedDigest, bytes: expectedBytes } : version.current;
      const { page } = await readGroupChatMessage(groupId, { seq: message.seq, offset,
        digest: pinned?.digest ?? null });
      const size = new TextEncoder().encode(page.text).length;
      if (page.offset !== offset || (pinned && (page.digest !== pinned.digest
        || page.totalBytes !== pinned.bytes)) || size > 16 * 1024
        || (page.nextOffset === null ? offset + size !== page.totalBytes : size === 0 || page.nextOffset !== offset + size)) {
        throw new Error(t("groupChat.fullResult.mismatch"));
      }
      const text = [...pages.current].filter(([start]) => start < offset).sort(([a], [b]) => a - b)
        .map(([, text]) => text).join("") + page.text;
      if (page.nextOffset === null) {
        const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
        if (Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("") !== page.digest) {
          throw new Error(t("groupChat.fullResult.mismatch"));
        }
      }
      if (alive) { version.current = { digest: page.digest, bytes: page.totalBytes }; pages.current.set(offset, page.text); setResult({ page, text }); }
    })().catch((cause) => { if (alive) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [groupId, message.id, message.seq, expectedDigest, expectedBytes, offset, t]);

  return <Modal open width={800} onClose={onClose} title={t("groupChat.fullResult.title")}
    subtitle={t("groupChat.fullResult.progress", { loaded: new TextEncoder().encode(result?.text ?? "").length,
      total: expectedBytes ?? result?.page.totalBytes ?? 0 })}
    footer={<button type="button" className="btn" onClick={onClose}>{t("common.close")}</button>}>
    {error && <p className={styles.error}>{error}</p>}
    {result && <div className={styles.artifactBox}><GroupChatMarkdown text={groupReplyBody(message, result.text)}
      className="chat-md" members={members} onMemberClick={onMemberClick} /></div>}
    {loading ? <FusionLoader size="sm" /> : result?.page.nextOffset != null && !error && (
      <button type="button" className="btn" onClick={() => setOffset(result.page.nextOffset!)}>{t("groupChat.fullResult.more")}</button>
    )}
    {result?.page.nextOffset === null && !error && <p className={styles.muted}>{t("groupChat.fullResult.verified")}</p>}
  </Modal>;
}
