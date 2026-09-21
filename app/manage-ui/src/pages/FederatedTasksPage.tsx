import AgentAvatarView from "../components/AgentAvatar";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  CanonicalKanbanStatus,
  FederatedKanbanSource,
  FederatedTaskBoard,
  UnifiedTask,
} from "../types";
import {
  createFederatedKanbanProject,
  createFederatedTask,
  deleteFederatedKanbanProject,
  getFederatedTaskBoard,
  moveFederatedTask,
} from "../api/client";
import { Field, Option, Select, TextArea, TextInput } from "../components/Field";
import FusionLoader from "../components/FusionLoader";
import Modal from "../components/Modal";
import { PageHead } from "../components/PageHead";
import SearchCapsule from "../components/SearchCapsule";
import { useConfirm, usePrompt, useToast } from "../components/ui";
import { findKanbanDeepLinkTask, resolveKanbanDeepLinkSource } from "../lib/kanbanDeepLink";
import { usePageCache } from "../lib/usePageCache";
import { useRegisterPageLoading, useRegisterPageRefresh } from "../lib/page-refresh";
import { useStickyState } from "../lib/useStickyState";
import styles from "./FederatedTasksPage.module.css";
import TasksPage from "./TasksPage";

const STATUSES: CanonicalKanbanStatus[] = ["triage", "ready", "in_progress", "review", "blocked", "done", "archived"];

function canCreateStatus(
  kind: FederatedKanbanSource["kind"] | undefined,
  status: CanonicalKanbanStatus,
): boolean {
  if (!kind || status === "in_progress") return false;
  if (status === "review") return kind === "workboard";
  return true;
}

function canMoveTo(task: UnifiedTask, status: CanonicalKanbanStatus): boolean {
  if (status === "in_progress") return false;
  if (status === "review" && task.sourceKind !== "workboard") return false;
  if (task.live && ["triage", "ready", "archived"].includes(status)) return false;
  return true;
}

function allTasks(board?: FederatedTaskBoard): UnifiedTask[] {
  return board?.columns.flatMap((column) => column.tasks) || [];
}

function sourceFor(board: FederatedTaskBoard | undefined, task: UnifiedTask): FederatedKanbanSource | undefined {
  return board?.project.sources.find((source) => (
    source.backendId === task.backendId
    && (!task.sourceBoard || source.boardId === task.sourceBoard || source.slug === task.sourceBoard)
  ));
}

function formatWhen(value?: number): string {
  if (!value) return "";
  return new Intl.DateTimeFormat(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(value);
}

function formatAge(seconds?: number): string {
  if (typeof seconds !== "number") return "";
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (seconds < 60) return formatter.format(-Math.max(1, Math.floor(seconds)), "second");
  if (seconds < 3600) return formatter.format(-Math.floor(seconds / 60), "minute");
  if (seconds < 86400) return formatter.format(-Math.floor(seconds / 3600), "hour");
  return formatter.format(-Math.floor(seconds / 86400), "day");
}

function formatCardDate(task: UnifiedTask): string {
  const value = task.updatedAt || task.createdAt;
  if (!value) return "";
  return new Intl.DateTimeFormat(undefined, { month: "2-digit", day: "2-digit" }).format(value);
}

function CardAvatar({ id }: { id?: string }) {
  return <AgentAvatarView agentId={id} className="kanban-avatar" />;
}

export default function FederatedTasksPage() {
  const { t } = useTranslation();
  const toast = useToast();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const deepLink = useMemo(() => {
    const query = new URLSearchParams(window.location.hash.split("?")[1] || "");
    return {
      project: query.get("project") || "",
      backend: query.get("backend") || "",
      board: query.get("board") || "",
      task: query.get("task") || "",
    };
  }, []);
  const [projectKey, setProjectKey] = useStickyState("tasks.project", "default", deepLink.project || undefined);
  const [projectCacheVersion, setProjectCacheVersion] = useState(0);
  const [agentFilter, setAgentFilter] = useStickyState("tasks.agent", "");
  const [query, setQuery] = useStickyState("tasks.query", "");
  const cache = usePageCache<FederatedTaskBoard>(
    `tasks:federated:${projectKey}:${projectCacheVersion}`,
    () => getFederatedTaskBoard(projectKey),
  );
  const { data: board, loading, error, refresh, replace } = cache;
  useRegisterPageRefresh("/tasks", refresh);
  useRegisterPageLoading("/tasks", loading);

  const deepLinkProjectResolved = useRef(false);
  const deepLinkTaskOpened = useRef(false);
  useEffect(() => {
    if (!board) return;
    if (!deepLinkProjectResolved.current) {
      deepLinkProjectResolved.current = true;
      const match = resolveKanbanDeepLinkSource(board.projects, deepLink);
      if (match && match.projectKey !== projectKey) {
        setProjectKey(match.projectKey);
        return;
      }
    }
  }, [board, deepLink, projectKey, setProjectKey]);

  useEffect(() => {
    if (!board || board.project.key === projectKey) return;
    if (!board.projects.some((project) => project.key === projectKey)) {
      setProjectKey(board.project.key);
    }
  }, [board, projectKey, setProjectKey]);

  useEffect(() => {
    if (!board) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [board, refresh]);

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredColumns = useMemo(() => (board?.columns || []).map((column) => ({
    ...column,
    tasks: column.tasks.filter((task) => (
      (!agentFilter || task.agentKey === agentFilter)
      && (!normalizedQuery || `${task.title} ${task.excerpt || ""} ${task.rawStatus || ""}`.toLocaleLowerCase().includes(normalizedQuery))
    )),
  })), [agentFilter, board, normalizedQuery]);

  const total = allTasks(board).length;
  const doneCount = board?.columns.find((column) => column.id === "done")?.tasks.length || 0;
  const archivedCount = board?.columns.find((column) => column.id === "archived")?.tasks.length || 0;
  const openCount = total - doneCount - archivedCount;
  const agentByKey = useMemo(() => new Map((board?.agents || []).map((agent) => [agent.agentKey, agent])), [board]);

  const [projectModal, setProjectModal] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [projectDescription, setProjectDescription] = useState("");
  const [projectSaving, setProjectSaving] = useState(false);
  const createProject = async () => {
    const name = projectName.trim();
    if (!name) return;
    setProjectSaving(true);
    try {
      const project = await createFederatedKanbanProject({ name, description: projectDescription.trim() || undefined });
      setProjectModal(false);
      setProjectName("");
      setProjectDescription("");
      setProjectCacheVersion((version) => version + 1);
      setProjectKey(project.key);
      toast.success(t("tasks.projectCreated"));
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setProjectSaving(false);
    }
  };

  const [projectDeleting, setProjectDeleting] = useState(false);
  const deleteProject = async () => {
    if (projectKey === "default" || projectDeleting) return;
    const project = board?.projects.find((row) => row.key === projectKey);
    const projectNameValue = project?.name || projectKey;
    const backendNames = [...new Set((project?.sources || []).map((source) => source.backendName || source.backendId))];
    const unsupportedBackends = [...new Set((project?.sources || [])
      .filter((source) => !["workboard", "hermes"].includes(source.kind))
      .map((source) => source.backendName || source.backendId))];
    if (unsupportedBackends.length > 0) {
      toast.error(t("tasks.projectDeleteUnsupported", { backends: unsupportedBackends.join("、") }));
      return;
    }
    const accepted = await confirm({
      title: t("tasks.deleteProjectTitle"),
      message: t("tasks.deleteProjectConfirm", {
        name: projectNameValue,
        count: project?.total || 0,
        backends: backendNames.length > 0 ? backendNames.join("、") : t("tasks.localKanban"),
      }),
      confirmLabel: t("common.delete"),
      danger: true,
    });
    if (!accepted) return;
    setProjectDeleting(true);
    try {
      await deleteFederatedKanbanProject(projectKey);
      setProjectCacheVersion((version) => version + 1);
      setProjectKey("default");
      toast.success(t("tasks.projectDeleted"));
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setProjectDeleting(false);
    }
  };

  const [createModal, setCreateModal] = useState(false);
  const [createTitle, setCreateTitle] = useState("");
  const [createBody, setCreateBody] = useState("");
  const [createAgent, setCreateAgent] = useState("");
  const [createStatus, setCreateStatus] = useState<CanonicalKanbanStatus>("triage");
  const [creating, setCreating] = useState(false);
  const selectedCreateAgent = board?.agents.find((agent) => agent.agentKey === createAgent);
  const openCreate = (status: CanonicalKanbanStatus = "triage") => {
    const preferred = board?.agents.find((agent) => agent.agentKey === agentFilter);
    const agent = preferred
      ? (canCreateStatus(preferred.sourceKind, status) ? preferred : undefined)
      : board?.agents.find((candidate) => canCreateStatus(candidate.sourceKind, status));
    if (!agent?.agentKey) return;
    setCreateAgent(agent.agentKey);
    setCreateStatus(status);
    setCreateTitle("");
    setCreateBody("");
    setCreateModal(true);
  };
  const changeCreateAgent = (value: string) => {
    setCreateAgent(value);
    const agent = board?.agents.find((row) => row.agentKey === value);
    if (!canCreateStatus(agent?.sourceKind, createStatus)) setCreateStatus("ready");
  };
  const submitCreate = async () => {
    if (!createTitle.trim() || !createAgent) return;
    setCreating(true);
    try {
      await createFederatedTask(projectKey, createAgent, {
        title: createTitle.trim(), body: createBody, status: createStatus,
      });
      setCreateModal(false);
      await refresh();
      toast.success(t("tasks.createdToast"));
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCreating(false);
    }
  };

  const [selectedTask, setSelectedTask] = useState<UnifiedTask | null>(null);
  const closeDetail = () => {
    setSelectedTask(null);
    void refresh();
  };

  useEffect(() => {
    if (!board || deepLinkTaskOpened.current || !deepLink.task) return;
    const source = resolveKanbanDeepLinkSource(board.projects, deepLink);
    const task = findKanbanDeepLinkTask(allTasks(board), deepLink, source?.backendId);
    if (!task) return;
    deepLinkTaskOpened.current = true;
    setSelectedTask(task);
  }, [board, deepLink]);

  const [dragged, setDragged] = useState<UnifiedTask | null>(null);
  const [dragOver, setDragOver] = useState<CanonicalKanbanStatus | null>(null);
  const moveCard = async (task: UnifiedTask, status: CanonicalKanbanStatus) => {
    if (task.column === status || !board || !canMoveTo(task, status)) return;
    let completion: { result?: string; summary?: string; note?: string } | undefined;
    const source = sourceFor(board, task);
    if (status === "done" && source?.capabilities?.completionSummary) {
      const summary = await prompt({
        title: t("tasks.completionSummaryTitle"),
        message: t("tasks.completionSummary", { label: t("tasks.completionLabelOne") }),
        placeholder: t("tasks.completionSummaryPlaceholder"),
        confirmLabel: t("tasks.complete"),
        required: true,
        multiline: true,
      });
      if (summary === null) return;
      completion = { result: summary, summary };
    }
    const previous = board;
    const optimistic: FederatedTaskBoard = {
      ...board,
      columns: board.columns.map((column) => ({
        ...column,
        tasks: column.id === status
          ? [...column.tasks, { ...task, column: status }]
          : column.tasks.filter((row) => row.taskKey !== task.taskKey),
      })),
    };
    replace(optimistic);
    setSelectedTask((current) => current && current.taskKey === task.taskKey ? { ...current, column: status } : current);
    try {
      await moveFederatedTask(task, status, undefined, completion);
      await refresh();
      toast.success(t("tasks.movedToast"));
    } catch (cause) {
      replace(previous);
      setSelectedTask((current) => current?.taskKey === task.taskKey ? task : current);
      toast.error(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <div className={`page management-page tasks-page ${styles.page}`}>
      <PageHead
        title={t("tasks.pageTitle")}
        subtitle={(
          <div className="kb-stats">
            <span>{t("tasks.statOpen", { count: board ? openCount : "—" })}</span>
            <span>{t("tasks.statDone", { count: board ? doneCount : "—" })}</span>
            <span>{t("tasks.statTotal", { count: board ? total : "—" })}</span>
          </div>
        )}
      />

      <div className={styles.projectBar}>
        <span className={styles.projectLabel}>{t("tasks.project")}</span>
        <span className={styles.projectSelect}>
          <Select value={projectKey} onChange={setProjectKey}>
            {(board?.projects || []).map((project) => (
              <Option key={project.key} value={project.key}>{project.name} · {project.total}</Option>
            ))}
          </Select>
        </span>
        <span className={styles.projectCount}>{t("tasks.boardTasks", { count: total })}</span>
        <button className="ui-cbtn ui-cbtn--sm" onClick={() => setProjectModal(true)}>{t("tasks.newProject")}</button>
        <button
          className="ui-cbtn ui-cbtn--sm ui-cbtn--danger"
          onClick={() => void deleteProject()}
          disabled={projectKey === "default" || projectDeleting}
          title={projectKey === "default" ? t("tasks.defaultProjectDeleteHint") : undefined}
        >
          {t("tasks.deleteProject")}
        </button>
      </div>

      <div className="ui-toolbar">
        <span className={`${styles.agentFilter} kb-pill`}>
          <span aria-hidden="true">◎</span>
          <Select value={agentFilter} onChange={setAgentFilter}>
            <Option value="">{t("tasks.allAgents")}</Option>
            {(board?.agents || []).map((agent) => (
              <Option key={agent.agentKey || `${agent.backendId}:${agent.id}`} value={agent.agentKey || ""}>
                {agent.name} · {agent.backendName}
              </Option>
            ))}
          </Select>
        </span>
        <span className="ui-toolbar-end">
          <SearchCapsule value={query} onChange={setQuery} placeholder={t("tasks.searchPlaceholder")} />
          <button className="ui-cbtn ui-cbtn--gold" onClick={() => openCreate()} disabled={!board?.agents.length}>
            {t("tasks.newTaskBtn")}
          </button>
        </span>
      </div>

      {error && <div className={styles.error} role="alert">{t("tasks.error", { msg: error })}</div>}
      {!!board?.errors.length && (
        <div className={styles.degraded} role="status">
          {t("tasks.partialBackendError", { count: board.errors.length })}
        </div>
      )}
      {loading && !board ? (
        <div className="page-loading"><FusionLoader label={t("common.loading")} /></div>
      ) : (
        <div className={styles.boardScroller}>
          <div className={styles.board}>
            {STATUSES.map((status, index) => {
              const column = filteredColumns.find((item) => item.id === status) || { id: status, name: status, tasks: [] };
              const createAgents = agentFilter
                ? board?.agents.filter((agent) => agent.agentKey === agentFilter)
                : board?.agents;
              const canCreateInColumn = !!createAgents?.some((agent) => canCreateStatus(agent.sourceKind, status));
              return (
                <section
                  key={status}
                  className={`${styles.column} ${dragOver === status ? styles.dragOver : ""}`}
                  data-status={status}
                  style={{ "--column-index": index } as React.CSSProperties}
                  onDragOver={(event) => {
                    if (!dragged || !canMoveTo(dragged, status)) return;
                    event.preventDefault();
                    setDragOver(status);
                  }}
                  onDragLeave={() => setDragOver((current) => current === status ? null : current)}
                  onDrop={(event) => {
                    event.preventDefault();
                    setDragOver(null);
                    if (dragged) void moveCard(dragged, status);
                    setDragged(null);
                  }}
                >
                  <header className={styles.columnHead}>
                    <span className={styles.columnTitle}><i aria-hidden="true" />{t(`tasks.unifiedColumns.${status}`)}</span>
                    <span className={styles.columnCount}>{column.tasks.length}</span>
                    {canCreateInColumn && (
                      <button className={styles.columnAdd} onClick={() => openCreate(status)} aria-label={t("tasks.createInColumn")}>＋</button>
                    )}
                  </header>
                  <div className={styles.cardList}>
                    {column.tasks.map((task) => {
                      const agent = task.agentKey ? agentByKey.get(task.agentKey) : undefined;
                      const source = sourceFor(board, task);
                      return (
                        <article
                          key={task.taskKey || `${task.backendId}:${task.id}`}
                          className={styles.card}
                          draggable
                          tabIndex={0}
                          onDragStart={() => setDragged(task)}
                          onDragEnd={() => { setDragged(null); setDragOver(null); }}
                          onClick={() => setSelectedTask(task)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              setSelectedTask(task);
                            }
                          }}
                        >
                          <div className={styles.cardTopline}>
                            <span className={styles.sourceBadge}>{source?.backendName || task.backendId}</span>
                            {task.live && <span className={styles.live}>●</span>}
                            {task.warnings && (
                              <span className={styles.warning} title={t("tasks.attentionItems", { count: task.warnings.count })}>
                                ⚠ {task.warnings.count}
                              </span>
                            )}
                            {task.rawStatus && task.rawStatus !== status && <span className={styles.rawStatus}>{task.rawStatus}</span>}
                          </div>
                          <h3>{task.title}</h3>
                          {task.excerpt && <p>{task.excerpt}</p>}
                          {!!task.labels?.length && (
                            <div className={styles.labels}>
                              {task.labels.map((label) => <span key={label}>{label}</span>)}
                            </div>
                          )}
                          {task.scheduledAt && (
                            <div className={styles.schedule}>◷ {t("tasks.scheduledFor", { time: formatWhen(task.scheduledAt) })}</div>
                          )}
                          <div className={styles.cardSignals}>
                            {task.sourceKind === "hermes" && <span>{task.id}</span>}
                            {task.tenant && <span>{task.tenant}</span>}
                            {typeof task.priority === "number" && task.priority > 0 && <span>P{task.priority}</span>}
                            {task.progress && task.progress.total > 0 && <span>✓ {task.progress.done}/{task.progress.total}</span>}
                            {!!task.commentCount && <span>💬 {task.commentCount}</span>}
                            {!!task.linkCount && task.linkCount.parents + task.linkCount.children > 0 && (
                              <span>↔ {task.linkCount.parents + task.linkCount.children}</span>
                            )}
                            {!!task.badges?.comments && <span>💬 {task.badges.comments}</span>}
                            {!!task.badges?.attempts && <span>↻ {task.badges.attempts}</span>}
                            {!!task.badges?.proof && <span>✓ {task.badges.proof}</span>}
                            {!!task.badges?.artifacts && <span>📎 {task.badges.artifacts}</span>}
                            {!!task.badges?.diagnostics && <span>⚠ {task.badges.diagnostics}</span>}
                            {!!task.badges?.failures && <span>✕ {task.badges.failures}</span>}
                            {task.badges?.claimed && <span>🔒</span>}
                            {task.badges?.stale && <span>⏳</span>}
                            {formatAge(task.age?.createdAgeSeconds) && <span>{formatAge(task.age?.createdAgeSeconds)}</span>}
                            {formatCardDate(task) && <span>{formatCardDate(task)}</span>}
                          </div>
                          <footer className={styles.cardMeta}>
                            <CardAvatar id={task.agentId} />
                            <span>{agent?.name || task.assignee || task.agentId || t("tasks.unassigned")}</span>
                            {task.priorityLevel && <span className={styles.metaEnd}>{t(`tasks.priority.${task.priorityLevel}`)}</span>}
                          </footer>
                        </article>
                      );
                    })}
                    {column.tasks.length === 0 && canCreateInColumn && (
                      <button className={styles.emptyColumn} onClick={() => openCreate(status)}>
                        <span>＋</span>{t("tasks.emptyColumnAction")}
                      </button>
                    )}
                  </div>
                </section>
              );
            })}
          </div>
        </div>
      )}

      <Modal
        open={projectModal}
        title={t("tasks.newProjectTitle")}
        onClose={() => setProjectModal(false)}
        dismissible={!projectSaving}
        footer={(
          <>
            <button className="ui-cbtn" onClick={() => setProjectModal(false)} disabled={projectSaving}>{t("common.cancel")}</button>
            <button className="ui-cbtn ui-cbtn--gold" onClick={() => void createProject()} disabled={projectSaving || !projectName.trim()}>
              {t("tasks.createProject")}
            </button>
          </>
        )}
      >
        <Field label={t("tasks.projectName")}><TextInput value={projectName} onChange={(event) => setProjectName(event.target.value)} autoFocus /></Field>
        <Field label={t("tasks.boardDescField")}><TextArea value={projectDescription} onChange={(event) => setProjectDescription(event.target.value)} /></Field>
      </Modal>

      <Modal
        open={createModal}
        title={t("tasks.newTaskTitle")}
        subtitle={board?.project.name}
        onClose={() => setCreateModal(false)}
        dismissible={!creating}
        footer={(
          <>
            <button className="ui-cbtn" onClick={() => setCreateModal(false)} disabled={creating}>{t("common.cancel")}</button>
            <button
              className="ui-cbtn ui-cbtn--gold"
              onClick={() => void submitCreate()}
              disabled={creating || !createTitle.trim() || !createAgent || !canCreateStatus(selectedCreateAgent?.sourceKind, createStatus)}
            >
              {t("tasks.createTask")}
            </button>
          </>
        )}
      >
        <Field label={t("tasks.titleField")}><TextInput value={createTitle} onChange={(event) => setCreateTitle(event.target.value)} autoFocus /></Field>
        <Field label={t("tasks.agentField")}>
          <Select value={createAgent} onChange={changeCreateAgent}>
            {(board?.agents || []).map((agent) => (
              <Option key={agent.agentKey || agent.id} value={agent.agentKey || ""}>{agent.name} · {agent.backendName}</Option>
            ))}
          </Select>
        </Field>
        <Field label={t("tasks.statusLabel")}>
          <Select value={createStatus} onChange={(value) => setCreateStatus(value as CanonicalKanbanStatus)}>
            {STATUSES.map((status) => (
              <Option key={status} value={status} disabled={!canCreateStatus(selectedCreateAgent?.sourceKind, status)}>
                {t(`tasks.unifiedColumns.${status}`)}
              </Option>
            ))}
          </Select>
        </Field>
        <Field label={t("tasks.bodyField")} hint={t("tasks.bodyHint")}><TextArea value={createBody} onChange={(event) => setCreateBody(event.target.value)} rows={8} /></Field>
      </Modal>

      {selectedTask && (
        <TasksPage
          key={selectedTask.taskKey || `${selectedTask.backendId}:${selectedTask.sourceBoard || ""}:${selectedTask.id}`}
          detailOnly={{
            backendId: selectedTask.backendId,
            boardId: selectedTask.sourceBoard,
            taskId: selectedTask.id,
            onClose: closeDetail,
          }}
        />
      )}
    </div>
  );
}
