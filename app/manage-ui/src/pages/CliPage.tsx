import AgentAvatarView from "../components/AgentAvatar";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CliTool, CliInfo } from "../types";
import { getClis, getCliInfo, getCliUsage } from "../api/client";
import { usePageCache } from "../lib/usePageCache";
import { useRegisterPageRefresh, useRegisterPageLoading } from "../lib/page-refresh";
import { useStickyState } from "../lib/useStickyState";
import { PageHead } from "../components/PageHead";

type InfoState = { loading: boolean; error: string | null; data: CliInfo | null };

// /__api/cli 冷扫描 ~12s、/__api/cli/usage 冷扫描 ~30s（服务端 60s TTL 一过就冷），
// 切页体验全靠 usePageCache 的 stale-while-revalidate 撑住（R104 手写，R105 归一到共享 hook）。
const EMPTY_USAGE = {
  usage: new Map<string, number>(),
  usageByAgent: new Map<string, Map<string, number>>(),
  usageSupported: false,
};

function isSystemPath(p: string) {
  return p.startsWith('/bin/') || p.startsWith('/usr/bin/') || p.startsWith('/sbin/') || p.startsWith('/usr/sbin/');
}
// Did the user (or a tool they installed) put this here on purpose? Prefer the
// backend's provenance flag; fall back to "not in a system dir" for old payloads.
function isUserInstalled(t: CliTool) {
  return t.userInstalled !== undefined ? t.userInstalled : !isSystemPath(t.path);
}

// Small terminal glyph shown before a tool path (matches the Figma card/drawer).
function PathIcon() {
  return (
    <svg className="cli-path-icon" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
      <path d="M2 3.2 4.4 6 2 8.8M6 9h4" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function CliPage() {
  const { t } = useTranslation();
  const [q, setQ] = useStickyState("cli.query", "");
  const [selectedTool, setSelectedTool] = useState<CliTool | null>(null);
  const [infoByPath, setInfoByPath] = useState<Record<string, InfoState>>({});
  const [copied, setCopied] = useState<string | null>(null);
  const requested = useRef<Set<string>>(new Set());

  const { data: toolsData, loading, error, refresh } = usePageCache("cli:tools", async () => (await getClis()).tools);
  const tools = toolsData ?? [];

  // Overlay: which of these CLIs have agents actually invoked, AND which agent.
  // Merge across all `supported` backends into command→total (for cards/coverage/
  // sort) AND command→agent→count (for the drawer's per-agent breakdown).
  // 失败静默（overlay 可有可无）——hook 的 error 不接即等价旧版 catch(() => {})。
  const { data: usageData, refresh: refreshUsage } = usePageCache("cli:usage", async () => {
    const backends = await getCliUsage();
    const merged = new Map<string, number>();
    const byAgent = new Map<string, Map<string, number>>();
    let supported = false;
    for (const b of backends) {
      if (!b.supported) continue;
      supported = true;
      for (const [cmd, agents] of Object.entries(b.commands || {})) {
        let agentMap = byAgent.get(cmd);
        if (!agentMap) { agentMap = new Map(); byAgent.set(cmd, agentMap); }
        let total = merged.get(cmd) || 0;
        for (const [agentId, n] of Object.entries(agents || {})) {
          agentMap.set(agentId, (agentMap.get(agentId) || 0) + n);
          total += n;
        }
        merged.set(cmd, total);
      }
    }
    return { usage: merged, usageByAgent: byAgent, usageSupported: supported };
  });
  const { usage, usageByAgent, usageSupported } = usageData ?? EMPTY_USAGE;
  const usageLoaded = usageData != null;
  // 导航栏刷新要连「命令使用次数」叠加层一起重拉——那一列正是用户盯着看变化的地方，
  // 只刷 cli:tools 会让整页看起来毫无反应（R371）。
  useRegisterPageRefresh("/cli", () => Promise.all([refresh(), refreshUsage()]));
  // 只报主列表的加载态：usage 叠加层冷扫描要 ~30s，把它算进来图标会一直转下去。
  useRegisterPageLoading("/cli", loading);

  // Lazy-load reference info when a tool's drawer opens, once per path. Dedupe
  // via a ref (synchronous + not reactive) so infoByPath stays out of the effect
  // deps — depending on it would retrigger the effect when we set loading:true,
  // fire this run's cleanup (alive=false), and drop the in-flight response.
  useEffect(() => {
    if (!selectedTool) return;
    const { path, name } = selectedTool;
    if (requested.current.has(path)) return; // already fetched or in-flight
    requested.current.add(path);
    let alive = true;
    setInfoByPath((m) => ({ ...m, [path]: { loading: true, error: null, data: null } }));
    getCliInfo(name, path)
      .then((data) => {
        if (alive) setInfoByPath((m) => ({ ...m, [path]: { loading: false, error: null, data } }));
      })
      .catch((e) => {
        if (!alive) return;
        const msg = e instanceof Error ? e.message : String(e);
        setInfoByPath((m) => ({ ...m, [path]: { loading: false, error: msg, data: null } }));
      });
    return () => {
      alive = false;
    };
  }, [selectedTool]);

  // Only ever show what the user actually installed — OS built-ins, Homebrew
  // dependencies and version-manager shims are filtered out entirely.
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const res = tools.filter(isUserInstalled);
    return needle ? res.filter((t) => t.name.toLowerCase().includes(needle)) : res;
  }, [tools, q]);

  // Flat list — no category grouping, always sorted by agent-usage count (desc,
  // then name). Before usage loads all counts are 0, so this falls back to
  // alphabetical until the overlay arrives.
  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      const d = (usage.get(b.name) || 0) - (usage.get(a.name) || 0);
      if (d) return d;
      return a.name.localeCompare(b.name);
    });
  }, [filtered, usage]);

  function copy(text: string) {
    navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(text);
        window.setTimeout(() => setCopied((c) => (c === text ? null : c)), 1200);
      })
      .catch(() => {});
  }

  // Coverage is measured against user-installed tools only — the 2168 $PATH total
  // is mostly OS built-ins + Homebrew deps, so counting them makes coverage meaningless.
  const installed = useMemo(() => tools.filter(isUserInstalled), [tools]);
  const usedTotal = useMemo(
    () => installed.reduce((n, tool) => ((usage.get(tool.name) || 0) > 0 ? n + 1 : n), 0),
    [installed, usage],
  );
  const coverage = installed.length ? Math.round((usedTotal / installed.length) * 100) : 0;

  const selInfo = selectedTool ? infoByPath[selectedTool.path] : undefined;

  const subtitle = loading
    ? t("cli.scanning")
    : usageSupported
      ? t("cli.coverageSummary", { total: installed.length, used: usedTotal, pct: coverage })
      : t("cli.commandCount", { count: filtered.length, total: installed.length });

  return (
    <div className="page cli-page">
      <PageHead
        title="CLI"
        subtitle={subtitle}
        actions={
          <div className="cli-search">
            <span className="cli-search-icon" aria-hidden>⌕</span>
            <input placeholder={t("cli.searchPlaceholder")} value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
        }
      />

      <div className="cli-body">
        <div className="cli-main-content">
          {error && <div className="error">{t("cli.errorPrefix", { error })}</div>}
          {!loading && !error && tools.length === 0 && <p className="muted">{t("cli.emptyPath")}</p>}
          {!loading && !error && tools.length > 0 && sorted.length === 0 && <p className="muted">{t("cli.noMatch")}</p>}

          {!loading && (
            <div className="cli-grid">
              {sorted.map((tool) => {
                const used = usage.get(tool.name) || 0;
                const selected = selectedTool?.path === tool.path;
                return (
                  <div
                    key={tool.path}
                    role="button"
                    tabIndex={0}
                    className={`cli-card${selected ? ' cli-card-selected' : ''}${usageSupported && used === 0 ? ' cli-card-unused' : ''}`}
                    title={tool.path}
                    onClick={() => setSelectedTool(tool)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedTool(tool); } }}
                  >
                    <div className="cli-card-top">
                      <span className="cli-card-name">{tool.name}</span>
                      {usageSupported && (used > 0
                        ? <span className="cli-badge cli-badge-used">{t("cli.usedTimes", { count: used })}</span>
                        : <span className="cli-badge cli-badge-never">{t("cli.neverUsed")}</span>)}
                    </div>
                    <span className="cli-card-path"><PathIcon /><span className="cli-card-path-text">{tool.path}</span></span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {selectedTool && (
          <aside className="cli-drawer">
            <div className="cli-drawer-head">
              <button className="cli-drawer-x" onClick={() => setSelectedTool(null)} aria-label={t("common.close")}>✕</button>
              <h3 className="cli-drawer-name">{selectedTool.name}</h3>
              <div className="cli-drawer-version">
                {selInfo?.loading ? t("cli.versionResolving") : selInfo?.data?.version || t("cli.versionUnknown")}
              </div>
              <div className="cli-drawer-path"><PathIcon />{selectedTool.path}</div>
            </div>

            <section className="cli-sec">
              <h4>{t("cli.summaryHeading")}</h4>
              <p className="cli-sec-desc">
                {selInfo?.loading
                  ? t("common.loading")
                  : selInfo?.error
                    ? t("cli.summaryError", { error: selInfo.error })
                    : selInfo?.data?.summary
                      || (isSystemPath(selectedTool.path) ? t("cli.summarySystemNone") : t("cli.summaryNone"))}
              </p>
            </section>

            {!usageLoaded ? (
              <section className="cli-sec">
                <div className="cli-sec-head"><h4>{t("cli.usageHeading")}</h4></div>
                <p className="cli-sec-desc">{t("common.loading")}</p>
              </section>
            ) : usageSupported ? (() => {
              const agents = usageByAgent.get(selectedTool.name);
              const rows = agents ? [...agents.entries()].sort((a, b) => b[1] - a[1]) : [];
              const total = rows.reduce((n, [, c]) => n + c, 0);
              const max = rows.length ? rows[0][1] : 0;
              return (
                <section className="cli-sec">
                  <div className="cli-sec-head">
                    <h4>{t("cli.usageHeading")}</h4>
                    {total > 0 && <span className="cli-sec-aside">{t("cli.usageTotal", { count: total })}</span>}
                  </div>
                  {rows.length === 0 ? (
                    <p className="cli-sec-desc">{t("cli.usageNeverLocal")}</p>
                  ) : (
                    <ul className="cli-usage-list">
                      {rows.map(([agentId, count]) => (
                        <li key={agentId} className="cli-u-row">
                          <AgentAvatarView agentId={agentId} className="cli-u-avatar" />
                          <span className="cli-u-label" title={agentId}>{agentId} · {count}x</span>
                          <span className="cli-u-bar"><span style={{ width: `${max ? Math.round((count / max) * 100) : 0}%` }} /></span>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              );
            })() : null}

            <section className="cli-sec">
              <h4>{t("cli.helpHeading")}</h4>
              {selInfo?.loading ? (
                <p className="cli-sec-desc">{t("common.loading")}</p>
              ) : selInfo?.data?.help ? (
                <pre className="cli-help-block">{selInfo.data.help}</pre>
              ) : (
                <p className="cli-sec-desc">{t("cli.helpNone")}</p>
              )}
            </section>

            <section className="cli-sec cli-drawer-actions">
              <button onClick={() => copy(selectedTool.name)}>
                {copied === selectedTool.name ? t("cli.copied") : t("cli.copyCommand")}
              </button>
              <button onClick={() => copy(selectedTool.path)}>
                {copied === selectedTool.path ? t("cli.copied") : t("cli.copyPath")}
              </button>
            </section>
          </aside>
        )}
      </div>
    </div>
  );
}
