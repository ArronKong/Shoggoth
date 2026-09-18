import { useTranslation } from "react-i18next";
import { getAgent, getBoards, getTaskBoard } from "../../api/client";
import type { UnifiedTask } from "../../types";
import { usePageCache } from "../../lib/usePageCache";
import { nativeBoardsForProfile, usesExplicitBoardIdentity } from "../../lib/shoggothDomainUi";
import styles from "./ImmersivePanels.module.css";

// 当前 agent 的看板任务面板（只读 v1）。归属匹配照抄 AgentsPage kanban tab：
// OpenClaw 工作板卡带 agentId；Hermes 看板卡带 assignee(=profile 名)——按字段存在
// 与否匹配，不特判后端 id。readOnly:true 只是旧客户端 hint；8.1 工作板读取
// 本身始终是纯读投影（ARCHITECTURE §9）。
interface AgentCard {
  task: UnifiedTask;
  columnName: string;
}

async function fetchAgentCards(backend: string, agentId: string): Promise<AgentCard[]> {
  const detail = await getAgent(backend, agentId).catch(() => null);
  const owner = detail?.profile || detail?.id || agentId;
  const boards = await getBoards(backend).catch(() => []);
  if (usesExplicitBoardIdentity(boards)) {
    const rows = await Promise.all(nativeBoardsForProfile(boards, detail?.profile).map(async (board) => {
      const value = await getTaskBoard(backend, { board: board.id, readOnly: true });
      return (value.columns || []).flatMap((column) =>
        (column.tasks || []).map((task) => ({ task, columnName: column.name || column.id })),
      );
    }));
    return rows.flat();
  }
  const board = await getTaskBoard(backend, { readOnly: true });
  return (board.columns || []).flatMap((c) =>
    (c.tasks || [])
      .filter((tk) => tk.agentId === agentId || (!!tk.assignee && tk.assignee === owner))
      .map((tk) => ({ task: tk, columnName: c.name || c.id })),
  );
}

export default function ImmersiveKanbanPanel({ backendId, agentId }: { backendId: string; agentId: string }) {
  const { t } = useTranslation();
  const { data: cards, loading } = usePageCache(
    `immersive:kanban:${backendId}:${agentId}`,
    () => fetchAgentCards(backendId, agentId),
  );
  if (!cards?.length) {
    return <div className={styles.empty}>{loading ? t("common.loading") : t("chat.panelKanbanEmpty")}</div>;
  }
  // 按列分组（保持看板列顺序：cards 本身按列 flatMap 生成，顺序即列顺序）
  const byCol: { name: string; tasks: UnifiedTask[] }[] = [];
  for (const c of cards) {
    const last = byCol[byCol.length - 1];
    if (last && last.name === c.columnName) last.tasks.push(c.task);
    else byCol.push({ name: c.columnName, tasks: [c.task] });
  }
  return (
    <div>
      {byCol.map((col) => (
        <div key={col.name}>
          <div className={styles.colTitle}>
            {col.name} · {col.tasks.length}
          </div>
          <div className={styles.list}>
            {col.tasks.map((tk) => (
              <div key={tk.id} className={styles.item}>
                <div className={styles.itemHead}>
                  <span className={styles.itemName}>{tk.title || tk.id}</span>
                </div>
                {tk.excerpt && <div className={styles.itemSub}>{tk.excerpt}</div>}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
