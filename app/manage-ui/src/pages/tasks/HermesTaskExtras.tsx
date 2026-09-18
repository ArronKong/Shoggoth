// Hermes 看板里「自己管自己状态 + 自己发请求」的那几块，从 TasksPage 拆出来：
// 附件区 / home 频道订阅 / 每任务模型覆盖 / 诊断恢复动作 / 板设置对话框 /
// profile 描述编辑。都是官方 kanban 插件里的独立组件，1:1 复刻其行为。
// 外观沿用看板既有的 .hk-* 皮肤（styles.css），不另起 CSS Module——半页模块半页
// 全局反而更碎。
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { BoardProfile, KanbanBoard, TaskAttachment, TaskDiagnostic, TaskModelOptions, UnifiedTaskDetail } from "../../types";
import {
  deleteTaskAttachment,
  describeBoardProfileAuto,
  getBoardProfiles,
  getTaskHomeChannels,
  getTaskModelOptions,
  reclaimTask,
  reassignTask,
  setTaskHomeSubscription,
  taskAttachmentUrl,
  updateBoard,
  updateBoardProfile,
  updateTask,
  uploadTaskAttachment,
} from "../../api/client";
import { Field, Option, Select, TextInput } from "../../components/Field";
import Modal, { DetailRow, ModalSection } from "../../components/Modal";
import { useConfirm, useToast } from "../../components/ui";

interface TaskCtx {
  backend: string;
  taskId: string;
  board?: string;
  onChanged: () => void | Promise<void>;
}

function fmtBytes(n?: number): string {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// 附件：上传（顺序，一个失败就停在明确状态）/ 下载 / 删除。
// 下载走浏览器原生导航——/__api 同源且服务端已经打了
// Content-Disposition: attachment，不需要官方那套 fetch→blob→合成 <a> 的绕行
// （他们绕是因为 dashboard 的鉴权头带不进 <a href>）。
// ---------------------------------------------------------------------------
export function AttachmentsSection({ ctx, attachments }: { ctx: TaskCtx; attachments: TaskAttachment[] }) {
  const { t } = useTranslation();
  const toast = useToast();
  const confirm = useConfirm();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const onPick = async (files: FileList | null) => {
    const list = Array.from(files || []);
    if (!list.length) return;
    setBusy(true);
    try {
      for (const f of list) await uploadTaskAttachment(ctx.backend, ctx.taskId, f, ctx.board);
      await ctx.onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = ""; // 同名文件再选一次也要触发 change
    }
  };

  const onDelete = async (a: TaskAttachment) => {
    if (!(await confirm({ title: t("tasks.removeAttachment"), message: a.filename, danger: true }))) return;
    try {
      await deleteTaskAttachment(ctx.backend, a.id, ctx.board);
      await ctx.onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <ModalSection title={`${t("tasks.attachments")} (${attachments.length})`}>
      <input ref={fileRef} type="file" multiple hidden onChange={(e) => onPick(e.target.files)} />
      <button className="btn-sm" disabled={busy} onClick={() => fileRef.current?.click()}>
        {busy ? t("tasks.uploading") : t("tasks.uploadFile")}
      </button>
      {attachments.length === 0 ? (
        <p className="muted">{t("tasks.noAttachments")}</p>
      ) : (
        <div className="hk-att-list">
          {attachments.map((a) => (
            <div key={a.id} className="hk-att-row">
              <a
                className="hk-att-name"
                href={taskAttachmentUrl(ctx.backend, a.id, ctx.board)}
                download={a.filename}
                title={a.filename}
              >
                {a.filename}
              </a>
              <span className="muted">{fmtBytes(a.size)}</span>
              <button className="hk-dep-x" title={t("tasks.removeAttachment")} onClick={() => onDelete(a)}>×</button>
            </div>
          ))}
        </div>
      )}
    </ModalSection>
  );
}

// ---------------------------------------------------------------------------
// Home 频道订阅：每个配置了 home 的平台一个开关。没有任何平台配置 home 时整区不渲染
// （官方同款——没设过 /sethome 的用户永远看不到它）。
// ---------------------------------------------------------------------------
export function HomeSubsSection({ ctx }: { ctx: TaskCtx }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [channels, setChannels] = useState<Awaited<ReturnType<typeof getTaskHomeChannels>>>([]);
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    try { setChannels(await getTaskHomeChannels(ctx.backend, ctx.taskId, ctx.board)); }
    catch { setChannels([]); }
  }, [ctx.backend, ctx.taskId, ctx.board]);
  useEffect(() => { load(); }, [load]);

  if (channels.length === 0) return null;

  const toggle = async (platform: string, on: boolean) => {
    setBusy((b) => ({ ...b, [platform]: true }));
    // 乐观翻转 + 失败回滚（双击也保持幂等）。
    setChannels((list) => list.map((c) => (c.platform === platform ? { ...c, subscribed: !on } : c)));
    try {
      await setTaskHomeSubscription(ctx.backend, ctx.taskId, platform, !on, ctx.board);
      await load();
    } catch (e) {
      setChannels((list) => list.map((c) => (c.platform === platform ? { ...c, subscribed: on } : c)));
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy((b) => { const n = { ...b }; delete n[platform]; return n; });
    }
  };

  return (
    <ModalSection title={t("tasks.notifyHomeChannels")}>
      <div className="hk-home-subs">
        {channels.map((c) => (
          <button
            key={c.platform}
            className="ui-toggle"
            aria-pressed={c.subscribed}
            disabled={!!busy[c.platform]}
            title={
              c.subscribed
                ? t("tasks.homeSubOn", { target: `${c.name || ""} (${c.chatId || ""})` })
                : t("tasks.homeSubOff", { target: `${c.name || ""} (${c.chatId || ""})` })
            }
            onClick={() => toggle(c.platform, c.subscribed)}
          >
            {c.subscribed ? `✓ ${c.platform}` : c.platform}
          </button>
        ))}
      </div>
    </ModalSection>
  );
}

// ---------------------------------------------------------------------------
// 每任务模型覆盖。目录（/model-options）模块级缓存一次，多次开抽屉不重复拉。
// 目录为空（清单不可用 / 没有已鉴权 provider）时退化成自由文本输入——官方同款，
// 保证这个能力在任何环境下都可用。
// ---------------------------------------------------------------------------
let modelCatalogCache: TaskModelOptions | null = null;
let modelCatalogPromise: Promise<TaskModelOptions> | null = null;
function fetchModelCatalog(backend: string): Promise<TaskModelOptions> {
  if (modelCatalogCache) return Promise.resolve(modelCatalogCache);
  if (modelCatalogPromise) return modelCatalogPromise;
  modelCatalogPromise = getTaskModelOptions(backend)
    .then((data) => { modelCatalogCache = data; return data; })
    .catch(() => { modelCatalogPromise = null; return { providers: [] }; }); // 允许下次重试
  return modelCatalogPromise;
}
const MODEL_SEP = "\u0000"; // 官方同款编码：provider 与 model 都不可能含 NUL

export function ModelEditor({ ctx, task }: { ctx: TaskCtx; task: UnifiedTaskDetail }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [catalog, setCatalog] = useState<TaskModelOptions | null>(modelCatalogCache);
  const [busy, setBusy] = useState(false);
  const [freeText, setFreeText] = useState("");

  useEffect(() => {
    if (!editing || catalog) return;
    let alive = true;
    fetchModelCatalog(ctx.backend).then((d) => { if (alive) setCatalog(d); });
    return () => { alive = false; };
  }, [editing, catalog, ctx.backend]);

  const current = task.modelOverride
    ? (task.providerOverride ? `${task.providerOverride}: ${task.modelOverride}` : task.modelOverride)
    : t("tasks.modelProfileDefault");
  const currentValue = task.modelOverride
    ? (task.providerOverride ? `${task.providerOverride}${MODEL_SEP}${task.modelOverride}` : task.modelOverride)
    : "";

  const apply = async (patch: Parameters<typeof updateTask>[2]) => {
    setBusy(true);
    try {
      await updateTask(ctx.backend, ctx.taskId, patch, ctx.board);
      await ctx.onChanged();
      setEditing(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!editing) {
    return (
      <DetailRow label={t("tasks.modelLabel")}>
        <button className={`hk-editable${task.modelOverride ? "" : " muted"}`} onClick={() => setEditing(true)} title={t("tasks.modelEditHint")}>
          {current}
        </button>
      </DetailRow>
    );
  }

  const providers = catalog?.providers ?? [];
  if (catalog && providers.length === 0) {
    return (
      <DetailRow label={t("tasks.modelLabel")}>
        <span className="hk-reassign">
          <TextInput
            autoFocus
            value={freeText}
            disabled={busy}
            placeholder={t("tasks.modelFreeTextPlaceholder")}
            onChange={(e) => setFreeText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const v = freeText.trim();
                apply(v ? { modelOverride: v } : { clearModelOverride: true });
              }
              if (e.key === "Escape") setEditing(false);
            }}
          />
          <button className="btn-sm" onClick={() => setEditing(false)}>{t("common.cancel")}</button>
        </span>
      </DetailRow>
    );
  }

  // 目录里没有的当前覆盖（比如 CLI 设过的模型）也要能选中，否则一打开就被改掉。
  const inCatalog =
    currentValue === "" ||
    providers.some((p) => p.models.some((m) => `${p.slug}${MODEL_SEP}${m}` === currentValue || m === currentValue));

  return (
    <DetailRow label={t("tasks.modelLabel")}>
      {!catalog ? (
        <span className="muted">{t("tasks.modelLoading")}</span>
      ) : (
        <select
          className="field-input"
          autoFocus
          disabled={busy}
          value={currentValue}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "") return void apply({ clearModelOverride: true });
            const sep = v.indexOf(MODEL_SEP);
            if (sep === -1) return void apply({ modelOverride: v });
            apply({ providerOverride: v.slice(0, sep), modelOverride: v.slice(sep + 1) });
          }}
          onKeyDown={(e) => { if (e.key === "Escape") setEditing(false); }}
        >
          <option value="">{t("tasks.modelProfileDefaultOption")}</option>
          {!inCatalog && <option value={currentValue}>{current}</option>}
          {providers.map((p) => (
            <optgroup key={p.slug} label={p.label || p.slug}>
              {p.models.map((m) => (
                <option key={`${p.slug}${MODEL_SEP}${m}`} value={`${p.slug}${MODEL_SEP}${m}`}>{m}</option>
              ))}
            </optgroup>
          ))}
        </select>
      )}
    </DetailRow>
  );
}

// ---------------------------------------------------------------------------
// 诊断恢复动作。动作种类由服务端给，未知 kind 渲染成只读行——服务端加新动作时
// UI 不许崩（官方明确设计）。
//   reclaim / reassign(内联 profile 选择器) / unblock / comment(聚焦评论框)
//   / cli_hint(复制命令) / open_docs(新窗口)
// ---------------------------------------------------------------------------
export function DiagnosticCards({
  ctx, task, assignees, onFocusComment,
}: {
  ctx: TaskCtx;
  task: UnifiedTaskDetail;
  assignees: string[];
  onFocusComment: () => void;
}) {
  const { t } = useTranslation();
  const diags = task.diagnostics || [];
  if (!diags.length) return null;
  return (
    <ModalSection title={`${t("tasks.diagnostics")} (${diags.length})`}>
      {diags.map((d, i) => (
        <DiagnosticCard key={`${d.kind}${i}`} ctx={ctx} diag={d} assignees={assignees} taskAssignee={task.assignee} onFocusComment={onFocusComment} />
      ))}
    </ModalSection>
  );
}

function DiagnosticCard({
  ctx, diag, assignees, taskAssignee, onFocusComment,
}: {
  ctx: TaskCtx;
  diag: TaskDiagnostic;
  assignees: string[];
  taskAssignee?: string;
  onFocusComment: () => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [profile, setProfile] = useState(taskAssignee || "");
  const actions = diag.actions || [];
  const hasReassign = actions.some((a) => a.kind === "reassign");

  const run = async (kind: string, payload?: Record<string, unknown>) => {
    setBusy(true);
    setMsg(null);
    try {
      if (kind === "unblock") {
        await updateTask(ctx.backend, ctx.taskId, { status: "ready" }, ctx.board);
        setMsg({ ok: true, text: t("tasks.unblockedMessage", { id: ctx.taskId }) });
      } else if (kind === "reclaim") {
        await reclaimTask(ctx.backend, ctx.taskId, ctx.board);
        setMsg({ ok: true, text: t("tasks.reclaimedMessage", { id: ctx.taskId }) });
      } else if (kind === "reassign") {
        if (!profile) { setMsg({ ok: false, text: t("tasks.pickProfileFirst") }); return; }
        await reassignTask(ctx.backend, ctx.taskId, profile, !!payload?.reclaim_first, ctx.board);
        setMsg({ ok: true, text: t("tasks.reassignedMessage", { id: ctx.taskId, profile }) });
      }
      await ctx.onChanged();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const onAction = (kind: string, label: string, payload?: Record<string, unknown>) => {
    if (kind === "comment") return onFocusComment();
    if (kind === "cli_hint") {
      const cmd = String(payload?.command || label);
      // 剪贴板可能被拒（非安全上下文）；退回到把命令原文放进 msg 让用户自己复制。
      navigator.clipboard?.writeText(cmd).then(
        () => { setCopied(label); setTimeout(() => setCopied(null), 2000); },
        () => setMsg({ ok: true, text: cmd }),
      );
      return;
    }
    void run(kind, payload);
  };

  return (
    <div className={`hk-diag hk-diag--${diag.severity}`}>
      <div className="hk-diag-head">
        <span className={`hk-warn hk-warn--${diag.severity}`}>
          {diag.severity === "critical" ? "!!!" : diag.severity === "error" ? "!!" : "⚠"}
        </span>
        <span className="hk-diag-title">{diag.title || diag.message}</span>
      </div>
      {diag.detail && <div className="hk-diag-detail muted">{diag.detail}</div>}
      {diag.data && Object.keys(diag.data).length > 0 && (
        <div className="hk-diag-data">
          {Object.entries(diag.data).map(([k, v]) => {
            const arr = Array.isArray(v) ? v : null;
            const isIds = !!arr && arr.length > 0 && typeof arr[0] === "string" && String(arr[0]).startsWith("t_");
            return (
              <div key={k} className="hk-diag-data-row">
                <span className="muted">{k}:</span>
                {isIds
                  ? arr!.map((x) => <code key={String(x)} className="hk-id-chip">{String(x)}</code>)
                  : <span>{arr ? arr.join(", ") : String(v)}</span>}
              </div>
            );
          })}
        </div>
      )}
      {hasReassign && (
        <div className="hk-diag-reassign">
          <span className="muted">{t("tasks.reassignTo")}</span>
          <Select value={profile} onChange={setProfile}>
            <Option value="">{t("tasks.unassigned")}</Option>
            {assignees.map((a) => <Option key={a} value={a}>{a}</Option>)}
          </Select>
        </div>
      )}
      <div className="hk-diag-actions">
        {actions.map((a, i) => {
          const label = `${a.suggested ? "☆ " : ""}${a.label}`;
          if (a.kind === "open_docs") {
            return (
              <a key={i} className="btn-sm" href={String(a.payload?.url || "#")} target="_blank" rel="noreferrer">{label}</a>
            );
          }
          const known = ["reclaim", "reassign", "unblock", "comment", "cli_hint"].includes(a.kind);
          if (!known) return <span key={i} className="btn-sm hk-diag-unknown">{label}</span>;
          return (
            <button
              key={i}
              className="btn-sm"
              disabled={busy || (a.kind === "reassign" && !profile)}
              onClick={() => onAction(a.kind, a.label, a.payload)}
            >
              {a.kind === "cli_hint" && copied === a.label ? t("tasks.copied") : label}
            </button>
          );
        })}
      </div>
      {msg && <div className={msg.ok ? "hk-msg-ok" : "hk-msg-err"}>{msg.text}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 板设置：显示名 / 描述 / 项目目录（新任务工作区默认值继承它）。
// 项目目录无条件提交——""=清除，路径由服务端校验（绝对路径 + 目录存在）。
// ---------------------------------------------------------------------------
export function BoardSettingsDialog({
  open, backend, board, onClose, onSaved,
}: {
  open: boolean;
  backend: string;
  board: KanbanBoard | null;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [draft, setDraft] = useState({ name: "", description: "", defaultWorkdir: "" });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDraft({
      name: board?.name || "",
      description: board?.description || "",
      defaultWorkdir: board?.defaultWorkdir || "",
    });
  }, [open, board]);

  const save = async () => {
    if (!board?.slug) return;
    setSaving(true);
    try {
      await updateBoard(backend, board.slug, {
        name: draft.name.trim() || undefined,
        description: draft.description.trim() || undefined,
        defaultWorkdir: draft.defaultWorkdir.trim(),
      });
      toast.success(t("tasks.boardSettingsSaved"));
      await onSaved();
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("tasks.boardSettingsTitle", { name: board?.name || board?.slug || "" })}
      footer={
        <button className="btn-primary" onClick={save} disabled={saving}>
          {saving ? t("common.saving") : t("common.save")}
        </button>
      }
    >
      <Field label={t("tasks.boardNameField")}>
        <TextInput value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
      </Field>
      <Field label={t("tasks.boardDescField")}>
        <TextInput value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
      </Field>
      <Field label={t("tasks.projectDirectory")} hint={t("tasks.projectDirectoryOverrideHint")}>
        <TextInput
          value={draft.defaultWorkdir}
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          placeholder={t("tasks.projectDirectoryPlaceholder")}
          onChange={(e) => setDraft({ ...draft, defaultWorkdir: e.target.value })}
        />
      </Field>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Profile 描述编辑：描述指导分解器把子任务路由给谁。⚗ 自动生成走 auxiliary LLM，
// 非 OK 不是 HTTP 错误（官方把 reason 内联展示，我们用 info toast 同义）。
// ---------------------------------------------------------------------------
export function ProfileDescriptions({ backend }: { backend: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [profiles, setProfiles] = useState<BoardProfile[]>([]);
  const [busy, setBusy] = useState<Record<string, "save" | "auto">>({});

  const load = useCallback(async () => {
    try { setProfiles(await getBoardProfiles(backend)); } catch { setProfiles([]); }
  }, [backend]);
  useEffect(() => { load(); }, [load]);

  const save = async (name: string, description: string) => {
    setBusy((b) => ({ ...b, [name]: "save" }));
    try {
      await updateBoardProfile(backend, name, description);
      await load();
      toast.success(t("tasks.profileDescSaved", { name }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy((b) => { const n = { ...b }; delete n[name]; return n; });
    }
  };

  const auto = async (name: string) => {
    setBusy((b) => ({ ...b, [name]: "auto" }));
    try {
      const r = await describeBoardProfileAuto(backend, name, true);
      if (r.ok) { await load(); toast.success(t("tasks.profileDescAuto", { name })); }
      else toast.info(r.reason || t("tasks.profileDescAutoFailed"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy((b) => { const n = { ...b }; delete n[name]; return n; });
    }
  };

  if (profiles.length === 0) return null;
  return (
    <div className="hk-profiles">
      <div className="hk-profiles-head">
        <span>{t("tasks.profileDescriptions")}</span>
        <span className="field-hint">{t("tasks.profileDescriptionsHint")}</span>
      </div>
      {profiles.map((p) => (
        <ProfileRow key={p.name} profile={p} busy={busy[p.name]} onSave={save} onAuto={auto} />
      ))}
    </div>
  );
}

function ProfileRow({
  profile, busy, onSave, onAuto,
}: {
  profile: BoardProfile;
  busy?: "save" | "auto";
  onSave: (name: string, description: string) => void;
  onAuto: (name: string) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(profile.description || "");
  // 服务端描述变了（比如刚自动生成完）要把本地草稿同步过来。
  useEffect(() => { setDraft(profile.description || ""); }, [profile.description]);
  return (
    <div className="hk-profile-row">
      <div className="hk-profile-name">
        <span>{profile.name}</span>
        {profile.isDefault && <span className="muted">({t("tasks.profileDefault")})</span>}
        {profile.descriptionAuto && profile.description && <span className="hk-warn hk-warn--warning">{t("tasks.profileAutoReview")}</span>}
        {!profile.description && <span className="hk-warn hk-warn--warning">{t("tasks.profileNoDesc")}</span>}
      </div>
      <div className="hk-profile-edit">
        <TextInput value={draft} placeholder={t("tasks.profileDescPlaceholder")} onChange={(e) => setDraft(e.target.value)} />
        <button className="btn-sm" disabled={!!busy || draft === (profile.description || "")} onClick={() => onSave(profile.name, draft)}>
          {busy === "save" ? t("common.saving") : t("common.save")}
        </button>
        <button className="btn-sm" disabled={!!busy} onClick={() => onAuto(profile.name)} title={t("tasks.profileAutoHint")}>
          {busy === "auto" ? t("tasks.profileAutoBusy") : t("tasks.profileAutoBtn")}
        </button>
      </div>
    </div>
  );
}
