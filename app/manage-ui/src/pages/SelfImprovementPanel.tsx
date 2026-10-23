import { useCallback, useEffect, useRef, useState } from "react";
import { selfImprovement } from "../api/client";
import { Field, Option, Select, Switch, TextArea, TextInput } from "../components/Field";
import { useConfirm, useToast } from "../components/ui";
import type { LearnedSkill, LearnedSkillDetail, LearningConfig, LearningJob, LearningMode,
  LearningPage, LearningProposal, LearningStatus } from "../types";
import styles from "./SelfImprovementPanel.module.css";

const states: Record<string, string> = { queued: "等待闲置", reviewing: "正在复盘", validating: "检查提案",
  applied: "已保存", pending_review: "待审核", noop: "无需更新", failed: "复盘失败", canceled: "已取消",
  interrupted: "已中断", outcome_unknown: "调用结果未知", rejected: "已拒绝", withdrawn: "来源已撤回",
  insufficient_evidence: "缺少可复用方法的验证证据", awaiting_completion: "等待当前任务完成" };
const reasonText: Record<string, string> = { review_required: "按当前策略等待审核", similar_skill_exists: "存在同名技能，请检查重复内容",
  source_unavailable: "原任务来源已不可用", source_withdrawn: "来源已撤回", service_restarted: "服务重启后无法确认原调用结果，未自动重试",
  disabled: "自动学习已关闭", LEARNING_BUDGET: "已达到复盘预算", LEARNING_INPUT_BUDGET: "已达到单次复盘输入预算", MODEL_ONLY_CANCELED: "已为前台任务让出资源",
  LEARNING_OUTPUT_INVALID: "输出格式或证据未通过校验", LEARNING_UNSUPPORTED: "当前模型运行方式暂不支持复盘",
  user_rejected: "用户拒绝了提案", unchanged_content: "方法内容没有变化", user_edit: "用户手动整理了方法正文",
  backup_restored: "恢复备份后已停止旧复盘，需重新开启学习", restore_source_unverified: "恢复备份时无法核对当前来源，已撤回" };
const date = (at: number | null) => at ? new Date(at).toLocaleString() : "尚未使用";
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
function bodyOf(detail: LearnedSkillDetail) {
  return (detail.files.find(file => file.path === "SKILL.md")?.content ?? "")
    .replace(/^---\n[\s\S]*?\n---\n\n# [^\n]*\n\n/u, "").trimEnd();
}

export default function SelfImprovementPanel({ backend, agentId, skillSelection, onSelectionClosed, onSkillsChanged }: {
  backend: string; agentId: string;
  skillSelection?: { id: string; versionHash: string } | null;
  onSelectionClosed?: () => void; onSkillsChanged?: () => void;
}) {
  const [status, setStatus] = useState<LearningStatus | null>(null);
  const [config, setConfig] = useState<LearningConfig | null>(null);
  const [skills, setSkills] = useState<LearningPage<LearnedSkill> | null>(null);
  const [jobs, setJobs] = useState<LearningPage<LearningJob> | null>(null);
  const [tab, setTab] = useState<"skills" | "history" | "settings">("skills");
  const [filter, setFilter] = useState("active");
  const [detail, setDetail] = useState<LearnedSkillDetail | null>(null);
  const [previous, setPrevious] = useState<LearnedSkillDetail | null>(null);
  const [proposal, setProposal] = useState<LearningProposal | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const detailRef = useRef<HTMLElement>(null);
  const alive = useRef(true), epoch = useRef(0), inspectionEpoch = useRef(0);
  const confirm = useConfirm(), toast = useToast();
  const dirty = useRef(false);
  dirty.current = Boolean(config && JSON.stringify(config) !== JSON.stringify(status?.settings?.config));
  const api = useCallback(<T,>(action: Parameters<typeof selfImprovement>[2], input: Record<string, unknown> = {}) =>
    selfImprovement<T>(backend, agentId, action, input), [backend, agentId]);
  const clearInspection = useCallback(() => {
    inspectionEpoch.current += 1;
    setDetail(null); setPrevious(null); setProposal(null); setEditing(null);
  }, []);
  const load = useCallback(async () => {
    clearInspection();
    const revision = ++epoch.current;
    const next = await api<LearningStatus>("status");
    if (!alive.current || revision !== epoch.current) return;
    setStatus(next); setConfig(next.settings?.config ?? null);
    if (!next.supported) return;
    const [skillPage, history] = await Promise.all([api<LearningPage<LearnedSkill>>("skills"), api<LearningPage<LearningJob>>("history")]);
    if (!alive.current || revision !== epoch.current) return;
    setSkills(skillPage); setJobs(history); setError("");
  }, [api, clearInspection]);
  useEffect(() => {
    alive.current = true;
    void load().catch(cause => { if (alive.current) setError(errorText(cause)); });
    return () => { alive.current = false; epoch.current += 1; inspectionEpoch.current += 1; };
  }, [load]);
  useEffect(() => {
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<{ backendId?: string; agentId?: string }>).detail;
      if (detail?.backendId !== backend || detail.agentId !== agentId) return;
      // Source invalidation must also clear previews while settings have unsaved edits.
      clearInspection();
      if (!dirty.current) void load().catch(cause => { if (alive.current) setError(errorText(cause)); });
    };
    window.addEventListener("shoggoth:skills-changed", changed);
    return () => window.removeEventListener("shoggoth:skills-changed", changed);
  }, [agentId, backend, clearInspection, load]);
  const run = async (action: () => Promise<void>) => {
    if (busy) return; setBusy(true); setError("");
    try { await action(); }
    catch (cause) { if (alive.current) { setError(errorText(cause)); toast.error(errorText(cause)); } }
    finally { if (alive.current) setBusy(false); }
  };
  const choose = useCallback(async (skill: Pick<LearnedSkill, "id">, versionHash?: string) => {
    clearInspection();
    const inspection = inspectionEpoch.current;
    const value = await api<LearnedSkillDetail>("read", { skillId: skill.id, ...(versionHash ? { versionHash } : {}) });
    if (!alive.current || inspection !== inspectionEpoch.current) return;
    setDetail(value); setPrevious(null); setProposal(null); setEditing(null);
    if (value.version.baseVersionHash) {
      try { const old = await api<LearnedSkillDetail>("read", { skillId: skill.id, versionHash: value.version.baseVersionHash });
        if (alive.current && inspection === inspectionEpoch.current) setPrevious(old);
      } catch { /* withdrawn ancestors remain unreadable */ }
    }
  }, [api, clearInspection]);
  useEffect(() => {
    if (!skillSelection) { clearInspection(); return; }
    setTab("skills");
    void choose({ id: skillSelection.id }, skillSelection.versionHash).catch(cause => {
      if (alive.current) setError(errorText(cause));
    });
  }, [choose, clearInspection, skillSelection?.id, skillSelection?.versionHash]);
  useEffect(() => {
    if (!detail || detail.skill.id !== skillSelection?.id) return;
    detailRef.current?.scrollIntoView({ block: "nearest" });
    detailRef.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
  }, [detail, skillSelection?.id]);
  const saveSettings = () => run(async () => {
    if (!config || !status?.settings) return;
    const activating = config.mode !== "off" && status.settings.config.mode === "off";
    if (activating && !await confirm({ title: `为 ${status.agentName ?? "当前 Agent"} 开启自动学习`,
      message: `开启后，会将该 Agent 已完成任务中的目标、对话和工具验证摘要发送给下方配置的模型复盘，并产生额外模型用量。${config.mode === "auto" ? "通过检查的纯文本技能会自动保存。" : "所有技能变更先生成提案，等待你审核。"}可随时关闭。`, confirmLabel: "确认开启" })) return;
    await api("configure", { expectedRevision: status.settings.revision, patch: config, ...(activating ? { consent: true } : {}) });
    await load(); toast.success("自动学习设置已保存");
  });
  const change = (action: string, extra: Record<string, unknown> = {}) => run(async () => {
    if (!detail) return;
    await api("change", { skillId: detail.skill.id, expectedRevision: detail.skill.revision, action, ...extra });
    setDetail(null); setPrevious(null); setEditing(null); await load(); onSkillsChanged?.();
  });
  const resolve = (action: "accept" | "reject") => run(async () => {
    if (!proposal) return;
    await api("resolve", { jobId: proposal.id, expectedRevision: proposal.revision, action });
    setProposal(null); await load(); onSkillsChanged?.();
  });
  if (status?.supported === false) return null;
  const visibleSkills = skills?.items.filter(skill => filter === "all" || (filter === "archived" ? skill.archived : !skill.archived));
  return <section className={styles.panel} aria-label="自动学习">
    <div className={styles.head}>
      <div><h2>自动学习 <span className={styles.preview}>预览</span></h2>
        <p>从已验证的任务中积累方法，供当前 Agent 按需读取。</p></div>
      <span className={styles.badge}>{status?.running ? "正在复盘" : status?.settings?.config.mode === "auto" ? "自动保存"
        : status?.settings?.config.mode === "review" ? "仅生成建议" : "已关闭"}</span>
      <button className="btn-secondary" disabled={busy} onClick={() => void run(async () => {
        await load(); onSkillsChanged?.();
      })}>刷新</button>
    </div>
    {error && <p className="error" role="alert">{error}</p>}
    {!status && !error && <p className="muted">正在读取自动学习状态…</p>}
    {status?.supported && <>
      <nav className={styles.tabs} aria-label="自动学习视图">
        {([ ["skills", "学到的技能"], ["history", "复盘历史"], ["settings", "学习设置"] ] as const).map(([id, label]) =>
          <button key={id} type="button" aria-current={tab === id ? "page" : undefined} onClick={() => setTab(id)}>{label}</button>)}
      </nav>
      {tab === "settings" && config && <div className={styles.settings}>
        <p className={styles.note}>首次使用需确认开启。后台模型默认跟随此 Agent 的默认 Provider 和模型；临时切换的聊天模型不会改变复盘模型。</p>
        <Field label="学习模式"><Select value={config.mode} disabled={busy} onChange={value => setConfig({ ...config, mode: value as LearningMode })}>
          <Option value="off">关闭</Option><Option value="review">仅生成建议，审核后保存</Option><Option value="auto">自动保存受管理技能</Option>
        </Select></Field>
        <Field label="后台模型" hint={`留空跟随 Agent 默认模型。当前：${status.capability?.model ?? (status.capability?.supported ? "Runtime 默认模型" : "暂不可用")}（${status.capability?.runtime ?? "未绑定"}）`}>
          <TextInput value={config.model ?? ""} placeholder="跟随 Agent 默认模型" disabled={busy}
            onChange={event => setConfig({ ...config, model: event.target.value.trim() || null })} /></Field>
        <Field label="单次复盘输入预算" hint="留空自动取模型上下文的 75%，最多 600,000 tokens；上下文未知时用 120,000。填 0 或负数表示不限输入预算。">
          <TextInput type="number" step={1} disabled={busy} value={config.maxInputTokens ?? ""} placeholder="自动"
            onChange={event => setConfig({ ...config, maxInputTokens: event.target.value === "" ? null : Number(event.target.value) })} />
        </Field>
        <p className="muted">单次最多 {status.capability?.maxIterations ?? 16} 轮；当前输入预算{status.capability?.maxInputTokens == null
          ? "不限" : ` ${status.capability.maxInputTokens.toLocaleString()} tokens`}。不设每日配额或固定冷却时间。</p>
        <Field label="闲置时整理" hint="固定、用户管理、正在使用或存在持续任务依赖的技能会受到保护。">
          <Switch checked={config.curationEnabled} disabled={busy} onChange={value => setConfig({ ...config, curationEnabled: value })} />
        </Field>
        {!status.capability?.supported && <p role="status" className={styles.note}>当前运行方式暂不能复盘：{status.capability?.reason ?? "模型绑定不可用"}</p>}
        <p className="muted">今日复盘 {status.budget?.runs ?? 0} 次 · 记录用量 {status.budget?.tokens.toLocaleString() ?? "0"} tokens
          {Boolean(status.budget?.unknownCalls) && ` · ${status.budget?.unknownCalls} 次用量未知，包含估算值`}</p>
        <div className={styles.actions}><button className="btn-primary" disabled={busy} onClick={saveSettings}>保存设置</button>
          <button className="btn-secondary" disabled={busy || status.settings?.config.mode === "off" || !status.latestRunId || !status.capability?.supported}
            onClick={() => void run(async () => { const result = await api<{ queued: boolean; state: string }>("request", { runId: status.latestRunId });
              await load(); toast.success(result.queued ? "已提交，等待 Agent 闲置后复盘" : `该任务已处理：${states[result.state] ?? result.state}`); })}>复盘最近完成任务</button></div>
      </div>}
      {tab === "skills" && <>
        {status.curation?.map(item => <p className={styles.note} key={item.skillIds.join(":")}>
          整理建议：{item.title} — {item.reason}</p>)}
        <div className={styles.toolbar}><Select value={filter} onChange={setFilter}>
          <Option value="active">当前可用</Option><Option value="archived">已归档</Option><Option value="all">全部自动学习技能</Option></Select>
          <span className="muted">已加载 {skills?.items.length ?? 0} 条</span></div>
        {!visibleSkills?.length && <p className={styles.empty}>{status.settings?.config.mode === "off" ? "尚未开启自动学习。可在学习设置中启用，已有技能仍保留。" : "还没有可显示的技能。只有形成经过工具验证的方法，复盘才会提出更新。"}</p>}
        <div className={styles.list}>{visibleSkills?.map(skill => <button key={skill.id} className={styles.item}
          disabled={busy || skill.revoked} onClick={() => void run(() => choose(skill))}>
          <strong>{skill.revoked ? "来源已撤回" : skill.title}</strong><span>{skill.description}</span>
          <small>{skill.owner === "user" ? "用户管理" : "自动维护"}{skill.pinned ? " · 已固定" : ""}{skill.archived ? " · 已归档" : ""}
            {skill.observation === "unused_14_days" ? " · 14 天未使用，待观察" : ""}
            {` · ${skill.usage?.reads ?? 0} 个任务读取 · ${date(skill.updatedAt)}`}</small></button>)}</div>
        {skills?.nextCursor && <button className="btn-secondary" disabled={busy} onClick={() => void run(async () => {
          const next = await api<LearningPage<LearnedSkill>>("skills", { cursor: skills.nextCursor });
          if (alive.current) setSkills({ ...next, items: [...skills.items, ...next.items] }); })}>加载更多技能</button>}
      </>}
      {tab === "history" && <>
        {!jobs?.items.length && <p className={styles.empty}>尚无复盘记录。简单问答和未完成验证的任务不会自动生成技能。</p>}
        <div className={styles.list}>{jobs?.items.map(job => <article className={styles.history} key={job.id}>
          <div className={styles.head}><strong>{job.proposal?.title ?? states[job.state] ?? job.state}</strong>
            <span className={styles.badge}>{states[job.state] ?? job.state}</span><small>{date(job.createdAt)}</small></div>
          <p>{reasonText[job.reason ?? ""] ?? job.reason ?? job.proposal?.reason ?? "已根据任务验证结果处理"}</p>
          <small>{job.sourceCount} 条来源证据{job.calls.map(call => ` · 调用 ${call.attempt}：${call.model ?? "未知模型"}，${call.usage
            ? `${call.usage.inputTokens + call.usage.outputTokens} 实际 tokens` : `用量未知，估算 ${call.reservedTokens} tokens`}`).join("")}</small>
          {job.state === "pending_review" && <button className="btn-secondary" disabled={busy} onClick={() => void run(async () => {
            clearInspection();
            const inspection = inspectionEpoch.current;
            const value = await api<LearningProposal>("proposal", { jobId: job.id });
            if (!alive.current || inspection !== inspectionEpoch.current) return;
            setProposal(value);
            if (value.proposal.action === "patch") {
              const base = await api<LearnedSkillDetail>("read", { skillId: value.proposal.skillId, versionHash: value.proposal.baseVersionHash });
              if (alive.current && inspection === inspectionEpoch.current) setPrevious(base);
            }
          })}>查看提案</button>}
        </article>)}</div>
        {jobs?.nextCursor && <button className="btn-secondary" disabled={busy} onClick={() => void run(async () => {
          const next = await api<LearningPage<LearningJob>>("history", { cursor: jobs.nextCursor });
          if (alive.current) setJobs({ ...next, items: [...jobs.items, ...next.items] }); })}>加载更多历史</button>}
      </>}
      {proposal && <article className={styles.detail} aria-label="学习提案详情"><h3>{proposal.proposal.title}</h3>
        <p>{proposal.proposal.reason}</p><p className="muted">{proposal.sourceCount} 条证据 · {proposal.proposal.action === "patch" ? "修改现有技能" : "创建技能"}</p>
        <div className={styles.diff}>{previous && <div><h4>当前版本</h4><pre>{bodyOf(previous)}</pre></div>}
          <div><h4>建议内容</h4><pre>{proposal.proposal.body}</pre></div></div>{proposal.proposal.references.map(file => <details key={file.path}><summary>{file.path}</summary><pre>{file.content}</pre></details>)}
        <div className={styles.actions}><button className="btn-primary" disabled={busy} onClick={() => resolve("accept")}>接受并保存</button>
          <button className="btn-secondary" disabled={busy} onClick={() => resolve("reject")}>拒绝提案</button>
          <button className="btn-secondary" onClick={clearInspection}>关闭</button></div></article>}
      {detail && <article className={styles.detail} ref={detailRef} aria-label="学习技能详情"><div className={styles.head}><h3>{detail.version.title}</h3>
        <button className="btn-secondary" disabled={busy} onClick={() => {
          clearInspection(); onSelectionClosed?.();
        }}>关闭详情</button></div>
        <p>{reasonText[detail.version.reason] ?? detail.version.reason}</p><small>版本 {detail.version.hash.slice(0, 12)} · {detail.usage.reads} 个任务读取 · {detail.version.sourceTaskCount} 个来源任务 / {detail.version.sourceEventCount} 条证据</small>
        <p className="muted">进入候选 {detail.usage.exposures} 次 · 显式选择 {detail.usage.selections} 次 · 含纠正信号的任务 {detail.usage.correctionSignals} 个。
          使用与任务结果只表示关联，不代表技能导致成功或失败。</p>
        {editing !== null ? <Field label="编辑方法正文" hint="保存后转为用户管理，后台不再自动覆盖。"><TextArea rows={12} value={editing}
          onChange={event => setEditing(event.target.value)} disabled={busy} /></Field> : <div className={styles.diff}>
          {previous && <div><h4>上一版本</h4><pre>{bodyOf(previous)}</pre></div>}<div><h4>{previous ? "当前查看的版本" : "方法正文"}</h4><pre>{bodyOf(detail)}</pre></div></div>}
        {detail.files.filter(file => file.path !== "SKILL.md").map(file => <details key={file.path}><summary>{file.path}</summary><pre>{file.content}</pre></details>)}
        <details><summary>来源任务{detail.version.sourceTaskCount > detail.version.sources.length ? `（显示前 ${detail.version.sources.length} 个）` : ""}</summary>
          <ul>{detail.version.sources.map(source => <li key={source.runId}><code>{source.runId}</code></li>)}</ul></details>
        <div className={styles.actions}>{editing !== null ? <><button className="btn-primary" disabled={busy || !editing.trim()} onClick={() => change("edit", { body: editing })}>保存并转为用户管理</button>
          <button className="btn-secondary" disabled={busy} onClick={() => setEditing(null)}>取消编辑</button></> : <>
          <button className="btn-secondary" disabled={busy} onClick={() => change(detail.skill.pinned ? "unpin" : "pin")}>{detail.skill.pinned ? "取消固定" : "固定技能"}</button>
          <button className="btn-secondary" disabled={busy} onClick={() => change(detail.skill.archived ? "restore" : "archive")}>{detail.skill.archived ? "恢复技能" : "归档技能"}</button>
          {detail.skill.owner === "managed" && <button className="btn-secondary" disabled={busy} onClick={() => change("adopt")}>转为用户管理</button>}
          <button className="btn-secondary" disabled={busy || detail.version.hash !== detail.skill.head} onClick={() => setEditing(bodyOf(detail))}>编辑正文</button>
          {detail.version.hash !== detail.skill.head && <button className="btn-primary" disabled={busy} onClick={() => change("revert", { versionHash: detail.version.hash })}>恢复为此版本</button>}
        </>}</div>
        <details><summary>最近 10 个版本</summary><div className={styles.list}>{detail.history.map(version => <button key={version.hash} className={styles.item}
          disabled={busy || version.revoked} onClick={() => void run(() => choose(detail.skill, version.hash))}>
          <span>{version.hash.slice(0, 12)} · {date(version.createdAt)}{version.revoked ? " · 已撤回" : ""}</span><small>{reasonText[version.reason] ?? version.reason}</small></button>)}</div></details>
        <details><summary>变更记录</summary><ul>{detail.changes.map(change => <li key={change.id}>
          {date(change.createdAt)} · {({ create: "创建", patch: "更新", pin: "固定", unpin: "取消固定", archive: "归档", restore: "恢复", adopt: "转为用户管理", edit: "编辑", revert: "恢复旧版本", withdraw: "来源撤回" } as Record<string, string>)[change.action] ?? change.action}
          {` · ${change.actor === "user" ? "用户操作" : change.actor === "curator" ? "闲置整理" : "自动学习"}`}</li>)}</ul></details>
      </article>}
    </>}
  </section>;
}
