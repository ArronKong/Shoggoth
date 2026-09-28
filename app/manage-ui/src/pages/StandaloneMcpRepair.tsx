import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Field, TextArea, TextInput } from "../components/Field";
import { useConfirm, useToast } from "../components/ui";
import { activateStandaloneMcp, ApiError, listDisabledStandaloneMcp,
  rebindStandaloneMcp } from "../api/client";
import type { DisabledStandaloneMcpPage, StandaloneMcpRebindResult } from "../types";

// Only disabled Native MCP registrations appear here. A restored command may
// point to another machine, so the browser never receives or reuses its path
// or arguments. The Service alone validates the replacement and probes it.
export default function StandaloneMcpRepair({ agentId }: { agentId: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const confirm = useConfirm();
  const [cursor, setCursor] = useState(0);
  const [reload, setReload] = useState(0);
  const [page, setPage] = useState<DisabledStandaloneMcpPage | null>(null);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [command, setCommand] = useState("");
  const [cwd, setCwd] = useState("");
  const [argsText, setArgsText] = useState("");
  const [pending, setPending] = useState<StandaloneMcpRebindResult | null>(null);
  const [busy, setBusy] = useState<"rebind" | "activate" | null>(null);
  const sectionRef = useRef<HTMLElement>(null);

  useEffect(() => {
    let current = true;
    setError("");
    void listDisabledStandaloneMcp(agentId, cursor).then((value) => {
      if (!current) return;
      setPage(value);
      if (cursor > 0 && !value.items.length) setCursor(0);
    }).catch((cause) => {
      if (current) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => { current = false; };
  }, [agentId, cursor, reload]);
  useEffect(() => {
    if (!pending) return;
    const section = sectionRef.current;
    section?.scrollTo({ top: section.scrollHeight });
    section?.querySelector<HTMLButtonElement>(".standalone-mcp-actions .btn-primary")
      ?.focus({ preventScroll: true });
  }, [pending]);

  const selected = page?.items.find((item) => item.id === selectedId);
  const choose = (id: string) => {
    setSelectedId(id);
    setCommand("");
    setCwd("");
    setArgsText("");
    setPending(null);
  };
  const report = (cause: unknown) => {
    if (cause instanceof ApiError && cause.status === 409) {
      setPending(null);
      setReload((value) => value + 1);
    }
    toast.error(cause instanceof Error ? cause.message : String(cause));
  };
  const rebind = async () => {
    if (!selected || !page || busy) return;
    let args: string[];
    try {
      const parsed: unknown = JSON.parse(argsText);
      if (!Array.isArray(parsed) || parsed.some((arg) => typeof arg !== "string")) {
        throw new Error(t("skills.mcpArgsInvalid"));
      }
      args = parsed;
    } catch (cause) {
      toast.error(cause instanceof SyntaxError ? t("skills.mcpArgsInvalid")
        : cause instanceof Error ? cause.message : String(cause));
      return;
    }
    setBusy("rebind");
    try {
      const result = await rebindStandaloneMcp({ agentId, id: selected.id,
        expectedRevision: page.revision, command: command.trim(), cwd: cwd.trim(), args });
      setPending(result);
      setCommand("");
      setCwd("");
      setArgsText("");
      setReload((value) => value + 1);
      toast.success(t("skills.mcpSavedDisabled"));
    } catch (cause) { report(cause); }
    finally { setBusy(null); }
  };
  const activate = async () => {
    if (!pending || busy || selected?.id !== pending.id) return;
    const accepted = await confirm({ title: t("skills.mcpActivateTitle"),
      message: t("skills.mcpActivateMessage", { name: selected.name }),
      confirmLabel: t("skills.mcpActivate") });
    if (!accepted) return;
    setBusy("activate");
    try {
      const result = await activateStandaloneMcp({ agentId, id: pending.id,
        expectedRevision: pending.revision, activationToken: pending.activationToken });
      setPending(null);
      setSelectedId(null);
      setCursor(0);
      setReload((value) => value + 1);
      toast.success(t("skills.mcpActivated", { count: result.toolCount }));
    } catch (cause) { report(cause); }
    finally { setBusy(null); }
  };

  if (!page && !error) return null;
  if (!error && page?.totalDisabled === 0) return null;
  return (
    <section className="standalone-mcp-repair" ref={sectionRef} aria-label={t("skills.mcpDisabledTitle")}>
      <div className="standalone-mcp-head">
        <div>
          <h2>{t("skills.mcpDisabledTitle")}{page ? ` · ${page.totalDisabled}` : ""}</h2>
          <p>{t("skills.mcpDisabledNote")}</p>
        </div>
        <button className="btn-secondary" type="button" onClick={() => setReload((value) => value + 1)}>
          {t("skills.mcpRefresh")}
        </button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {page && <>
        <div className="standalone-mcp-list">
          {page.items.map((item) => (
            <button className={selectedId === item.id ? "standalone-mcp-item is-selected" : "standalone-mcp-item"}
              type="button" key={item.id} onClick={() => choose(item.id)}>
              <strong>{item.name}</strong>
              <span>{item.commandLabel} · {item.cwdLabel} · {t("skills.mcpArgCount", { count: item.argCount })}</span>
            </button>
          ))}
        </div>
        {(cursor > 0 || page.hasMore) && <nav className="standalone-mcp-pagination" aria-label={t("skills.mcpDisabledTitle")}>
          <button className="btn-secondary" type="button" disabled={cursor === 0} onClick={() => { setSelectedId(null); setPending(null); setCursor(Math.max(0, cursor - 20)); }}>{t("skills.previousPage")}</button>
          <button className="btn-secondary" type="button" disabled={!page.hasMore} onClick={() => { setSelectedId(null); setPending(null); setCursor(page.nextCursor); }}>{t("skills.nextPage")}</button>
        </nav>}
        {selected && <div className="standalone-mcp-editor">
          <h3>{t("skills.mcpRebindTitle", { name: selected.name })}</h3>
          <p>{t("skills.mcpRebindNote")}</p>
          <div className="standalone-mcp-fields">
            <Field label={t("skills.mcpCommand")}>
              <TextInput value={command} onChange={(event) => { setCommand(event.target.value); setPending(null); }}
                placeholder="/Users/…/mcp-server" autoComplete="off" />
            </Field>
            <Field label={t("skills.mcpCwd")}>
              <TextInput value={cwd} onChange={(event) => { setCwd(event.target.value); setPending(null); }}
                placeholder="/Users/…/workspace" autoComplete="off" />
            </Field>
            <Field label={t("skills.mcpArgs")} hint={t("skills.mcpArgsHint")}>
              <TextArea value={argsText} onChange={(event) => { setArgsText(event.target.value); setPending(null); }}
                rows={2} placeholder='[]' autoComplete="off" />
            </Field>
          </div>
          <div className="standalone-mcp-actions">
            <button className="btn-secondary" type="button" onClick={rebind}
              disabled={Boolean(busy) || !command.trim() || !cwd.trim() || !argsText.trim()}>
              {busy === "rebind" ? t("common.saving") : t("skills.mcpSaveDisabled")}
            </button>
            {pending?.id === selected.id && <button className="btn-primary" type="button" onClick={activate}
              disabled={Boolean(busy)}>{busy === "activate" ? t("common.loading") : t("skills.mcpActivate")}</button>}
          </div>
          {pending?.id === selected.id && <p role="status">{t("skills.mcpSavedDisabledNote")}</p>}
        </div>}
      </>}
    </section>
  );
}
